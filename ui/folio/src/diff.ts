import type { FileEdit } from "./types";

export type DiffLineKind = "add" | "del" | "hunk" | "ctx" | "header";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

/** Parse a unified diff into lines the reader can colour. */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const rawLines = diff.split("\n").filter((line, index, all) => !(line === "" && index === all.length - 1));
  const lines: DiffLine[] = [];
  const hunks: DiffHunk[] = [];
  let oldPath = "";
  let newPath = "";
  let oldNo = 0;
  let newNo = 0;
  let additions = 0;
  let deletions = 0;
  let current: DiffHunk | null = null;

  for (const raw of rawLines) {
    if (raw.startsWith("--- ")) {
      oldPath = raw.slice(4).trim();
      lines.push({ kind: "header", text: raw, oldLine: null, newLine: null });
      continue;
    }
    if (raw.startsWith("+++ ")) {
      newPath = raw.slice(4).trim();
      lines.push({ kind: "header", text: raw, oldLine: null, newLine: null });
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      current = { header: raw, lines: [] };
      hunks.push(current);
      lines.push({ kind: "hunk", text: raw, oldLine: null, newLine: null });
      continue;
    }
    if (raw.startsWith("+")) {
      additions += 1;
      const line: DiffLine = { kind: "add", text: raw.slice(1), oldLine: null, newLine: newNo++ };
      lines.push(line);
      current?.lines.push(line);
      continue;
    }
    if (raw.startsWith("-")) {
      deletions += 1;
      const line: DiffLine = { kind: "del", text: raw.slice(1), oldLine: oldNo++, newLine: null };
      lines.push(line);
      current?.lines.push(line);
      continue;
    }
    const line: DiffLine = {
      kind: "ctx",
      text: raw.startsWith(" ") ? raw.slice(1) : raw,
      oldLine: oldNo++,
      newLine: newNo++,
    };
    lines.push(line);
    current?.lines.push(line);
  }

  return { oldPath, newPath, hunks, additions, deletions, lines };
}

/** Build a unified diff body from a before/after pair. */
export function makeUnifiedDiff(path: string, before: string, after: string, context = 2): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const commonPrefix = (() => {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  })();
  const suffix = (() => {
    let n = 0;
    while (
      n < a.length - commonPrefix &&
      n < b.length - commonPrefix &&
      a[a.length - 1 - n] === b[b.length - 1 - n]
    )
      n++;
    return n;
  })();

  const removed = a.slice(commonPrefix, a.length - suffix);
  const added = b.slice(commonPrefix, b.length - suffix);
  const beforeContext = a.slice(Math.max(0, commonPrefix - context), commonPrefix);
  const afterContext = b.slice(b.length - suffix, Math.min(b.length, b.length - suffix + context));

  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  const startOld = Math.max(0, commonPrefix - context) + 1;
  const startNew = startOld;
  out.push(
    `@@ -${startOld},${beforeContext.length + removed.length + afterContext.length} +${startNew},${
      beforeContext.length + added.length + afterContext.length
    } @@`,
  );
  out.push(...beforeContext.map((line) => ` ${line}`));
  out.push(...removed.map((line) => `-${line}`));
  out.push(...added.map((line) => `+${line}`));
  out.push(...afterContext.map((line) => ` ${line}`));
  return out.join("\n");
}

/** Ensure an edit has a diff body, deriving one from before/after when needed. */
export function editDiff(edit: FileEdit): string {
  if (edit.diff && edit.diff.length > 0) return edit.diff;
  if (edit.before !== undefined || edit.after !== undefined) {
    return makeUnifiedDiff(edit.path, edit.before ?? "", edit.after ?? "");
  }
  return "";
}
