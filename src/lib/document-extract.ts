import mammoth from "mammoth";
import JSZip from "jszip";

/** Generate a unique id, safe for non-secure contexts (HTTP localhost). */
export function uid(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {}
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const EXTRACTION_TIMEOUT_MS = 30000;
import mammoth from "mammoth";
import JSZip from "jszip";

function uid(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {}
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface ExtractedDoc {
  id: string;
  name: string;
  size: number;
  type: string;
  text: string;
  preview: string;
  /** Original file bytes — kept so we can do format-preserving transforms (e.g. translation). */
  bytes?: ArrayBuffer;
}

async function extractPdfFromBuffer(buf: ArrayBuffer): Promise<string> {
  // Use the legacy build — works without a separate worker file in all browsers.
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "";
  const pdf = await pdfjs.getDocument({
    data: buf.slice(0),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    out.push(content.items.map((it: any) => it.str).join(" "));
  }
  return out.join("\n\n");
}

async function extractDocxFromBuffer(buf: ArrayBuffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ arrayBuffer: buf });
  return value;
}

async function extractPptxFromBuffer(buf: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)/)![1]);
      const nb = parseInt(b.match(/slide(\d+)/)![1]);
      return na - nb;
    });
  const parts: string[] = [];
  for (let i = 0; i < slides.length; i++) {
    const xml = await zip.files[slides[i]].async("string");
    const texts = Array.from(xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)).map((m) => m[1]);
    parts.push(`# Slide ${i + 1}\n${texts.join("\n")}`);
  }
  return parts.join("\n\n");
}


export async function extractDocument(file: File): Promise<ExtractedDoc> {
  const name = file.name.toLowerCase();
  let text = "";
  let bytes: ArrayBuffer | undefined;
  try {
    bytes = await file.arrayBuffer();
    if (name.endsWith(".pdf")) text = await extractPdfFromBuffer(bytes);
    else if (name.endsWith(".docx")) text = await extractDocxFromBuffer(bytes);
    else if (name.endsWith(".pptx")) text = await extractPptxFromBuffer(bytes);
    else text = new TextDecoder().decode(bytes);
  } catch (e: any) {
    text = `[Failed to extract: ${e?.message || "unknown error"}]`;
  }
  const preview = text.slice(0, 280).replace(/\s+/g, " ").trim();
  return {
    id: uid(),
    name: file.name,
    size: file.size,
    type: file.type || name.split(".").pop() || "file",
    text,
    preview,
    bytes,
  };
}

export function truncateForContext(text: string, maxChars = 18000): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.7));
  const tail = text.slice(-Math.floor(maxChars * 0.3));
  return `${head}\n\n[...content truncated...]\n\n${tail}`;
}
