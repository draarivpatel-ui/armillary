import { editDiff, parseUnifiedDiff, type DiffLine } from "./diff";
import { parseMarkdown, type Block } from "./markdown";
import type { FileEdit, Message, NormalizedSession, ToolCall } from "./types";

export type BlockKind = "prompt" | "reply" | "system";

export interface ChecklistData {
  items: { text: string; done: boolean }[];
  source: "markdown" | "tool";
}

export interface FolioBlock {
  id: string;
  messageId: string;
  index: number;
  kind: BlockKind;
  role: Message["role"];
  seq: number;
  at: number | null;
  /** Heading text for user prompts, and for the page title in exports. */
  title: string | null;
  text: string;
  /** What the body of the block renders: the prompt text minus its heading line. */
  bodyText: string;
  blocks: Block[];
  checklists: ChecklistData[];
  headings: { level: number; text: string }[];
  isError: boolean;
}

export interface NoteEdit {
  path: string;
  raw: string;
  lines: DiffLine[];
  additions: number;
  deletions: number;
}

export interface MarginalNote {
  id: string;
  seq: number;
  kind: "tool" | "edit" | "plan" | "error";
  tool: string;
  input: string;
  result: string;
  /** Full Markdown of a subagent result when the one-line `result` is shorter; absent otherwise. */
  resultMarkdown?: string;
  files: string[];
  status: "ok" | "error";
  isError: boolean;
  error: string | null;
  edits: NoteEdit[];
  plan: ChecklistData | null;
  anchorIndex: number | null;
  anchorSeq: number | null;
  at: number | null;
}

export interface TocEntry {
  id: string;
  label: string;
  blockIndex: number;
  level: 1 | 2;
}

export interface BlockPlan {
  blocks: FolioBlock[];
  marginalia: MarginalNote[];
  toc: TocEntry[];
}

const ERROR_WORDS = /(^|\n)\s*(error|errors|failed|failure|exception|traceback|panic|crashed|unauthorized)\b|(FAIL|ERROR):/i;

function plainText(text: string): string {
  return text.replace(/`/g, "").replace(/\*\*/g, "").replace(/^#+\s*/, "");
}

function truncate(text: string, max = 80): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  const words = single.split(" ");
  let out = "";
  for (const word of words) {
    const candidate = out === "" ? word : `${out} ${word}`;
    if (candidate.length > max) break;
    out = candidate;
  }
  return out.trim();
}

function firstMeaningfulLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.trim();
}

function toNoteEdit(edit: FileEdit): NoteEdit {
  const raw = editDiff(edit);
  const parsed = parseUnifiedDiff(raw);
  return {
    path: edit.path,
    raw,
    lines: parsed.lines,
    additions: edit.additions ?? parsed.additions,
    deletions: edit.deletions ?? parsed.deletions,
  };
}

function promptParts(message: Message): { title: string; bodyText: string } {
  const lines = message.text.split("\n");
  const firstIndex = lines.findIndex((line) => line.trim() !== "");
  const firstLine = (lines[firstIndex] ?? "").trim();
  const title = truncate(plainText(firstLine));
  // the heading shows the title; the body keeps whatever the heading did not cover
  const coversLine = title.length >= plainText(firstLine).length;
  const leftover = coversLine ? "" : plainText(firstLine).slice(title.length).trim();
  const rest = lines.slice(firstIndex + 1).join("\n").replace(/^\n+/, "");
  const bodyText = leftover ? `${leftover}\n\n${rest}`.trim() : rest;
  return { title, bodyText };
}

function blockifyMessage(message: Message, index: number): FolioBlock {
  const kind: BlockKind = message.role === "user" ? "prompt" : message.role === "system" ? "system" : "reply";
  const parts = kind === "prompt" ? promptParts(message) : { title: "", bodyText: message.text };
  const bodyText = parts.bodyText;
  const blocks = parseMarkdown(bodyText);
  const checklists: ChecklistData[] = blocks
    .filter((block): block is Extract<Block, { type: "checklist" }> => block.type === "checklist")
    .map((block) => ({ items: block.items, source: "markdown" as const }));
  const headings = blocks
    .filter((block): block is Extract<Block, { type: "heading" }> => block.type === "heading")
    .map((block) => ({ level: block.level, text: block.text }));

  return {
    id: `m-${message.seq}`,
    messageId: `m-${message.seq}`,
    index,
    kind,
    role: message.role,
    seq: message.seq,
    at: message.at,
    title:
      kind === "prompt"
        ? parts.title
        : kind === "system"
          ? truncate(plainText(firstMeaningfulLine(message.text)), 60)
          : null,
    text: message.text,
    bodyText,
    blocks,
    checklists,
    headings,
    isError: kind !== "prompt" && ERROR_WORDS.test(message.text),
  };
}

function noteKindFor(call: ToolCall): MarginalNote["kind"] {
  if (call.status === "error") return "error";
  if (call.items && call.items.length > 0) return "plan";
  if (call.edits && call.edits.length > 0) return "edit";
  return "tool";
}

function toNote(call: ToolCall): MarginalNote {
  const error = call.error ?? (call.status === "error" ? call.result_summary : null);
  const plan =
    call.items && call.items.length > 0
      ? { items: call.items, source: "tool" as const }
      : call.text
        ? {
            items: parseMarkdown(call.text)
              .filter((block): block is Extract<Block, { type: "checklist" }> => block.type === "checklist")
              .flatMap((block) => block.items),
            source: "tool" as const,
          }
        : null;

  const note: MarginalNote = {
    id: `note-${call.seq}`,
    seq: call.seq,
    kind: noteKindFor(call),
    tool: call.name,
    input: call.input_summary,
    result: call.result_summary,
    files: call.files,
    status: call.status ?? "ok",
    isError: call.status === "error",
    error: error && error !== "" ? error : null,
    edits: (call.edits ?? []).map(toNoteEdit),
    plan: plan && plan.items.length > 0 ? plan : null,
    anchorIndex: null,
    anchorSeq: null,
    at: call.at ?? null,
  };
  if (call.resultMarkdown !== undefined) note.resultMarkdown = call.resultMarkdown;
  return note;
}

/** Turn a normalized session into reading blocks plus the marginal notes they carry. */
export function buildBlocks(messages: Message[], toolCalls: ToolCall[]): BlockPlan {
  const sortedMessages = [...messages].sort((a, b) => a.seq - b.seq);
  const blocks = sortedMessages.map(blockifyMessage);

  const notes = [...toolCalls].sort((a, b) => a.seq - b.seq).map(toNote);
  for (const note of notes) {
    let anchor: FolioBlock | null = null;
    for (const block of blocks) {
      if (block.seq <= note.seq) anchor = block;
      else break;
    }
    if (!anchor) anchor = blocks[0] ?? null;
    if (anchor) {
      note.anchorIndex = anchor.index;
      note.anchorSeq = anchor.seq;
    }
  }

  const toc: TocEntry[] = [];
  for (const block of blocks) {
    if (block.kind === "prompt" && block.title) {
      toc.push({ id: block.id, label: block.title, blockIndex: block.index, level: 1 });
    }
    for (const heading of block.headings) {
      if (heading.level <= 2) {
        toc.push({
          id: `${block.id}-h-${heading.text}`,
          label: heading.text,
          blockIndex: block.index,
          level: 2,
        });
      }
    }
  }

  return { blocks, marginalia: notes, toc };
}

export function planOf(session: NormalizedSession): BlockPlan {
  return buildBlocks(session.messages, session.toolCalls);
}
