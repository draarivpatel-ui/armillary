import type { ReactNode } from "react";
import { Fragment } from "react";
import type { BlockPlan, FolioBlock, MarginalNote } from "./blockify";
import { parseMarkdown, type Block, type Inline } from "./markdown";
import { highlight } from "./highlight";

export interface Unit {
  key: string;
  text: string;
  blockIndex: number;
}

export interface FindMatch {
  unit: string;
  blockIndex: number;
  start: number;
  end: number;
}

export interface FindState {
  query: string;
  matches: FindMatch[];
  byUnit: Map<string, FindMatch[]>;
  byBlock: Map<number, number[]>;
  active: number;
}

export const EMPTY_FIND: FindState = {
  query: "",
  matches: [],
  byUnit: new Map(),
  byBlock: new Map(),
  active: -1,
};

/** Keys are shared by the renderer and the finder so a hit always lands on the right piece of text. */
export const keys = {
  block: (prefix: string, index: number) => `${prefix}-${index}`,
  inline: (base: string, child: number) => `${base}-${child}`,
  code: (base: string) => `${base}-code`,
  token: (base: string, token: number) => `${base}-code-${token}`,
  unitPrefix: (blockIndex: number) => `k-${blockIndex}`,
  title: (blockIndex: number) => `t-${blockIndex}`,
  note: (name: string, seq: number, part: string, extra = "") => `n-${name}-${seq}-${part}${extra}`,
  diff: (seq: number, edit: number, line: number) => `d-${seq}-${edit}-${line}`,
};

function inlineUnits(nodes: Inline[], base: string, blockIndex: number, out: Unit[]): void {
  nodes.forEach((node, index) => {
    const key = keys.inline(base, index);
    switch (node.type) {
      case "text":
      case "code":
      case "link":
        out.push({ key, text: node.type === "link" ? node.text : node.text, blockIndex });
        break;
      case "bold":
      case "italic":
        inlineUnits(node.children, key, blockIndex, out);
    }
  });
}

function blockUnits(block: Block, blockKey: string, blockIndex: number, out: Unit[]): void {
  switch (block.type) {
    case "heading":
    case "paragraph":
      inlineUnits(block.children, blockKey, blockIndex, out);
      break;
    case "code": {
      const codeKey = keys.code(blockKey);
      highlight(block.text, block.lang).forEach((token, index) => {
        out.push({ key: keys.token(codeKey, index), text: token.text, blockIndex });
      });
      break;
    }
    case "list":
      block.items.forEach((item, index) => {
        inlineUnits(item.children, `${blockKey}-${index}`, blockIndex, out);
      });
      break;
    case "checklist":
      block.items.forEach((item, index) => {
        out.push({ key: `${blockKey}-${index}`, text: item.text, blockIndex });
      });
      break;
    case "quote":
      block.blocks.forEach((inner, index) => {
        blockUnits(inner, keys.block(`${blockKey}q`, index), blockIndex, out);
      });
      break;
    case "rule":
      break;
  }
}

function noteUnits(note: MarginalNote, blockIndex: number, out: Unit[]): void {
  const name = note.id;
  out.push({ key: keys.note(name, note.seq, "tool"), text: note.tool, blockIndex });
  out.push({ key: keys.note(name, note.seq, "input"), text: note.input, blockIndex });
  out.push({ key: keys.note(name, note.seq, "result"), text: note.result, blockIndex });
  note.files.forEach((file, index) => {
    out.push({ key: keys.note(name, note.seq, "file", `-${index}`), text: file, blockIndex });
  });
  if (note.error) out.push({ key: keys.note(name, note.seq, "error"), text: note.error, blockIndex });
  note.plan?.items.forEach((item, index) => {
    out.push({ key: keys.note(name, note.seq, "plan", `-${index}`), text: item.text, blockIndex });
  });
  note.edits.forEach((edit, editIndex) => {
    edit.lines.forEach((line, lineIndex) => {
      out.push({ key: keys.diff(note.seq, editIndex, lineIndex), text: line.text, blockIndex });
    });
  });
}

/** Every searchable piece of text in reading order, keyed exactly as the renderer emits it. */
export function collectUnits(plan: BlockPlan): Unit[] {
  const out: Unit[] = [];
  const notesByAnchor = new Map<number, MarginalNote[]>();
  for (const note of plan.marginalia) {
    if (note.anchorIndex === null) continue;
    const bucket = notesByAnchor.get(note.anchorIndex) ?? [];
    bucket.push(note);
    notesByAnchor.set(note.anchorIndex, bucket);
  }

  for (const block of plan.blocks) {
    if (block.kind === "prompt" && block.title) {
      out.push({ key: keys.title(block.index), text: block.title, blockIndex: block.index });
    }
    parseMarkdown(block.bodyText).forEach((inner, index) => {
      blockUnits(inner, keys.block(keys.unitPrefix(block.index), index), block.index, out);
    });
    for (const note of notesByAnchor.get(block.index) ?? []) {
      noteUnits(note, block.index, out);
    }
  }
  return out;
}

function occurrences(text: string, query: string): { start: number; end: number }[] {
  if (!query) return [];
  const needle = query.toLowerCase();
  const haystack = text.toLowerCase();
  const found: { start: number; end: number }[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    found.push({ start: index, end: index + needle.length });
    index = haystack.indexOf(needle, index + needle.length);
  }
  return found;
}

export function buildFind(plan: BlockPlan, query: string, active: number): FindState {
  const trimmed = query.trim();
  if (trimmed.length === 0) return { ...EMPTY_FIND, active: -1 };
  const units = collectUnits(plan);
  const matches: FindMatch[] = [];
  const byUnit = new Map<string, FindMatch[]>();
  const byBlock = new Map<number, number[]>();

  for (const unit of units) {
    for (const found of occurrences(unit.text, trimmed)) {
      const match: FindMatch = { unit: unit.key, blockIndex: unit.blockIndex, ...found };
      const list = byUnit.get(unit.key) ?? [];
      list.push(match);
      byUnit.set(unit.key, list);
      const index = matches.push(match) - 1;
      const blockList = byBlock.get(unit.blockIndex) ?? [];
      blockList.push(index);
      byBlock.set(unit.blockIndex, blockList);
    }
  }

  return { query: trimmed, matches, byUnit, byBlock, active };
}

/** Wrap the matched ranges of one text piece in marks. */
export function decorate(key: string, text: string, find: FindState): ReactNode {
  const hits = find.byUnit.get(key);
  if (!hits || hits.length === 0 || !find.query) return text;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  hits.forEach((match, index) => {
    const matchIndex = find.matches.indexOf(match);
    nodes.push(<Fragment key={`p-${index}`}>{text.slice(cursor, match.start)}</Fragment>);
    nodes.push(
      <mark
        key={`m-${index}`}
        className={matchIndex === find.active ? "folio-mark folio-mark--active" : "folio-mark"}
        data-find-match={matchIndex === find.active ? "active" : "true"}
      >
        {text.slice(match.start, match.end)}
      </mark>,
    );
    cursor = match.end;
  });
  nodes.push(<Fragment key="tail">{text.slice(cursor)}</Fragment>);
  return nodes;
}

export function blocksWithMatches(find: FindState): Set<number> {
  return new Set(find.matches.map((match) => match.blockIndex));
}

export function findTitleOf(block: FolioBlock): string {
  return block.title ?? "";
}
