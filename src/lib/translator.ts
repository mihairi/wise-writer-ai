// Format-preserving document translation between English / German / Romanian.
// Strategy:
//  - DOCX & PPTX: unzip with JSZip, find text runs in the XML and translate their
//    inner text only, leaving every formatting tag intact, then re-zip.
//  - TXT / MD / CSV / JSON / HTML / XML: translate the raw text and keep the
//    original extension.
//  - PDF: format-preserving rewrites are not feasible client-side; we export a
//    translated .docx instead.

import JSZip from "jszip";
import { chatComplete, type LLMConfig } from "./llm-service";
import type { ExtractedDoc } from "./document-extract";
import { exportToDocx } from "./docx-export";

export type Language = "English" | "German" | "Romanian";
export const LANGUAGES: Language[] = ["English", "German", "Romanian"];

export interface TranslateProgress {
  done: number;
  total: number;
  stage: string;
}

const BATCH_SIZE = 16;
const DEFAULT_CONCURRENCY = 4;

function buildPrompt(target: Language, source: Language | "auto") {
  const src = source === "auto" ? "auto-detected source language" : source;
  return `You are a professional translator. Translate the following numbered segments from ${src} into ${target}.
Rules:
- Preserve meaning, tone, register and any inline punctuation.
- Do NOT translate proper nouns, code, URLs or numbers.
- Return EXACTLY the same number of segments, in the same order.
- Output format: one segment per line, prefixed with its number and a pipe, like:
  1| translated text
  2| translated text
- Do not add commentary, headings, or blank lines.`;
}

async function translateBatch(
  config: LLMConfig,
  texts: string[],
  target: Language,
  source: Language | "auto",
  signal?: AbortSignal
): Promise<string[]> {
  const numbered = texts.map((t, i) => `${i + 1}| ${t.replace(/\s+/g, " ")}`).join("\n");
  const raw = await chatComplete({
    config,
    messages: [
      { role: "system", content: buildPrompt(target, source) },
      { role: "user", content: numbered },
    ],
    signal,
  });
  // Parse "n| translated text" lines, tolerating extra whitespace.
  const map = new Map<number, string>();
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*\|\s*(.*)$/);
    if (m) map.set(parseInt(m[1], 10), m[2]);
  }
  const out: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    out.push(map.get(i + 1) ?? texts[i]);
  }
  return out;
}

async function translateMany(
  config: LLMConfig,
  texts: string[],
  target: Language,
  source: Language | "auto",
  onProgress?: (p: TranslateProgress) => void,
  signal?: AbortSignal,
  concurrency = DEFAULT_CONCURRENCY
): Promise<string[]> {
  const result: string[] = new Array(texts.length);
  // Skip empty / whitespace-only nodes
  const idxs = texts
    .map((t, i) => ({ t, i }))
    .filter((x) => x.t && x.t.trim().length > 0);
  const total = idxs.length;
  let done = 0;

  // Build batches up-front, then run N batches in parallel against the same endpoint.
  const batchStarts: number[] = [];
  for (let i = 0; i < idxs.length; i += BATCH_SIZE) batchStarts.push(i);
  let next = 0;

  const worker = async () => {
    while (true) {
      if (signal?.aborted) throw new Error("Aborted");
      const k = next++;
      if (k >= batchStarts.length) return;
      const start = batchStarts[k];
      const slice = idxs.slice(start, start + BATCH_SIZE);
      const translated = await translateBatch(
        config,
        slice.map((s) => s.t),
        target,
        source,
        signal
      );
      slice.forEach((s, kk) => {
        result[s.i] = translated[kk];
      });
      done += slice.length;
      onProgress?.({ done, total, stage: `Translating ${done}/${total} segments` });
    }
  };

  const n = Math.max(1, Math.min(concurrency, batchStarts.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));

  // Preserve original whitespace-only nodes
  for (let i = 0; i < texts.length; i++) {
    if (result[i] === undefined) result[i] = texts[i];
  }
  return result;
}

function escapeXml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function translateOoxmlPart(
  xml: string,
  tag: "w:t" | "a:t",
  config: LLMConfig,
  target: Language,
  source: Language | "auto",
  onProgress?: (p: TranslateProgress) => void,
  signal?: AbortSignal
): Promise<string> {
  const re = new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)</${tag}>`, "g");
  const matches = Array.from(xml.matchAll(re));
  const texts = matches.map((m) =>
    m[2]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
  );
  if (!texts.length) return xml;
  const translated = await translateMany(
    config,
    texts,
    target,
    source,
    onProgress,
    signal
  );
  let i = 0;
  return xml.replace(re, (_full, attrs) => {
    const t = translated[i++] ?? "";
    return `<${tag}${attrs}>${escapeXml(t)}</${tag}>`;
  });
}

async function translateDocx(
  bytes: ArrayBuffer,
  config: LLMConfig,
  target: Language,
  source: Language | "auto",
  onProgress?: (p: TranslateProgress) => void,
  signal?: AbortSignal
): Promise<Blob> {
  const zip = await JSZip.loadAsync(bytes);
  const partNames = Object.keys(zip.files).filter((n) =>
    /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(n)
  );
  for (const name of partNames) {
    const xml = await zip.files[name].async("string");
    const updated = await translateOoxmlPart(
      xml,
      "w:t",
      config,
      target,
      source,
      (p) => onProgress?.({ ...p, stage: `${name}: ${p.stage}` }),
      signal
    );
    zip.file(name, updated);
  }
  return await zip.generateAsync({ type: "blob" });
}

async function translatePptx(
  bytes: ArrayBuffer,
  config: LLMConfig,
  target: Language,
  source: Language | "auto",
  onProgress?: (p: TranslateProgress) => void,
  signal?: AbortSignal
): Promise<Blob> {
  const zip = await JSZip.loadAsync(bytes);
  const partNames = Object.keys(zip.files).filter((n) =>
    /^ppt\/(slides|notesSlides)\/(slide|notesSlide)\d+\.xml$/.test(n)
  );
  for (const name of partNames) {
    const xml = await zip.files[name].async("string");
    const updated = await translateOoxmlPart(
      xml,
      "a:t",
      config,
      target,
      source,
      (p) => onProgress?.({ ...p, stage: `${name}: ${p.stage}` }),
      signal
    );
    zip.file(name, updated);
  }
  return await zip.generateAsync({ type: "blob" });
}

async function translatePlainText(
  text: string,
  config: LLMConfig,
  target: Language,
  source: Language | "auto",
  onProgress?: (p: TranslateProgress) => void,
  signal?: AbortSignal
): Promise<string> {
  // Split on blank lines / paragraphs to preserve structure.
  const segments = text.split(/(\r?\n\s*\r?\n)/); // keep separators
  const payload: string[] = [];
  const slots: number[] = [];
  segments.forEach((s, i) => {
    if (i % 2 === 0 && s.trim()) {
      slots.push(i);
      payload.push(s);
    }
  });
  if (!payload.length) return text;
  const translated = await translateMany(config, payload, target, source, onProgress, signal);
  const out = segments.slice();
  slots.forEach((idx, k) => {
    out[idx] = translated[k];
  });
  return out.join("");
}

function changeExt(name: string, ext: string) {
  const i = name.lastIndexOf(".");
  return (i === -1 ? name : name.slice(0, i)) + ext;
}

function langTag(l: Language) {
  return l === "English" ? "en" : l === "German" ? "de" : "ro";
}

export interface TranslateResult {
  blob: Blob;
  filename: string;
  notice?: string;
}

export async function translateDocument(opts: {
  doc: ExtractedDoc;
  config: LLMConfig;
  target: Language;
  source?: Language | "auto";
  onProgress?: (p: TranslateProgress) => void;
  signal?: AbortSignal;
}): Promise<TranslateResult> {
  const { doc, config, target, source = "auto", onProgress, signal } = opts;
  if (!doc.bytes) throw new Error("Original file bytes are unavailable for translation.");
  const lower = doc.name.toLowerCase();
  const tag = langTag(target);
  const baseName = doc.name.replace(/\.[^.]+$/, "");

  if (lower.endsWith(".docx")) {
    const blob = await translateDocx(doc.bytes, config, target, source, onProgress, signal);
    return { blob, filename: `${baseName}.${tag}.docx` };
  }
  if (lower.endsWith(".pptx")) {
    const blob = await translatePptx(doc.bytes, config, target, source, onProgress, signal);
    return { blob, filename: `${baseName}.${tag}.pptx` };
  }
  if (lower.endsWith(".pdf")) {
    // PDF cannot be edited in-place from the browser — export translated text as DOCX.
    const translatedText = await translatePlainText(doc.text, config, target, source, onProgress, signal);
    const filename = `${baseName}.${tag}.docx`;
    await exportToDocx(`${baseName} (${target})`, translatedText, filename);
    return {
      blob: new Blob(),
      filename,
      notice: "PDF formatting cannot be preserved client-side — delivered as a Word document.",
    };
  }
  // Plain text-ish formats: keep extension.
  const decoded =
    doc.text && !doc.text.startsWith("[Failed")
      ? doc.text
      : new TextDecoder().decode(doc.bytes);
  const translated = await translatePlainText(decoded, config, target, source, onProgress, signal);
  const blob = new Blob([translated], { type: "text/plain;charset=utf-8" });
  return { blob, filename: changeExt(doc.name, `.${tag}${lower.match(/\.[a-z0-9]+$/)?.[0] || ".txt"}`) };
}

export function downloadBlob(blob: Blob, filename: string) {
  if (!blob.size) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
