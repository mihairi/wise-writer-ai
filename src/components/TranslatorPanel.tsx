import { useRef, useState } from "react";
import { Languages, Loader2, Download, Square, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import type { LLMConfig } from "@/lib/llm-service";
import type { ExtractedDoc } from "@/lib/document-extract";
import {
  LANGUAGES,
  translateDocument,
  downloadBlob,
  type Language,
} from "@/lib/translator";

interface Props {
  config: LLMConfig;
  docs: ExtractedDoc[];
}

export function TranslatorPanel({ config, docs }: Props) {
  const [source, setSource] = useState<Language | "auto">("auto");
  const [target, setTarget] = useState<Language>("English");
  const [concurrency, setConcurrency] = useState(4);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; stage: string } | null>(
    null
  );
  const [err, setErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = async (doc: ExtractedDoc) => {
    if (!config.model) {
      setErr("Configure a model in LLM Admin first.");
      return;
    }
    setErr(null);
    setBusyId(doc.id);
    setProgress({ done: 0, total: 0, stage: "Preparing…" });
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const { blob, filename, notice } = await translateDocument({
        doc,
        config,
        target,
        source,
        concurrency,
        onProgress: (p) => setProgress(p),
        signal: ctl.signal,
      });
      if (blob.size) downloadBlob(blob, filename);
      toast.success(`Translated → ${filename}`, { description: notice });
    } catch (e: any) {
      if (e?.message !== "Aborted") setErr(e?.message || "Translation failed");
    } finally {
      setBusyId(null);
      setProgress(null);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    setBusyId(null);
    setProgress(null);
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">From</Label>
          <Select value={source} onValueChange={(v) => setSource(v as Language | "auto")}>
            <SelectTrigger className="mt-1 bg-surface">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto-detect</SelectItem>
              {LANGUAGES.map((l) => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">To</Label>
          <Select value={target} onValueChange={(v) => setTarget(v as Language)}>
            <SelectTrigger className="mt-1 bg-surface">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((l) => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">
            Parallel batches
          </Label>
          <Input
            type="number"
            min={1}
            max={16}
            value={concurrency}
            onChange={(e) =>
              setConcurrency(Math.max(1, Math.min(16, Number(e.target.value) || 1)))
            }
            className="mt-1 bg-surface"
          />
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground font-mono">
        Translation is split into batches of 16 segments and dispatched in parallel against your
        local model — increase parallel batches to translate larger docs faster (limited by your
        model server's concurrency). DOCX/PPTX preserve original layout; PDFs deliver as Word.
      </p>


      {err && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive flex gap-2 items-start">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{err}</span>
        </div>
      )}

      {docs.length === 0 ? (
        <div className="rounded-md border border-hairline bg-surface p-6 text-sm text-muted-foreground italic">
          Upload one or more documents to translate.
        </div>
      ) : (
        <ul className="space-y-2">
          {docs.map((d) => {
            const isBusy = busyId === d.id;
            return (
              <li
                key={d.id}
                className="rounded-md border border-hairline bg-surface px-4 py-3 flex items-center gap-3"
              >
                <Languages className="h-4 w-4 text-primary shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate font-medium">{d.name}</div>
                  {isBusy && progress && (
                    <div className="text-[11px] text-muted-foreground font-mono mt-0.5 flex items-center gap-2">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {progress.stage}
                    </div>
                  )}
                </div>
                {!isBusy ? (
                  <Button
                    size="sm"
                    onClick={() => run(d)}
                    disabled={busyId !== null}
                    className="gap-1.5"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Translate
                  </Button>
                ) : (
                  <Button size="sm" variant="destructive" onClick={stop} className="gap-1.5">
                    <Square className="h-3.5 w-3.5" />
                    Stop
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
