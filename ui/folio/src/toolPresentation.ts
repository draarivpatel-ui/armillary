/**
 * Display-only presentation of real agent tool data: file edits, checklists, error lines and
 * paths. Agents record these as plain tool_call and tool_result blocks; the archive is not changed.
 * Everything here is total: an input that cannot be parsed yields nothing and never throws.
 */
import type { FileEdit, PlanItem } from "./types";

const PATH_KEYS = ["file_path", "filePath", "path", "target_file"];
const CONTEXT = 2;
const MAX_DP_CELLS = 4_000_000;

export interface ToolPresentation {
  /** Replaces the tool name when set (for example "apply_patch", "Task (general-purpose)"). */
  name?: string;
  /** Replaces the input summary when set. */
  inputSummary?: string;
  edits?: FileEdit[];
  items?: PlanItem[];
  /** Paths named by the input, used when the importer left `files` empty. */
  paths: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** A path under the project root is shown relative to it; anything else is left alone. */
export function relativePath(path: string, root: string | null | undefined): string {
  if (!root) return path;
  const base = root.replace(/\/+$/, "");
  if (base === "") return path;
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

export function pathsFromInput(input: unknown): string[] {
  if (!isRecord(input)) return [];
  const out: string[] = [];
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value !== "" && !out.includes(value)) out.push(value);
  }
  return out;
}

// ---------------------------------------------------------------- line diff

type OpKind = "=" | "-" | "+";
interface Op {
  t: OpKind;
  text: string;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function diffOps(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const ops: Op[] = [];
  for (let i = 0; i < start; i += 1) ops.push({ t: "=", text: a[i] });
  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  if (ma.length * mb.length > MAX_DP_CELLS) {
    for (const text of ma) ops.push({ t: "-", text });
    for (const text of mb) ops.push({ t: "+", text });
  } else {
    const width = mb.length + 1;
    const dp = new Uint32Array((ma.length + 1) * width);
    for (let i = ma.length - 1; i >= 0; i -= 1) {
      for (let j = mb.length - 1; j >= 0; j -= 1) {
        dp[i * width + j] =
          ma[i] === mb[j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < ma.length && j < mb.length) {
      if (ma[i] === mb[j]) {
        ops.push({ t: "=", text: ma[i] });
        i += 1;
        j += 1;
      } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
        ops.push({ t: "-", text: ma[i] });
        i += 1;
      } else {
        ops.push({ t: "+", text: mb[j] });
        j += 1;
      }
    }
    for (; i < ma.length; i += 1) ops.push({ t: "-", text: ma[i] });
    for (; j < mb.length; j += 1) ops.push({ t: "+", text: mb[j] });
  }
  for (let i = endA; i < a.length; i += 1) ops.push({ t: "=", text: a[i] });
  return ops;
}

/**
 * A unified diff with a real line diff and several hunks. Line numbers count from the start of the
 * snippet (the tool input carries no file offsets). Empty string when nothing differs.
 */
export function lineDiff(path: string, before: string, after: string, context = CONTEXT): string {
  const ops = diffOps(splitLines(before), splitLines(after));
  const changed: number[] = [];
  ops.forEach((op, index) => {
    if (op.t !== "=") changed.push(index);
  });
  if (changed.length === 0) return "";

  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let o = 0;
  let n = 0;
  for (const op of ops) {
    oldBefore.push(o);
    newBefore.push(n);
    if (op.t !== "+") o += 1;
    if (op.t !== "-") n += 1;
  }

  const groups: [number, number][] = [];
  let s = changed[0];
  let e = changed[0];
  for (const k of changed.slice(1)) {
    if (k - e - 1 <= 2 * context) e = k;
    else {
      groups.push([s, e]);
      s = k;
      e = k;
    }
  }
  groups.push([s, e]);

  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const [gs, ge] of groups) {
    const from = Math.max(0, gs - context);
    const to = Math.min(ops.length - 1, ge + context);
    const slice = ops.slice(from, to + 1);
    const oldCount = slice.filter((op) => op.t !== "+").length;
    const newCount = slice.filter((op) => op.t !== "-").length;
    const oldStart = oldCount === 0 ? oldBefore[from] : oldBefore[from] + 1;
    const newStart = newCount === 0 ? newBefore[from] : newBefore[from] + 1;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) out.push(`${op.t === "=" ? " " : op.t}${op.text}`);
  }
  return out.join("\n");
}

/** One before/after edit. Single-line pairs keep before/after (the reader derives the diff). */
function pairEdit(path: string, before: string, after: string): FileEdit {
  const edit: FileEdit = { path, before, after };
  if (before.includes("\n") || after.includes("\n")) {
    const diff = lineDiff(path, before, after);
    if (diff !== "") edit.diff = diff;
  }
  return edit;
}

// ------------------------------------------------------- SEARCH/REPLACE blocks

/** Cline and Cursor style `<<<<<<< SEARCH` ... `=======` ... `>>>>>>> REPLACE` blocks. */
function searchReplaceBlocks(diff: string): { before: string; after: string }[] {
  const blocks: { before: string; after: string }[] = [];
  let mode: "none" | "search" | "replace" = "none";
  let search: string[] = [];
  let replace: string[] = [];
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (mode === "none") {
      if (line.startsWith("<<<<<<< SEARCH")) {
        mode = "search";
        search = [];
        replace = [];
      }
    } else if (mode === "search") {
      if (line.trim() === "=======") mode = "replace";
      else search.push(line);
    } else if (line.startsWith(">>>>>>> REPLACE")) {
      blocks.push({ before: search.join("\n"), after: replace.join("\n") });
      mode = "none";
    } else {
      replace.push(line);
    }
  }
  return blocks;
}

// ------------------------------------------------------------------ apply_patch

interface PatchSection {
  verb: "Update" | "Add" | "Delete";
  path: string;
  moveTo?: string;
  lines: string[];
}

function patchSections(command: string): PatchSection[] {
  const lines = command.replace(/\r\n/g, "\n").split("\n");
  const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch");
  if (begin < 0) return [];
  const end = lines.findIndex((line, index) => index > begin && line.trim() === "*** End Patch");
  if (end < 0) return [];
  const sections: PatchSection[] = [];
  let current: PatchSection | null = null;
  for (const line of lines.slice(begin + 1, end)) {
    const header = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (header) {
      current = { verb: header[1] as PatchSection["verb"], path: header[2].trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move) {
      current.moveTo = move[1].trim();
      continue;
    }
    if (line.startsWith("*** End of File")) continue;
    current.lines.push(line);
  }
  return sections;
}

function updateDiff(from: string, to: string, body: string[]): string {
  const hunks: { label: string; lines: string[] }[] = [];
  let hunk: { label: string; lines: string[] } | null = null;
  for (const line of body) {
    if (line.startsWith("@@")) {
      hunk = { label: line.slice(2).trim(), lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      hunk = { label: "", lines: [] };
      hunks.push(hunk);
    }
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) hunk.lines.push(line);
    else hunk.lines.push(` ${line}`);
  }
  const out: string[] = [`--- a/${from}`, `+++ b/${to}`];
  for (const h of hunks) {
    if (h.lines.length === 0) continue;
    const oldCount = h.lines.filter((l) => !l.startsWith("+")).length;
    const newCount = h.lines.filter((l) => !l.startsWith("-")).length;
    const label = h.label === "" ? "" : ` ${h.label}`;
    out.push(`@@ -${oldCount === 0 ? 0 : 1},${oldCount} +${newCount === 0 ? 0 : 1},${newCount} @@${label}`);
    out.push(...h.lines);
  }
  return out.join("\n");
}

function patchEdit(section: PatchSection): FileEdit {
  if (section.verb === "Add") {
    const added = section.lines.filter((line) => line.startsWith("+"));
    const out = ["--- /dev/null", `+++ b/${section.path}`];
    if (added.length > 0) out.push(`@@ -0,0 +1,${added.length} @@`, ...added);
    return { path: section.path, diff: out.join("\n") };
  }
  if (section.verb === "Delete") {
    return { path: section.path, diff: [`--- a/${section.path}`, "+++ /dev/null"].join("\n") };
  }
  const to = section.moveTo ?? section.path;
  return { path: to, diff: updateDiff(section.path, to, section.lines) };
}

function commandText(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (!isRecord(input)) return undefined;
  for (const key of ["command", "cmd"]) {
    const value = input[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) return value.join(" ");
  }
  return undefined;
}

function applyPatch(input: unknown): ToolPresentation | undefined {
  const command = commandText(input);
  if (command === undefined || !command.includes("apply_patch")) return undefined;
  const sections = patchSections(command);
  if (sections.length === 0) return undefined;
  const edits = sections.map(patchEdit);
  return {
    name: "apply_patch",
    inputSummary: sections.map((s) => `${s.verb} ${s.moveTo ?? s.path}`).join(", "),
    edits,
    paths: edits.map((edit) => edit.path),
  };
}

// ------------------------------------------------------------ per-tool shapes

const PAIR_EDIT_TOOLS = new Set(["Edit", "edit", "replace", "edit_file"]);
const WRITE_TOOLS = new Set(["Write", "write", "write_file", "write_to_file", "create_file"]);

function oldNew(input: Record<string, unknown>): { before: string; after: string } | undefined {
  const before = str(input.old_string) ?? str(input.oldString) ?? str(input.old_str);
  const after = str(input.new_string) ?? str(input.newString) ?? str(input.new_str);
  return before !== undefined && after !== undefined ? { before, after } : undefined;
}

function editsFor(name: string, input: Record<string, unknown>): FileEdit[] | undefined {
  const path = firstString(input, PATH_KEYS);
  if (path === undefined) return undefined;

  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const edits: FileEdit[] = [];
    for (const item of input.edits) {
      if (!isRecord(item)) continue;
      const pair = oldNew(item);
      if (pair) edits.push(pairEdit(path, pair.before, pair.after));
    }
    return edits.length > 0 ? edits : undefined;
  }
  if (PAIR_EDIT_TOOLS.has(name)) {
    const pair = oldNew(input);
    if (pair) return [pairEdit(path, pair.before, pair.after)];
  }
  if ((name === "replace_in_file" || name === "edit_file") && typeof input.diff === "string") {
    const blocks = searchReplaceBlocks(input.diff);
    return blocks.length > 0 ? blocks.map((b) => pairEdit(path, b.before, b.after)) : undefined;
  }
  if (WRITE_TOOLS.has(name) && typeof input.content === "string") {
    return [{ path, after: input.content }];
  }
  if (name === "developer__text_editor") {
    if (input.command === "str_replace") {
      const pair = oldNew(input);
      if (pair) return [pairEdit(path, pair.before, pair.after)];
    }
    if (input.command === "write" && typeof input.file_text === "string") {
      return [{ path, after: input.file_text }];
    }
  }
  return undefined;
}

const STATES = { completed: "done", in_progress: "in_progress" } as const;

function planItems(input: unknown): PlanItem[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.todos)) return undefined;
  const items: PlanItem[] = [];
  for (const todo of input.todos) {
    if (!isRecord(todo) || typeof todo.content !== "string") continue;
    const status = typeof todo.status === "string" ? todo.status : "";
    const state = status === "completed" || status === "in_progress" ? STATES[status] : "pending";
    items.push({ text: todo.content, done: status === "completed", state });
  }
  return items.length > 0 ? items : undefined;
}

/** What the Folio shows for a tool call, derived from the call's name and input only. */
export function presentTool(name: string, input: unknown, root: string | null | undefined): ToolPresentation {
  const rel = (path: string) => relativePath(path, root);
  try {
    const patch = name === "command_execution" ? applyPatch(input) : undefined;
    if (patch) {
      const edits = patch.edits?.map((edit) => ({ ...edit, path: rel(edit.path) }));
      return { ...patch, edits, paths: patch.paths.map(rel) };
    }

    const present: ToolPresentation = { paths: pathsFromInput(input).map(rel) };
    if (!isRecord(input)) return present;

    if (name.toLowerCase() === "todowrite") {
      const items = planItems(input);
      if (items) {
        present.items = items;
        present.inputSummary = `${items.filter((i) => i.done).length} of ${items.length} done`;
      }
      return present;
    }
    if (name === "Task") {
      const kind = str(input.subagent_type)?.trim();
      if (kind) present.name = `Task (${kind})`;
      return present;
    }
    if (name === "developer__text_editor") {
      const path = firstString(input, PATH_KEYS);
      if (typeof input.command === "string" && path !== undefined) present.inputSummary = `${input.command} ${rel(path)}`;
    }
    const edits = editsFor(name, input);
    if (edits) present.edits = edits.map((edit) => ({ ...edit, path: rel(edit.path) }));
    return present;
  } catch {
    return { paths: [] };
  }
}

// ------------------------------------------------------------------- errors

const ERROR_TIERS: RegExp[] = [
  /^error(\[\w+\])?:/,
  /^\w*Error:/,
  /^[×✗✘]/,
  /\b(FAILED|FAIL|panicked)\b/,
  /\berror\b/i,
];

/** The first meaningful line of a failing output, for the error line of a note. */
export function errorLine(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  for (const tier of ERROR_TIERS) {
    const hit = lines.find((line) => tier.test(line));
    if (hit !== undefined) return hit;
  }
  return lines.find((line) => !/^Exit code \d+$/.test(line)) ?? lines[0] ?? "";
}

// ------------------------------------------------------- boilerplate results

/** What a tool call already shows elsewhere in its note, so a result line would only repeat it. */
export interface ResultContext {
  /** The note shows a diff for these paths (relative to the project root). */
  editPaths: string[];
  hasItems: boolean;
}

interface BoilerplateRule {
  /** Short name, for tests and for reading the list. */
  id: string;
  /**
   * The text left over once the standard acknowledgement is removed, or null when the output is not
   * that acknowledgement (so it is shown unchanged). Every pattern is anchored at the start of the
   * output and must end at a line break or the end of the output.
   */
  strip: (output: string, ctx: ResultContext) => string | null;
}

/** The rest after a matched head, only when the head ended its line. */
function afterLine(output: string, head: RegExp): string | null {
  const match = head.exec(output);
  if (!match) return null;
  const rest = output.slice(match[0].length);
  if (rest !== "" && !rest.startsWith("\n")) return null;
  return rest;
}

const CLAUDE_TODO = /^Todos have been modified successfully\.(?: Ensure that you continue to use the todo list to track your progress\.(?: Please proceed with the current tasks if applicable\.?)?)?/;
const CLAUDE_WRITE = /^File created successfully at: [^\n]+/;
const CLAUDE_EDIT = /^The file [^\n]+ has been updated\. Here's the result of running `cat -n` on a snippet of the edited file:/;
const CLINE_SAVE = /^The content was successfully saved to [^\n]+\./;
const OPENCODE_EDIT = /^Edit applied successfully\./;
const CODEX_PATCH = /^Success\. Updated the following files:\n((?:[AMD] [^\n]+\n?)+)/;
const SNIPPET_LINE = /^\s*\d+→/;

function sameFile(listed: string, shown: string): boolean {
  return listed === shown || shown.endsWith(`/${listed}`) || listed.endsWith(`/${shown}`);
}

function isTodoList(output: string): boolean {
  if (!output.startsWith("[")) return false;
  try {
    const parsed: unknown = JSON.parse(output);
    return (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((item) => isRecord(item) && typeof item.content === "string" && typeof item.status === "string")
    );
  } catch {
    return false;
  }
}

/** The standard "it worked" lines that agents print for their own tools. Shown results never include these. */
export const BOILERPLATE_RULES: BoilerplateRule[] = [
  { id: "claude-todowrite", strip: (output) => afterLine(output, CLAUDE_TODO) },
  { id: "claude-write", strip: (output) => afterLine(output, CLAUDE_WRITE) },
  {
    id: "claude-edit-snippet",
    // the numbered snippet only repeats what the diff of the note shows
    strip: (output, ctx) => {
      if (ctx.editPaths.length === 0) return null;
      const rest = afterLine(output, CLAUDE_EDIT);
      if (rest === null) return null;
      const lines = rest.split("\n");
      let first = 1;
      while (first < lines.length && SNIPPET_LINE.test(lines[first])) first += 1;
      return lines.slice(first).join("\n");
    },
  },
  { id: "cline-save", strip: (output) => afterLine(output, CLINE_SAVE) },
  { id: "opencode-edit", strip: (output) => afterLine(output, OPENCODE_EDIT) },
  {
    id: "opencode-todowrite",
    // the JSON list repeats the checklist of the note
    strip: (output, ctx) => (ctx.hasItems && isTodoList(output) ? "" : null),
  },
  {
    id: "codex-apply-patch",
    // only when every listed file has its diff in the note
    strip: (output, ctx) => {
      if (ctx.editPaths.length === 0) return null;
      const match = CODEX_PATCH.exec(output);
      if (!match) return null;
      const listed = match[1]
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.slice(2).trim());
      if (!listed.every((path) => ctx.editPaths.some((shown) => sameFile(path, shown)))) return null;
      return output.slice(match[0].length);
    },
  },
];

/**
 * The output with a standard acknowledgement removed: "" when nothing else is left, the remainder
 * (for example a linter warning) when there is more, null when the output is not boilerplate.
 * Callers must not pass an error result.
 */
export function stripBoilerplate(output: string, ctx: ResultContext): string | null {
  const text = output.replace(/\r\n/g, "\n");
  for (const rule of BOILERPLATE_RULES) {
    try {
      const rest = rule.strip(text, ctx);
      if (rest !== null) return rest.trim();
    } catch {
      // a rule that cannot decide shows the output unchanged
    }
  }
  return null;
}

// -------------------------------------------------------------- subagent results

/** Subagent tools: Claude "Task" (also shown as "Task (kind)"), "Agent", opencode "task". */
export function isSubagentTool(name: string): boolean {
  return /^(task|agent)(\s|$)/i.test(name);
}

const RULE_LINE = /^(-{3,}|\*{3,}|_{3,})$/;
const TABLE_SEPARATOR = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;

function tableCells(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => plainInline(cell))
    .filter((cell) => cell !== "");
}

function plainInline(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One readable line for a Markdown result: the first meaningful line with heading, quote and list
 * markers and inline markup removed; for a leading table, its header cells joined with " / " and
 * the row count. Empty string when there is nothing to show.
 */
export function readableResult(markdown: string): string {
  const lines = markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim());
  const at = lines.findIndex((line) => line !== "" && !RULE_LINE.test(line) && !line.startsWith("```"));
  if (at < 0) return "";
  const line = lines[at];
  if (line.startsWith("|")) {
    const cells = tableCells(line);
    let summary = cells.join(" / ");
    if (TABLE_SEPARATOR.test(lines[at + 1] ?? "") && (lines[at + 1] ?? "").includes("-")) {
      let rows = 0;
      for (let i = at + 2; i < lines.length && lines[i].startsWith("|"); i += 1) rows += 1;
      summary += `, ${rows} ${rows === 1 ? "row" : "rows"}`;
    }
    return summary;
  }
  return plainInline(line.replace(/^#{1,6}\s+/, "").replace(/^>\s*/, "").replace(/^[-*+]\s+/, ""));
}
