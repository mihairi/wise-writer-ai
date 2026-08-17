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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
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

export interface ExtractionProgress {
  phase: "reading" | "ocr";
  completed: number;
  total: number;
}

async function loadPdfjs(): Promise<any> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // A real worker URL is required — an empty string throws
  // 'No "GlobalWorkerOptions.workerSrc" specified'.
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    const workerUrl = (await import("pdfjs-dist/legacy/build/pdf.worker.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  }
  return pdfjs;
}

/** Render + OCR every page of a PDF (used when the PDF has no text layer). */
export async function ocrPdfFromBuffer(
  buf: ArrayBuffer,
  onProgress?: (progress: ExtractionProgress) => void
): Promise<string> {
  const pdfjs = await loadPdfjs();
  const pdf: any = await pdfjs.getDocument({ data: buf.slice(0) }).promise;
  const { createWorker } = await import("tesseract.js");
  const workerCount = Math.min(pdf.numPages, 2);
  const workers = await Promise.all(Array.from({ length: workerCount }, () => createWorker("eng")));
  const out = new Array<string>(pdf.numPages);
  let nextPage = 1;
  let completed = 0;

  const runWorker = async (worker: Awaited<ReturnType<typeof createWorker>>) => {
    while (nextPage <= pdf.numPages) {
      const pageNumber = nextPage++;
      const page: any = await pdf.getPage(pageNumber);
      // 1.4x is a good OCR/readability balance and uses roughly half the pixels of 2x.
      const viewport = page.getViewport({ scale: 1.4 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error(`Could not render PDF page ${pageNumber}`);

      try {
        await page.render({ canvasContext: ctx, viewport }).promise;
        const result: any = await withTimeout(
          worker.recognize(canvas),
          120000,
          `OCR page ${pageNumber}`
        );
        out[pageNumber - 1] = `# Page ${pageNumber}\n${(result?.data?.text || "").trim()}`;
        completed += 1;
        onProgress?.({ phase: "ocr", completed, total: pdf.numPages });
      } finally {
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup?.();
      }
    }
  };

  try {
    await Promise.all(workers.map(runWorker));
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    pdf.cleanup?.();
  }
  return out.join("\n\n");
}

async function extractPdfFromBuffer(
  buf: ArrayBuffer,
  onProgress?: (progress: ExtractionProgress) => void
): Promise<string> {
  const pdfjs = await loadPdfjs();
  const pdf: any = await withTimeout(
    pdfjs.getDocument({
      data: buf.slice(0),
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise,
    EXTRACTION_TIMEOUT_MS,
    "PDF loading"
  );
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page: any = await withTimeout(pdf.getPage(i), 10000, `PDF page ${i}`);
    const content: any = await withTimeout(page.getTextContent(), 10000, `PDF text page ${i}`);
    out.push(content.items.map((it: any) => it.str).join(" "));
    onProgress?.({ phase: "reading", completed: i, total: pdf.numPages });
    page.cleanup?.();
  }
  const text = out.join("\n\n");
  // Scanned PDFs have (almost) no text layer — fall back to OCR.
  const meaningful = text.replace(/\s+/g, "").length;
  if (meaningful < Math.max(40, pdf.numPages * 20)) {
    try {
      const ocr = await ocrPdfFromBuffer(buf, onProgress);
      if (ocr.replace(/\s+/g, "").length > meaningful) return ocr;
    } catch (e: any) {
      console.error("[extract] OCR fallback failed", e);
    }
  }
  return text;
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


export async function extractDocument(
  file: File,
  onProgress?: (progress: ExtractionProgress) => void
): Promise<ExtractedDoc> {
  const name = file.name.toLowerCase();
  let text = "";
  let bytes: ArrayBuffer | undefined;
  try {
    bytes = await file.arrayBuffer();
    if (name.endsWith(".pdf")) text = await extractPdfFromBuffer(bytes, onProgress);
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
