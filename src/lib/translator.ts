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
  const src = source === "auto" ? "the auto-detected source language" : source;
  return `You are a professional human translator producing publication-quality ${target}.
You receive numbered segments (one per line). Some are marked [CONTEXT] — these come
from the surrounding document and are provided ONLY so you understand the topic,
discourse, terminology and tone. DO NOT translate or echo [CONTEXT] lines.
Translate ONLY the segments marked [TRANSLATE].

Translation rules:
- Work at the level of phrases, clauses and full sentences. NEVER translate word-by-word.
- Treat each [TRANSLATE] segment as one coherent sentence/paragraph, not as separate words.
- Read each whole segment together with the surrounding context BEFORE writing,
  then re-express the meaning idiomatically in ${target} as a native speaker would.
- Preserve normal spaces between words; never concatenate adjacent words.
- Preserve meaning, register, tone, terminology consistency and inline punctuation.
- Keep proper nouns, code, URLs, numbers, placeholders and markup tokens unchanged.
- Resolve pronouns, ellipses and ambiguous references using the context.
- Reorder words and restructure clauses when ${target} grammar or idiom requires it;
  prefer natural collocations over literal calques.
- Output EXACTLY one line per [TRANSLATE] segment, in the same order, formatted as:
  N| translated text
- No commentary, no headings, no blank lines, no [CONTEXT] echoes.

Source language: ${src}. Target language: ${target}.`;
}

// Segments of surrounding context (untranslated) included with each batch so the
// model can translate phrases idiomatically rather than in isolation.
const CONTEXT_WINDOW = 3;

async function translateBatch(
  config: LLMConfig,
  texts: string[],
  target: Language,
  source: Language | "auto",
  signal?: AbortSignal,
  contextBefore: string[] = [],
  contextAfter: string[] = [],
): Promise<string[]> {
  const lines: string[] = [];
  contextBefore.forEach((t, i) =>
    lines.push(`C${i - contextBefore.length}| [CONTEXT] ${t.replace(/\s+/g, " ")}`),
  );
  texts.forEach((t, i) => lines.push(`${i + 1}| [TRANSLATE] ${t.replace(/\s+/g, " ")}`));
  contextAfter.forEach((t, i) => lines.push(`C+${i + 1}| [CONTEXT] ${t.replace(/\s+/g, " ")}`));
  const raw = await chatComplete({
    config,
    messages: [
      { role: "system", content: buildPrompt(target, source) },
      { role: "user", content: lines.join("\n") },
    ],
    signal,
  });
  // Parse "n| translated text" lines (positive numbers only — context uses C prefixes).
  const map = new Map<number, string>();
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*\|\s*(.*)$/);
    if (m) map.set(parseInt(m[1], 10), m[2].replace(/^\s*\[(?:TRANSLATE|CONTEXT)\]\s*/i, ""));
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
  concurrency = DEFAULT_CONCURRENCY,
): Promise<string[]> {
  const result: string[] = new Array(texts.length);
  // Skip empty / whitespace-only nodes
  const idxs = texts.map((t, i) => ({ t, i })).filter((x) => x.t && x.t.trim().length > 0);
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
      // Provide surrounding (untranslated source) segments as discourse context.
      const before = idxs.slice(Math.max(0, start - CONTEXT_WINDOW), start).map((s) => s.t);
      const after = idxs
        .slice(start + slice.length, start + slice.length + CONTEXT_WINDOW)
        .map((s) => s.t);
      const translated = await translateBatch(
        config,
        slice.map((s) => s.t),
        target,
        source,
        signal,
        before,
        after,
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
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXml(s: string) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function textTagRe(tag: "w:t" | "a:t") {
  // Require whitespace or `>` after the tag name so we don't accidentally
  // match siblings like <w:tab/>, <w:tbl>, <a:tableStyleId>, etc.
  return new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
}

function containerTagRe(textTag: "w:t" | "a:t") {
  const tag = textTag === "w:t" ? "w:p" : "a:p";
  return new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "g");
}

// Strip characters that are illegal in XML 1.0 (C0 controls except \t \n \r,
// plus lone surrogates and non-characters). LLMs occasionally emit these and
// they make Word refuse to open the .docx with "unreadable content" errors.
function sanitizeXmlText(s: string) {
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, "")
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
      .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1")
  );
}

function textElement(tag: "w:t" | "a:t", attrs: string | undefined, text: string) {
  const safe = sanitizeXmlText(text);
  let a = attrs || "";
  // Word/PowerPoint collapse leading/trailing whitespace unless xml:space is set
  // on the exact run that carries that whitespace. This is critical after we
  // split a translated paragraph back across multiple formatting runs.
  if (/^\s|\s$/.test(safe) && !/xml:space\s*=/.test(a)) {
    a = `${a} xml:space="preserve"`;
  }
  return `<${tag}${a}>${escapeXml(safe)}</${tag}>`;
}

function splitTranslatedAcrossRuns(translated: string, originalRuns: string[]) {
  const chunks = new Array(originalRuns.length).fill("") as string[];
  if (!originalRuns.length) return chunks;

  const slots = originalRuns
    .map((text, index) => ({ text, index }))
    .filter(({ text }) => text.length > 0);
  if (!slots.length) {
    chunks[0] = translated;
    return chunks;
  }

  const totalOriginal = slots.reduce((sum, slot) => sum + slot.text.length, 0) || slots.length;
  let originalCursor = 0;
  let translatedCursor = 0;

  slots.forEach((slot, position) => {
    if (position === slots.length - 1) {
      chunks[slot.index] = translated.slice(translatedCursor);
      return;
    }
    originalCursor += slot.text.length;
    const nextCursor = Math.max(
      translatedCursor,
      Math.min(translated.length, Math.round((translated.length * originalCursor) / totalOriginal)),
    );
    chunks[slot.index] = translated.slice(translatedCursor, nextCursor);
    translatedCursor = nextCursor;
  });

  return chunks;
}

function extractContainerText(containerXml: string, tag: "w:t" | "a:t") {
  return Array.from(containerXml.matchAll(textTagRe(tag)))
    .map((m) => unescapeXml(m[2] || ""))
    .join("");
}

function writeTranslatedContainer(containerXml: string, tag: "w:t" | "a:t", translated: string) {
  const originals = Array.from(containerXml.matchAll(textTagRe(tag))).map((m) =>
    unescapeXml(m[2] || ""),
  );
  const chunks = splitTranslatedAcrossRuns(translated, originals);
  let i = 0;
  return containerXml.replace(textTagRe(tag), (_full, attrs) =>
    textElement(tag, attrs, chunks[i++] || ""),
  );
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
  concurrency?: number;
}): Promise<TranslateResult> {
  const { doc, config, target, source = "auto", onProgress, signal, concurrency } = opts;
  if (!doc.bytes) throw new Error("Original file bytes are unavailable for translation.");
  const lower = doc.name.toLowerCase();
  const tag = langTag(target);
  const baseName = doc.name.replace(/\.[^.]+$/, "");

  // Thread concurrency into translateMany via partial application.
  const _origMany = translateMany;
  const many = (
    cfg: LLMConfig,
    texts: string[],
    tgt: Language,
    src: Language | "auto",
    onP?: (p: TranslateProgress) => void,
    sig?: AbortSignal,
  ) => _origMany(cfg, texts, tgt, src, onP, sig, concurrency);
  // monkey-patch local reference: translateOoxmlPart / translatePlainText call translateMany
  // directly, so we re-implement the two callers inline with the concurrency arg.

  const ooxml = async (xml: string, tag2: "w:t" | "a:t", stagePrefix: string) => {
    const re = containerTagRe(tag2);
    const matches = Array.from(xml.matchAll(re));
    const texts = matches.map((m) => extractContainerText(m[0], tag2));
    if (!texts.length) return xml;
    const translated = await many(
      config,
      texts,
      target,
      source,
      (p) => onProgress?.({ ...p, stage: `${stagePrefix}${p.stage}` }),
      signal,
    );
    let i = 0;
    return xml.replace(re, (container) =>
      writeTranslatedContainer(container, tag2, translated[i++] ?? ""),
    );
  };

  if (lower.endsWith(".docx")) {
    const zip = await JSZip.loadAsync(doc.bytes);
    const partNames = Object.keys(zip.files).filter((n) =>
      /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(n),
    );
    for (const name of partNames) {
      const xml = await zip.files[name].async("string");
      const updated = await ooxml(xml, "w:t", `${name}: `);
      zip.file(name, updated);
    }
    const blob = await zip.generateAsync({
      type: "blob",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    return { blob, filename: `${baseName}.${tag}.docx` };
  }
  if (lower.endsWith(".pptx")) {
    const zip = await JSZip.loadAsync(doc.bytes);
    const partNames = Object.keys(zip.files).filter((n) =>
      /^ppt\/(slides|notesSlides)\/(slide|notesSlide)\d+\.xml$/.test(n),
    );
    for (const name of partNames) {
      const xml = await zip.files[name].async("string");
      const updated = await ooxml(xml, "a:t", `${name}: `);
      zip.file(name, updated);
    }
    const blob = await zip.generateAsync({
      type: "blob",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    return { blob, filename: `${baseName}.${tag}.pptx` };
  }
  if (lower.endsWith(".pdf")) {
    const segments = doc.text.split(/(\r?\n\s*\r?\n)/);
    const payload: string[] = [];
    const slots: number[] = [];
    segments.forEach((s, i) => {
      if (i % 2 === 0 && s.trim()) {
        slots.push(i);
        payload.push(s);
      }
    });
    const translated = payload.length
      ? await many(config, payload, target, source, onProgress, signal)
      : payload;
    const out = segments.slice();
    slots.forEach((idx, k) => {
      out[idx] = translated[k];
    });
    const filename = `${baseName}.${tag}.docx`;
    await exportToDocx(`${baseName} (${target})`, out.join(""), filename);
    return {
      blob: new Blob(),
      filename,
      notice: "PDF formatting cannot be preserved client-side — delivered as a Word document.",
    };
  }
  const decoded =
    doc.text && !doc.text.startsWith("[Failed") ? doc.text : new TextDecoder().decode(doc.bytes);
  const segments = decoded.split(/(\r?\n\s*\r?\n)/);
  const payload: string[] = [];
  const slots: number[] = [];
  segments.forEach((s, i) => {
    if (i % 2 === 0 && s.trim()) {
      slots.push(i);
      payload.push(s);
    }
  });
  const translated = payload.length
    ? await many(config, payload, target, source, onProgress, signal)
    : payload;
  const out = segments.slice();
  slots.forEach((idx, k) => {
    out[idx] = translated[k];
  });
  const blob = new Blob([out.join("")], { type: "text/plain;charset=utf-8" });
  return {
    blob,
    filename: changeExt(doc.name, `.${tag}${lower.match(/\.[a-z0-9]+$/)?.[0] || ".txt"}`),
  };
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
