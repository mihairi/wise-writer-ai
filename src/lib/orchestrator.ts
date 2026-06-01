// Multi-call orchestrator: plans an outline, then writes each section in
// parallel against the same local LLM endpoint. This is how we get past the
// per-completion length ceiling that local models impose — instead of asking
// one call to produce 10 pages, we ask N calls to each produce ~1 page and
// stitch them together.

import { chatComplete, generateLong, type LLMConfig } from "./llm-service";

export interface SectionPlan {
  number: number;
  heading: string;
  summary: string;
  words: number;
}

export interface Outline {
  title: string;
  sections: SectionPlan[];
}

export interface OrchestratorOptions {
  config: LLMConfig;
  system: string;
  /** The full user prompt (instruction + documents block) from buildPrompt(). */
  user: string;
  /** Approximate target length in pages (~450 words/page). */
  targetPages: number;
  /** How many sections to write concurrently. */
  concurrency: number;
  signal?: AbortSignal;
  onStage?: (s: string) => void;
  onDelta?: (t: string) => void;
  onThinking?: (t: string) => void;
  onPlan?: (o: Outline) => void;
  onSectionDone?: (i: number, total: number) => void;
}

async function planOutline(opts: OrchestratorOptions): Promise<Outline> {
  const totalWords = Math.max(800, opts.targetPages * 450);
  const minSections = Math.max(4, Math.min(12, Math.round(opts.targetPages * 0.8)));
  const planSystem =
    "You are a senior editor planning a long Markdown deliverable. Respond with STRICT JSON only — no prose, no code fences.";
  const planUser = `Plan a comprehensive document of about ${opts.targetPages} pages (~${totalWords} words total).
Split it into ${minSections}-${minSections + 4} substantive sections that together cover the topic in real depth (context, analysis, evidence, risks, recommendations, next steps, assumptions).

ORIGINAL REQUEST AND PROVIDED DOCUMENTS:
${opts.user}

Respond with JSON of this exact shape:
{
  "title": "Document title",
  "sections": [
    {
      "number": 1,
      "heading": "Section heading",
      "summary": "2-4 sentences describing exactly what this section MUST cover: specific subtopics, examples, data points, structure (tables, lists), and tone.",
      "words": 900
    }
  ]
}
Rules:
- "words" values should sum to roughly ${totalWords}.
- No section under 500 words.
- Headings must be distinct and non-overlapping.
- The last section MUST be "Assumptions".
- Output JSON only, no commentary.`;

  const raw = await chatComplete({
    config: opts.config,
    messages: [
      { role: "system", content: planSystem },
      { role: "user", content: planUser },
    ],
    signal: opts.signal,
  });
  const cleaned = raw
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Outline planner did not return JSON.");
  let parsed: Outline;
  try {
    parsed = JSON.parse(match[0]);
  } catch (e: any) {
    throw new Error(`Outline planner returned invalid JSON: ${e?.message || e}`);
  }
  if (!parsed?.sections?.length) throw new Error("Outline planner returned no sections.");
  parsed.sections = parsed.sections.map((s, i) => ({
    number: s.number ?? i + 1,
    heading: String(s.heading || `Section ${i + 1}`),
    summary: String(s.summary || ""),
    words: Math.max(500, Number(s.words) || 700),
  }));
  return parsed;
}

async function writeSection(
  opts: OrchestratorOptions,
  outline: Outline,
  idx: number
): Promise<string> {
  const sec = outline.sections[idx];
  const others = outline.sections
    .filter((_, i) => i !== idx)
    .map((s) => `  - ${s.number}. ${s.heading}`)
    .join("\n");

  const system = `${opts.system}

You are now writing ONE section of a larger document titled "${outline.title}".
The other sections (DO NOT write them, DO NOT repeat their content) are:
${others}

Strict output rules for this call:
- Start your output with the line: "## ${sec.heading}"
- Write approximately ${sec.words} words for this section. Be substantive, concrete and specific.
- Use sub-headings (### / ####), bullet lists, and Markdown tables where they aid comprehension.
- No preamble ("In this section…"), no closing remark, no references to other sections by number.
- Do not write any other top-level heading. Only "## ${sec.heading}" and its sub-headings.
- Cite uploaded documents by filename when relevant.`;

  const user = `Section ${sec.number} of ${outline.sections.length} — write only this section.

Brief: ${sec.summary}

Target length: ~${sec.words} words.

=== ORIGINAL REQUEST AND PROVIDED DOCUMENTS (for context) ===
${opts.user}`;

  return await generateLong({
    config: opts.config,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    signal: opts.signal,
    onThinking: opts.onThinking,
    onDelta: opts.onDelta ?? (() => {}),
    maxContinuations: 3,
  });
}

export async function generateOrchestrated(opts: OrchestratorOptions): Promise<string> {
  opts.onStage?.("Planning outline…");
  const outline = await planOutline(opts);
  opts.onPlan?.(outline);
  const total = outline.sections.length;
  const conc = Math.max(1, Math.min(opts.concurrency, total));
  opts.onStage?.(`Writing ${total} sections (${conc} in parallel)…`);

  const results: string[] = new Array(total);
  let nextIdx = 0;
  let done = 0;
  const failures: { idx: number; err: any }[] = [];

  const worker = async () => {
    while (true) {
      if (opts.signal?.aborted) return;
      const i = nextIdx++;
      if (i >= total) return;
      try {
        results[i] = await writeSection(opts, outline, i);
      } catch (e) {
        failures.push({ idx: i, err: e });
        results[i] = `## ${outline.sections[i].heading}\n\n_(Section generation failed: ${
          (e as any)?.message || e
        })_\n`;
      }
      done++;
      opts.onSectionDone?.(done, total);
      opts.onStage?.(`Section ${done}/${total} complete…`);
    }
  };

  await Promise.all(Array.from({ length: conc }, () => worker()));

  if (failures.length === total) {
    throw new Error(`All ${total} sections failed. First error: ${failures[0].err?.message || failures[0].err}`);
  }

  return `# ${outline.title}\n\n` + results.join("\n\n");
}
