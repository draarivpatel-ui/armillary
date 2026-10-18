import { imagePlaceholderText } from "./links";

/** The Markdown subset the Folio needs: headings, paragraphs, lists, task lists, quotes, rules, code fences and inline marks. */

export type Inline =
  | { type: "text"; text: string }
  | { type: "bold"; children: Inline[] }
  | { type: "italic"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string }
  /** `![alt](src)`. The source is kept for the record but never rendered, fetched or put in an attribute. */
  | { type: "image"; alt: string; src: string };

export interface ListItem {
  text: string;
  children: Inline[];
}

export interface ChecklistItem extends ListItem {
  done: boolean;
}

export type Block =
  | { type: "heading"; level: number; text: string; children: Inline[] }
  | { type: "paragraph"; text: string; children: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; items: ListItem[] }
  | { type: "checklist"; items: ChecklistItem[] }
  | { type: "quote"; blocks: Block[] }
  | { type: "rule" };

const HEADING = /^(#{1,6})\s+(.+)$/;
const RULE = /^(-{3,}|\*{3,}|_{3,})$/;
const FENCE = /^```\s*([A-Za-z0-9_+-]*)\s*$/;
const LIST_ITEM = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const TASK_ITEM = /^\[([ xX])\]\s*(.*)$/;

/**
 * Finds the next occurrence of a pattern at or after a position. Positions only ever move
 * forward while one string is parsed, so the last answer is reused until it is passed. That keeps
 * a line of 50,000 unmatched "[" linear instead of scanning to the end for each one.
 */
function forwardFinder(source: string, pattern: string | RegExp): (from: number) => number {
  let lastFrom = -1;
  let found = -2;
  const matcher = typeof pattern === "string" ? null : new RegExp(pattern.source, "g");
  const literal = typeof pattern === "string" ? pattern : "";
  return (from) => {
    if (found !== -2 && from >= lastFrom && (found === -1 || found >= from)) return found;
    lastFrom = from;
    if (matcher) {
      matcher.lastIndex = from;
      const hit = matcher.exec(source);
      found = hit ? hit.index : -1;
    } else {
      found = source.indexOf(literal, from);
    }
    return found;
  };
}

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  let i = 0;

  const nextBacktick = forwardFinder(source, "`");
  const nextBold = forwardFinder(source, "**");
  const nextStar = forwardFinder(source, "*");
  const nextUnderscore = forwardFinder(source, "_");
  const nextBracket = forwardFinder(source, "]");
  const nextTargetEnd = forwardFinder(source, /[)\s]/);

  const flush = () => {
    if (buffer.length > 0) {
      out.push({ type: "text", text: buffer });
      buffer = "";
    }
  };

  /** `[label](target)` with `open` at the "[". Same shape as the old regex: no "]" in the label, no ")" or space in the target. */
  const bracketed = (open: number): { label: string; target: string; end: number } | null => {
    const close = nextBracket(open + 1);
    if (close === -1 || source[close + 1] !== "(") return null;
    const end = nextTargetEnd(close + 2);
    if (end === -1 || source[end] !== ")") return null;
    return { label: source.slice(open + 1, close), target: source.slice(close + 2, end), end: end + 1 };
  };

  while (i < source.length) {
    const char = source[i];
    if (char === "`") {
      const close = nextBacktick(i + 1);
      if (close > i) {
        flush();
        out.push({ type: "code", text: source.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }
    if (char === "*" && source[i + 1] === "*") {
      const close = nextBold(i + 2);
      if (close > i) {
        flush();
        out.push({ type: "bold", children: parseInline(source.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }
    if (char === "*" || (char === "_" && !/\w/.test(source[i - 1] ?? " "))) {
      const close = char === "*" ? nextStar(i + 1) : nextUnderscore(i + 1);
      const before = source[close - 1] ?? "";
      const after = source[close + 1] ?? "";
      const usable = close > i + 1 && !(char === "_" && /\w/.test(before + after));
      if (usable) {
        flush();
        out.push({ type: "italic", children: parseInline(source.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    }
    if (char === "!" && source[i + 1] === "[") {
      const image = bracketed(i + 1);
      if (image) {
        flush();
        out.push({ type: "image", alt: image.label, src: image.target });
        i = image.end;
        continue;
      }
    }
    if (char === "[") {
      const link = bracketed(i);
      if (link) {
        flush();
        out.push({ type: "link", text: link.label, href: link.target });
        i = link.end;
        continue;
      }
    }
    buffer += char;
    i += 1;
  }
  flush();
  return out;
}

/** Plain text of an inline tree, used for headings, titles and exports. */
export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text") return node.text;
      if (node.type === "code") return node.text;
      if (node.type === "link") return node.text;
      if (node.type === "image") return imagePlaceholderText(node.alt);
      return inlineText(node.children);
    })
    .join("");
}

function parseList(lines: string[], start: number): { blocks: Block[]; next: number } {
  const items: ChecklistItem[] = [];
  let taskSeen = 0;
  let ordered = false;
  let index = start;

  while (index < lines.length) {
    const match = LIST_ITEM.exec(lines[index]);
    if (!match) {
      // continuation line: an indented block that keeps the text flowing
      if (/^\s{2,}\S/.test(lines[index]) && items.length > 0) {
        const extra = lines[index].trim();
        const last = items[items.length - 1];
        last.text = `${last.text} ${extra}`;
        last.children = parseInline(last.text);
        index += 1;
        continue;
      }
      break;
    }
    if (index === start) ordered = match[3] !== undefined;
    else if (ordered !== (match[3] !== undefined)) break;
    let body = match[4];
    const task = TASK_ITEM.exec(body);
    if (task) {
      taskSeen += 1;
      body = task[2];
      items.push({ text: body, children: parseInline(body), done: task[1].toLowerCase() === "x" });
    } else {
      items.push({ text: body, children: parseInline(body), done: false });
    }
    index += 1;
  }

  if (taskSeen > 0) {
    return {
      blocks: [{ type: "checklist", items }],
      next: index,
    };
  }
  return { blocks: [{ type: "list", ordered, items }], next: index };
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const lang = fence[1];
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ type: "code", lang, text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const text = heading[2].trim();
      blocks.push({ type: "heading", level: heading[1].length, text, children: parseInline(text) });
      index += 1;
      continue;
    }

    if (RULE.test(line.trim())) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    if (line.startsWith(">")) {
      const inner: string[] = [];
      while (index < lines.length && lines[index].startsWith(">")) {
        inner.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", blocks: parseMarkdown(inner.join("\n")) });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const parsed = parseList(lines, index);
      blocks.push(...parsed.blocks);
      index = parsed.next;
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() !== "" &&
      !HEADING.test(lines[index]) &&
      !FENCE.test(lines[index]) &&
      !LIST_ITEM.test(lines[index]) &&
      !lines[index].startsWith(">") &&
      !RULE.test(lines[index].trim())
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    const text = paragraph.join(" ");
    blocks.push({ type: "paragraph", text, children: parseInline(text) });
  }

  return blocks;
}
