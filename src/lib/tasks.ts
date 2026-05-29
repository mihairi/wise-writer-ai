import type { ExtractedDoc } from "./document-extract";
import { truncateForContext } from "./document-extract";

export type TaskId =
  | "compare"
  | "enhance"
  | "compliance"
  | "policy"
  | "transform"
  | "translate"
  | "draft"
  | "merge"
  | "custom";

export interface TaskDef {
  id: TaskId;
  label: string;
  description: string;
  minDocs: number;
  promptHint: string;
}

export const TASKS: TaskDef[] = [
  {
    id: "compare",
    label: "Compare documents",
    description: "Side-by-side analysis: differences, contradictions, overlaps.",
    minDocs: 2,
    promptHint: "What dimensions should I focus on? (e.g. legal clauses, tone, deadlines)",
  },
  {
    id: "enhance",
    label: "Suggest enhancements",
    description: "Critique a document and propose concrete improvements.",
    minDocs: 1,
    promptHint: "Audience, goals, tone you want to optimize for.",
  },
  {
    id: "compliance",
    label: "Legal compliance check",
    description: "Verify a document against laws/regulations provided as reference.",
    minDocs: 2,
    promptHint: "Mark the first doc as the policy and the rest as regulations.",
  },
  {
    id: "policy",
    label: "Modify policy / procedure",
    description: "Rewrite an existing internal policy with proposed changes.",
    minDocs: 1,
    promptHint: "Describe the change scope, drivers and constraints.",
  },
  {
    id: "transform",
    label: "Transform format",
    description: "e.g. turn a slide deck into a descriptive Word report.",
    minDocs: 1,
    promptHint: "Target format and audience (e.g. narrative Word doc for execs).",
  },
  {
    id: "translate",
    label: "Translate document",
    description: "Translate between English, German and Romanian — same file type, format preserved.",
    minDocs: 1,
    promptHint: "",
  },
  {
    id: "draft",
    label: "Draft from scratch",
    description: "Produce a new business document, optionally using uploads as models.",
    minDocs: 0,
    promptHint: "Describe the document: type, audience, sections, length.",
  },
  {
    id: "merge",
    label: "Enhance with another doc",
    description: "Improve a primary document using info from secondary sources.",
    minDocs: 2,
    promptHint: "The first doc is the base. Others are sources of new information.",
  },
  {
    id: "custom",
    label: "Custom instruction",
    description: "Free-form request operating on the uploaded documents.",
    minDocs: 0,
    promptHint: "Describe exactly what you want.",
  },
];

const SYSTEM_BASE = `You are Lex, a senior corporate analyst and legal-policy editor.
Produce precise, comprehensive, well-structured Markdown output.

Length & depth:
- Default to a thorough, publication-quality deliverable. Do NOT produce short summaries
  unless explicitly asked. When in doubt, write more, not less.
- Use clear hierarchical headings (## / ###), full paragraphs, bullet lists and Markdown
  tables where they aid comprehension.
- Cover every relevant angle: context, analysis, evidence, risks, edge cases,
  counter-arguments, recommendations, and concrete next steps.
- Always end with an "Assumptions" section listing anything you inferred.

Style:
- Be neutral, professional, and explicit about uncertainty.
- When citing the provided documents, refer to them by filename.
- If information is missing, state it explicitly rather than inventing.
- Do not include meta-commentary about the task itself; deliver the artefact.`;


function docBlock(d: ExtractedDoc, idx: number, label?: string) {
  return `---
DOCUMENT ${idx + 1}${label ? ` — ${label}` : ""}: ${d.name}
---
${truncateForContext(d.text)}`;
}

export function buildPrompt(opts: {
  task: TaskId;
  docs: ExtractedDoc[];
  userInstruction: string;
}): { system: string; user: string } {
  const { task, docs, userInstruction } = opts;
  const system = SYSTEM_BASE;
  const docsText = docs.length
    ? docs.map((d, i) => docBlock(d, i)).join("\n\n")
    : "(no documents provided)";

  const wrap = (intent: string) =>
    `${intent}\n\nUser instructions: ${userInstruction || "(none)"}\n\n=== PROVIDED DOCUMENTS ===\n${docsText}\n\nReturn the result as Markdown.`;

  switch (task) {
    case "compare":
      return {
        system,
        user: wrap(
          "Task: Produce a structured comparison of the provided documents. Sections: Overview, Common Ground, Key Differences (table or list), Contradictions / Risks, Recommended Reconciliation."
        ),
      };
    case "enhance":
      return {
        system,
        user: wrap(
          "Task: Critically review the document and produce: 1) Executive Summary of strengths/weaknesses, 2) Issue list with severity, 3) Concrete rewrite suggestions (before / after snippets where useful), 4) A proposed improved outline."
        ),
      };
    case "compliance": {
      const policy = docs[0];
      const regs = docs.slice(1);
      const block = `POLICY UNDER REVIEW: ${policy?.name || "(none)"}\n${policy ? truncateForContext(policy.text) : ""}\n\nREFERENCE LAWS / REGULATIONS:\n${regs.map((d, i) => docBlock(d, i, "regulation")).join("\n\n")}`;
      return {
        system,
        user: `Task: Perform a legal compliance review. For each obligation in the regulations, indicate whether the policy is Compliant, Partially Compliant, Non-Compliant, or Not Addressed, with citations to filenames and concrete remediation guidance.\n\nUser instructions: ${userInstruction || "(none)"}\n\n${block}\n\nReturn Markdown with a summary table followed by detailed findings.`,
      };
    }
    case "policy":
      return {
        system,
        user: wrap(
          "Task: Propose modifications to the existing policy/procedure. Output: 1) Change rationale, 2) Annotated diff (before / after) for each affected section, 3) Full revised policy ready to publish."
        ),
      };
    case "transform":
      return {
        system,
        user: wrap(
          "Task: Transform the source document into the requested target format. If the source is a slide deck, produce a flowing descriptive Word-style report (use H1/H2/H3, full paragraphs, no slide-by-slide layout). Preserve all substantive information."
        ),
      };
    case "draft":
      return {
        system,
        user: wrap(
          "Task: Draft a new business document per the user instructions. If documents were provided, treat them as style/structure models and as sources of factual content. Output a publication-ready Markdown document with title, metadata line, and clear sections."
        ),
      };
    case "merge": {
      const base = docs[0];
      const sources = docs.slice(1);
      const block = `BASE DOCUMENT (to be enhanced): ${base?.name}\n${base ? truncateForContext(base.text) : ""}\n\nADDITIONAL SOURCES:\n${sources.map((d, i) => docBlock(d, i, "source")).join("\n\n")}`;
      return {
        system,
        user: `Task: Produce an enhanced version of the base document, integrating relevant information from the additional sources. Mark each integrated insight inline with its source filename in parentheses. Preserve the base document's voice.\n\nUser instructions: ${userInstruction || "(none)"}\n\n${block}\n\nReturn the full enhanced Markdown document.`,
      };
    }
    case "custom":
    default:
      return { system, user: wrap("Task: Follow the user instructions precisely using the provided documents as context.") };
  }
}
