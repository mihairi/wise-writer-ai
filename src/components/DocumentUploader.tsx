import { useCallback, useRef, useState } from "react";
import { Upload, FileText, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  extractDocument,
  type ExtractedDoc,
  type ExtractionProgress,
  uid,
} from "@/lib/document-extract";
interface Props {
  docs: ExtractedDoc[];
  onChange: (docs: ExtractedDoc[]) => void;
}

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function DocumentUploader({ docs, onChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState<ExtractionProgress | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || !files.length) return;
      setBusy(true);
      const extracted: ExtractedDoc[] = [];
      try {
        for (const f of Array.from(files)) {
          try {
            console.log("[upload] extracting", f.name, f.size, f.type);
            setProgress(null);
            const doc = await extractDocument(f, setProgress);
            console.log("[upload] done", f.name, "chars=", doc.text.length);
            extracted.push(doc);
          } catch (err: any) {
            console.error("[upload] failed", f.name, err);
            extracted.push({
              id: uid(),
              name: f.name,
              size: f.size,
              type: f.type || "file",
              text: `[Failed to extract: ${err?.message || "unknown error"}]`,
              preview: `Failed: ${err?.message || "unknown error"}`,
            });
          }
        }
        onChange([...docs, ...extracted]);
      } finally {
        setBusy(false);
        setProgress(null);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [docs, onChange]
  );

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={`relative rounded-md border border-dashed p-6 text-center transition-colors ${
          drag ? "border-primary bg-primary/5" : "border-hairline bg-surface"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.pptx,.txt,.md,.csv,.json,.html,.htm,.xml,.log"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
        <Upload className="mx-auto h-6 w-6 text-muted-foreground" />
        <p className="mt-2 text-sm">
          Drop files or{" "}
          <button
            onClick={() => inputRef.current?.click()}
            className="text-primary underline-offset-4 hover:underline"
          >
            browse
          </button>
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground font-mono">
          PDF · DOCX · PPTX · TXT · MD · CSV · JSON · HTML · XML
        </p>
        {busy && (
          <div className="absolute inset-0 grid place-items-center bg-background/80 rounded-md">
            <div className="flex flex-col items-center gap-2 px-4">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <span className="text-xs font-mono text-foreground">
                {progress
                  ? `${progress.phase === "ocr" ? "OCR" : "Reading"} ${progress.completed} / ${progress.total} pages`
                  : "Preparing document…"}
              </span>
              {progress && (
                <div className="h-1 w-40 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-[width] duration-300"
                    style={{ width: `${(progress.completed / progress.total) * 100}%` }}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {docs.length > 0 && (
        <ul className="space-y-1.5">
          {docs.map((d, i) => (
            <li
              key={d.id}
              className="group flex items-start gap-3 rounded-md bg-surface px-3 py-2 border border-hairline"
            >
              <div className="mt-0.5 text-[10px] font-mono text-muted-foreground w-5 shrink-0">
                {String(i + 1).padStart(2, "0")}
              </div>
              <FileText className="h-4 w-4 mt-0.5 text-primary shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm truncate font-medium">{d.name}</div>
                <div className="text-[11px] text-muted-foreground font-mono">
                  {fmtSize(d.size)} · {d.text.length.toLocaleString()} chars
                </div>
                {d.preview && (
                  <div className="text-[11px] text-muted-foreground mt-1 line-clamp-2">
                    {d.preview}
                  </div>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 opacity-60 group-hover:opacity-100"
                onClick={() => onChange(docs.filter((x) => x.id !== d.id))}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
