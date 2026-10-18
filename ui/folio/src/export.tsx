import { renderToStaticMarkup } from "react-dom/server";
import { buildBlocks, type FolioBlock, type MarginalNote } from "./blockify";
import { Row } from "./components/Row";
import { EMPTY_FIND } from "./find";
import { redact, redactionSummary, type RedactionLabel } from "./redact";
import { FOLIO_CSS } from "./styles/stylesheet";
import type { Message, NormalizedSession, Session, Theme, ToolCall } from "./types";

export type ExportFormat = "markdown" | "html";

export interface ExportResult {
  format: ExportFormat;
  name: string;
  contents: string;
  redacted: boolean;
}

export interface ExportOptions {
  /** Paths, emails, tokens and keys are masked unless the reader turns this off. */
  redact?: boolean;
  theme?: Theme;
}

/** 41 min, 1 h 12 min, "still open", or "duration unknown" when the start is not known. */
export function formatDuration(startedAt: number | null, endedAt: number | null): string {
  if (startedAt === null) return "duration unknown";
  if (endedAt === null || endedAt <= startedAt) return "still open";
  const minutes = Math.round((endedAt - startedAt) / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Unknown stays unknown: a missing title, model or token count is never shown as blank or 0. */
export function titleLabel(session: Pick<Session, "title">): string {
  return session.title === null || session.title.trim() === "" ? "Untitled session" : session.title;
}

export function modelLabel(session: Pick<Session, "model">): string {
  return session.model === null || session.model === "" ? "model unknown" : session.model;
}

export function tokensLabel(session: Pick<Session, "tokens_in" | "tokens_out">): string {
  if (session.tokens_in === null || session.tokens_out === null) return "tokens unknown";
  return `${session.tokens_in.toLocaleString("en-US")} in / ${session.tokens_out.toLocaleString("en-US")} out`;
}

function redactMessage(message: Message): Message {
  return { ...message, text: redact(message.text) };
}

function redactToolCall(call: ToolCall): ToolCall {
  return {
    ...call,
    input_summary: redact(call.input_summary),
    result_summary: redact(call.result_summary),
    files: call.files.map(redact),
    error: call.error ? redact(call.error) : call.error,
    text: call.text ? redact(call.text) : call.text,
    items: call.items?.map((item) => ({ ...item, text: redact(item.text) })),
    edits: call.edits?.map((edit) => ({
      ...edit,
      path: redact(edit.path),
      diff: edit.diff ? redact(edit.diff) : edit.diff,
      before: edit.before ? redact(edit.before) : edit.before,
      after: edit.after ? redact(edit.after) : edit.after,
    })),
  };
}

function redactedSession(session: NormalizedSession): NormalizedSession {
  return {
    session: {
      ...session.session,
      title: session.session.title === null ? null : redact(session.session.title),
      project_root: session.session.project_root === null ? null : redact(session.session.project_root),
    },
    messages: session.messages.map(redactMessage),
    toolCalls: session.toolCalls.map(redactToolCall),
  };
}

function prepare(session: NormalizedSession, redaction: boolean): NormalizedSession {
  return redaction ? redactedSession(session) : session;
}

function notesByAnchor(plan: ReturnType<typeof buildBlocks>): Map<number, MarginalNote[]> {
  const map = new Map<number, MarginalNote[]>();
  for (const note of plan.marginalia) {
    if (note.anchorIndex === null) continue;
    const bucket = map.get(note.anchorIndex) ?? [];
    bucket.push(note);
    map.set(note.anchorIndex, bucket);
  }
  return map;
}

function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim() !== "") ?? "").trim();
}

/** A backtick fence longer than any backtick run in the body, so content can never close it early. */
function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

function blockMarkdown(block: FolioBlock): string {
  if (block.kind === "prompt") {
    const heading = `## ${firstLine(block.text)}`;
    return block.bodyText ? `${heading}\n\n${block.bodyText}` : heading;
  }
  if (block.kind === "system") return `> ${block.bodyText}`;
  return block.bodyText;
}

function noteMarkdown(note: MarginalNote): string {
  const mark = note.isError ? "[!]" : "[note]";
  const lines: string[] = [];
  const tail = note.result ? ` (${note.result})` : "";
  lines.push(`${mark} ${note.tool}: ${note.input}${tail}`);
  if (note.error && note.error !== note.result) lines.push(`${mark} ${note.tool} stopped: ${note.error}`);
  for (const file of note.files) lines.push(`${mark} file: ${file}`);
  if (note.plan) {
    lines.push("#### Plan");
    for (const item of note.plan.items) {
      lines.push(`- [${item.done ? "x" : " "}] ${item.text}`);
    }
  }
  for (const edit of note.edits) {
    const body = edit.raw.trimEnd();
    const fence = fenceFor(body);
    lines.push(`${fence}diff\n${body}\n${fence}`);
  }
  return lines.join("\n");
}

function usageLine(session: NormalizedSession["session"]): string {
  return [
    `**model** ${modelLabel(session)}`,
    `**agent** ${session.agent_id}`,
    tokensLabel(session),
    `${session.turns} turns`,
    formatDuration(session.started_at, session.ended_at),
  ].join(" . ");
}

function summaryLine(labels: RedactionLabel[], counts: Record<RedactionLabel, number>): string {
  const parts = labels.filter((label) => counts[label] > 0).map((label) => `${counts[label]} ${label}`);
  return parts.length > 0 ? `Redaction pass: ${parts.join(", ")} masked.` : "Redaction pass: nothing to mask.";
}

/** The session as a Markdown document. Tool calls stay marginal: they follow the block they happened under. */
export function exportMarkdown(session: NormalizedSession, options: ExportOptions = {}): string {
  const redaction = options.redact ?? true;
  const source = prepare(session, redaction);
  const plan = buildBlocks(source.messages, source.toolCalls);
  const notes = notesByAnchor(plan);

  const parts: string[] = [`# ${titleLabel(source.session)}`];
  for (const block of plan.blocks) {
    parts.push(blockMarkdown(block));
    for (const note of notes.get(block.index) ?? []) parts.push(noteMarkdown(note));
  }
  parts.push(`---\n\n${usageLine(source.session)}`);

  if (redaction) {
    const joined = [session.session.title ?? "", ...session.messages.map((m) => m.text), ...session.toolCalls.map(summaryOf)]
      .join("\n");
    const { counts } = redactionSummary(joined);
    parts.push(summaryLine(["path", "email", "key", "token"], counts));
  }

  return parts.filter((part) => part !== "").join("\n\n") + "\n";
}

function summaryOf(call: ToolCall): string {
  return [call.input_summary, call.result_summary, call.error ?? "", call.files.join(" ")].join(" ");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

/** A single HTML file: the same page markup with the stylesheet inlined and every diff open. */
export function exportHtml(session: NormalizedSession, options: ExportOptions = {}): string {
  const redaction = options.redact ?? true;
  // Theme lands in attributes, so it is narrowed to the closed set whatever the caller passes.
  const theme: Theme = options.theme === "light" ? "light" : "dark";
  const source = prepare(session, redaction);
  const plan = buildBlocks(source.messages, source.toolCalls);
  const notes = notesByAnchor(plan);

  const page = renderToStaticMarkup(
    <div className="folio-shell folio-shell--no-rail" data-theme={theme}>
      <header className="folio-head">
        <div>
          <h1 className="folio-head__title">{titleLabel(source.session)}</h1>
          <p className="folio-head__meta">{`${source.session.agent_id} . ${modelLabel(source.session)} . ${source.session.turns} turns`}</p>
        </div>
      </header>
      <article className="folio-page folio-page--static" data-surface="parchment" data-type-scale="folio">
        {plan.blocks.map((block) => (
          <Row
            key={block.id}
            block={block}
            notes={notes.get(block.index) ?? []}
            find={EMPTY_FIND}
            diffDefaultOpen
            interactiveDiffs={false}
          />
        ))}
      </article>
      <footer className="folio-foot" role="contentinfo">
        <span className="folio-foot__model">{modelLabel(source.session)}</span>
        <span className="folio-foot__count">{tokensLabel(source.session)}</span>
        <span className="folio-foot__item">{`${source.session.turns} turns`}</span>
        <span className="folio-foot__item">{formatDuration(source.session.started_at, source.session.ended_at)}</span>
      </footer>
    </div>,
  );

  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    // First in <head>: this file is read offline from disk, so it may load nothing and run nothing.
    `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(titleLabel(source.session))}</title>`,
    "<style>",
    FOLIO_CSS,
    "</style>",
    "</head>",
    `<body data-theme="${theme}">`,
    `<div class="folio-export-doc" data-theme="${theme}">`,
    page,
    "</div>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
