import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles,
  Loader2,
  Square,
  Download,
  AlertCircle,
  CheckCircle2,
  Brain,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TASKS, buildPrompt, type TaskId } from "@/lib/tasks";
import { type LLMConfig, generateLong } from "@/lib/llm-service";
import { generateOrchestrated, type Outline } from "@/lib/orchestrator";
import type { ExtractedDoc } from "@/lib/document-extract";
import { exportToDocx } from "@/lib/docx-export";
import { TranslatorPanel } from "./TranslatorPanel";
import { toast } from "sonner";

interface Props {
  config: LLMConfig;
  docs: ExtractedDoc[];
}

interface LastRun {
  filename: string;
  title: string;
  markdown: string;
  chars: number;
  durationMs: number;
}

function formatDuration(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function TaskWorkbench({ config, docs }: Props) {
  const [task, setTask] = useState<TaskId>("compare");
  const [instruction, setInstruction] = useState("");
  const [targetPages, setTargetPages] = useState(0);
  const [workers, setWorkers] = useState(3);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<string>("");
  const [chars, setChars] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [thinking, setThinking] = useState("");
  const [thinkOpen, setThinkOpen] = useState(false);
  const [outline, setOutline] = useState<Outline | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startRef = useRef<number>(0);

  const activeTask = useMemo(() => TASKS.find((t) => t.id === task)!, [task]);
  const enoughDocs = docs.length >= activeTask.minDocs;
  const canRun = enoughDocs && !!config.model && !running;

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setElapsed(Date.now() - startRef.current), 250);
    return () => clearInterval(t);
  }, [running]);

  const run = async () => {
    if (!canRun) return;
    setErr(null);
    setLastRun(null);
    setChars(0);
    setThinking("");
    setOutline(null);
    setStage("Preparing prompt…");
    setRunning(true);
    startRef.current = Date.now();
    setElapsed(0);

    const { system, user } = buildPrompt({ task, docs, userInstruction: instruction });
    const ctl = new AbortController();
    abortRef.current = ctl;

    let acc = "";
    try {
      if (targetPages > 0) {
        acc = await generateOrchestrated({
          config,
          system,
          user,
          targetPages,
          concurrency: workers,
          signal: ctl.signal,
          onStage: (s) => setStage(s),
          onDelta: (t) => setChars((c) => c + t.length),
          onThinking: (t) => setThinking((p) => (p + t).slice(-8000)),
          onPlan: (o) => setOutline(o),
        });
      } else {
        acc = await generateLong({
          config,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          signal: ctl.signal,
          onStage: (s) => setStage(s),
          onDelta: (t) => setChars((c) => c + t.length),
          onThinking: (t) => setThinking((p) => (p + t).slice(-8000)),
        });
      }

      if (ctl.signal.aborted) {
        setStage("Stopped.");
        return;
      }
      if (!acc.trim()) {
        setErr("The model returned no content.");
        return;
      }

      setStage("Building Word document…");
      const title = `${activeTask.label} — ${new Date().toLocaleDateString()}`;
      const filename = `lex-${task}-${Date.now()}.docx`;
      await exportToDocx(title, acc, filename);
      const duration = Date.now() - startRef.current;
      setLastRun({ filename, title, markdown: acc, chars: acc.length, durationMs: duration });
      setStage("Done.");
      toast.success("Document ready", { description: filename });
    } catch (e: any) {
      if (e?.name !== "AbortError") setErr(e?.message || "Generation failed");
    } finally {
      setRunning(false);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    setRunning(false);
    setStage("Stopped.");
  };

  const redownload = async () => {
    if (!lastRun) return;
    await exportToDocx(lastRun.title, lastRun.markdown, lastRun.filename);
  };

  return (
    <div className="space-y-5">
      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-2 block">
          Task
        </Label>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {TASKS.map((t) => {
            const active = t.id === task;
            return (
              <button
                key={t.id}
                onClick={() => setTask(t.id)}
                className={`text-left rounded-md border p-3 transition-all ${
                  active
                    ? "border-primary bg-primary/10 shadow-[0_0_0_1px_var(--primary)]"
                    : "border-hairline bg-surface hover:border-primary/40"
                }`}
              >
                <div className="text-sm font-medium leading-tight">{t.label}</div>
                <div className="text-[11px] text-muted-foreground mt-1 line-clamp-2">
                  {t.description}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {task === "translate" ? (
        <TranslatorPanel config={config} docs={docs} />
      ) : (
        <>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              Instructions
            </Label>
            <Textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder={activeTask.promptHint}
              rows={3}
              className="mt-1 bg-surface resize-none"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                Target length (pages)
              </Label>
              <Input
                type="number"
                min={0}
                max={80}
                value={targetPages}
                onChange={(e) =>
                  setTargetPages(Math.max(0, Math.min(80, Number(e.target.value) || 0)))
                }
                className="mt-1 bg-surface"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                0 = single-call mode. Set ≥ 1 to enable the orchestrator: it plans an outline and
                writes each section in parallel to bypass per-call length caps.
              </p>
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                Parallel sections
              </Label>
              <Input
                type="number"
                min={1}
                max={8}
                value={workers}
                onChange={(e) =>
                  setWorkers(Math.max(1, Math.min(8, Number(e.target.value) || 1)))
                }
                className="mt-1 bg-surface"
                disabled={targetPages === 0}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                How many sections to write concurrently against the same local model endpoint.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!running ? (
              <Button
                onClick={run}
                disabled={!canRun}
                className="bg-primary text-primary-foreground hover:bg-primary/90 gap-2"
              >
                <Sparkles className="h-4 w-4" />
                Generate Word document
              </Button>
            ) : (
              <Button onClick={stop} variant="destructive" className="gap-2">
                <Square className="h-4 w-4" />
                Stop
              </Button>
            )}
            {!enoughDocs && (
              <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5" />
                Needs {activeTask.minDocs} document{activeTask.minDocs > 1 ? "s" : ""}
              </span>
            )}
            {!config.model && (
              <span className="text-xs text-destructive flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5" />
                Configure a model in LLM Admin
              </span>
            )}
            {config.thinking && (
              <span className="text-xs text-primary flex items-center gap-1.5 font-mono">
                <Brain className="h-3.5 w-3.5" />
                Deep reasoning on
              </span>
            )}
          </div>

          {err && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {err}
            </div>
          )}

          <AnimatePresence mode="wait">
            {running && (
              <motion.div
                key="progress"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="rounded-md border border-hairline bg-surface p-5 space-y-4"
              >
                <div className="flex items-center gap-3">
                  <Loader2 className="h-5 w-5 animate-spin text-primary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{stage || "Working…"}</div>
                    <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                      {chars.toLocaleString()} chars · {formatDuration(elapsed)} elapsed
                    </div>
                  </div>
                </div>

                <div className="h-1 w-full overflow-hidden rounded-full bg-hairline">
                  <motion.div
                    className="h-full bg-primary"
                    animate={{ x: ["-100%", "100%"] }}
                    transition={{ duration: 1.8, repeat: Infinity, ease: "linear" }}
                    style={{ width: "40%" }}
                  />
                </div>

                {thinking && (
                  <div>
                    <button
                      onClick={() => setThinkOpen((v) => !v)}
                      className="text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground flex items-center gap-1.5 font-mono"
                    >
                      <Brain className="h-3 w-3" />
                      Reasoning trace
                      {thinkOpen ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      )}
                    </button>
                    {thinkOpen && (
                      <pre className="mt-2 max-h-48 overflow-auto rounded bg-background/50 p-3 text-[11px] text-muted-foreground whitespace-pre-wrap font-mono leading-relaxed">
                        {thinking}
                      </pre>
                    )}
                  </div>
                )}
              </motion.div>
            )}

            {!running && lastRun && (
              <motion.div
                key="done"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-md border border-primary/40 bg-primary/5 p-5 flex items-center gap-4"
              >
                <CheckCircle2 className="h-6 w-6 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{lastRun.filename}</div>
                  <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                    {lastRun.chars.toLocaleString()} chars · generated in{" "}
                    {formatDuration(lastRun.durationMs)}
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={redownload} className="gap-1.5">
                  <Download className="h-3.5 w-3.5" />
                  Re-download
                </Button>
              </motion.div>
            )}

            {!running && !lastRun && (
              <motion.div
                key="idle"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="rounded-md border border-dashed border-hairline bg-surface/50 p-6 text-sm text-muted-foreground italic"
              >
                Pick a task, add instructions, then generate. The result is delivered as a
                downloadable Word document — no in-page output limit.
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  );
}
