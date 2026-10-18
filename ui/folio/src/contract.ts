/**
 * Adapter from the Armillary contract (ordered content blocks) to the Folio render model.
 * Unknown stays unknown (null); nothing here invents a value.
 */
import type { ContentBlock, Message as ContractMessage, Session as ContractSession } from "@armillary/model";
import type { FileEdit, Message, MessageRole, Session, SessionStatus, ToolCall } from "./types";
import { errorLine, isSubagentTool, presentTool, readableResult, relativePath, stripBoilerplate } from "./toolPresentation";

const INPUT_LIMIT = 160;
const RESULT_LIMIT = 240;
const SUMMARY_KEYS = ["command", "cmd", "file_path", "path", "filePath", "target_file", "pattern", "query", "url", "description"];
const PATH_SUMMARY_KEYS = new Set(["file_path", "path", "filePath", "target_file"]);

function mapStatus(status: string): SessionStatus {
  switch (status) {
    case "working":
    case "waiting":
    case "idle":
    case "done":
    case "unknown":
      return status;
    case "completed":
    case "complete":
    case "ended":
    case "finished":
      return "done";
    default:
      return "unknown";
  }
}

/** Cut to at most `max` characters, on a word boundary, ending in three dots. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const limit = max - 3;
  let end = limit;
  if (!/\s/.test(text[limit] ?? "")) {
    let space = -1;
    for (let i = limit - 1; i > 0; i -= 1) {
      if (/\s/.test(text[i])) {
        space = i;
        break;
      }
    }
    if (space > 0) end = space;
  }
  return `${text.slice(0, end).trimEnd()}...`;
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summariseInput(input: unknown, root: string | null): string {
  if (isRecord(input)) {
    for (const key of SUMMARY_KEYS) {
      const value = input[key];
      if (typeof value === "string" && value.trim() !== "") {
        const shown = PATH_SUMMARY_KEYS.has(key) ? relativePath(value, root) : value;
        return cut(shown.replace(/\s+/g, " ").trim(), INPUT_LIMIT);
      }
    }
  }
  return cut(compactJson(input).replace(/\s+/g, " ").trim(), INPUT_LIMIT);
}

function summariseOutput(output: unknown): string {
  return cut(typeof output === "string" ? output : compactJson(output), RESULT_LIMIT);
}

/** A code line that could close or reopen a fence gets one leading space. */
function fenceSafe(line: string): string {
  return /^```\s*$/.test(line) || line.startsWith("```") ? ` ${line}` : line;
}

function codeFence(code: string, language: string | null | undefined): string {
  const lang = typeof language === "string" && /^[A-Za-z0-9_+-]+$/.test(language) ? language : "";
  const body = code.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").map(fenceSafe).join("\n");
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

/** Body text of one contract message: text, code and checklist blocks, in order, blank-line separated. */
function bodyText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text.trim() !== "") parts.push(block.text);
    } else if (block.type === "code") {
      if (block.code !== "") parts.push(codeFence(block.code, block.language));
    } else if (block.type === "checklist") {
      if (block.items.length > 0) {
        parts.push(
          block.items.map((item) => `- [${item.checked ? "x" : " "}] ${item.text.replace(/\s*\r?\n\s*/g, " ")}`).join("\n"),
        );
      }
    }
  }
  return parts.join("\n\n");
}

function roleOf(role: string): MessageRole {
  return role === "user" || role === "system" ? role : "assistant";
}

export function fromContract(
  session: ContractSession,
  messages: ContractMessage[],
): { session: Session; messages: Message[]; toolCalls: ToolCall[] } {
  const folioSession: Session = {
    id: session.id,
    agent_id: session.agent_id,
    project_root: session.project_root ?? null,
    title: session.title ?? null,
    started_at: session.started_at ?? null,
    ended_at: session.ended_at ?? null,
    model: session.model ?? null,
    status: mapStatus(session.status),
    turns: session.turns,
    tokens_in: session.usage?.input_tokens ?? null,
    tokens_out: session.usage?.output_tokens ?? null,
    parent_id: session.parent_id ?? null,
  };

  const ordered = [...messages].sort((a, b) => a.seq - b.seq);
  const outMessages: Message[] = [];
  const toolCalls: ToolCall[] = [];
  const calls = new Map<string, ToolCall>();
  // calls whose only result was boilerplate: their summary is "" but they have been answered
  const answered = new WeakSet<ToolCall>();
  const root = folioSession.project_root;

  for (const message of ordered) {
    const at = message.at ?? null;
    const note = (call: Omit<ToolCall, "session_id" | "seq" | "at">): ToolCall => {
      const made: ToolCall = { session_id: message.session_id, seq: message.seq, ...call };
      if (at !== null) made.at = at;
      toolCalls.push(made);
      return made;
    };

    for (const block of message.blocks) {
      switch (block.type) {
        case "tool_call": {
          const shown = presentTool(block.name, block.input, root);
          const files = block.files.length > 0 ? block.files.map((f) => relativePath(f, root)) : shown.paths;
          const made = note({
            name: shown.name ?? block.name,
            input_summary: shown.inputSummary !== undefined ? cut(shown.inputSummary, INPUT_LIMIT) : summariseInput(block.input, root),
            result_summary: "",
            files,
            status: "ok",
          });
          if (shown.edits) made.edits = shown.edits;
          if (shown.items) made.items = shown.items;
          calls.set(block.call_id, made);
          break;
        }
        case "tool_result": {
          let summary = summariseOutput(block.output);
          const failed = block.is_error === true;
          const failure = failed ? cut(errorLine(typeof block.output === "string" ? block.output : compactJson(block.output)) || summary, RESULT_LIMIT) : "";
          const target = calls.get(block.call_id);
          if (target && target.result_summary === "" && target.status !== "error" && !answered.has(target)) {
            if (!failed && typeof block.output === "string") {
              const rest = stripBoilerplate(block.output, {
                editPaths: (target.edits ?? []).map((edit) => edit.path),
                hasItems: (target.items ?? []).length > 0,
              });
              if (rest !== null) {
                summary = cut(rest, RESULT_LIMIT);
                if (summary === "") answered.add(target);
              } else if (isSubagentTool(target.name) && block.output.trim() !== "") {
                const line = cut(readableResult(block.output), RESULT_LIMIT);
                if (line !== "") {
                  summary = line;
                  if (line !== block.output.trim()) target.resultMarkdown = block.output;
                }
              }
            }
            target.result_summary = summary;
            if (failed) {
              target.status = "error";
              target.error = failure;
            }
          } else {
            const made = note({
              name: "Result",
              input_summary: "",
              result_summary: summary,
              files: [],
              status: failed ? "error" : "ok",
            });
            if (failed) made.error = failure;
          }
          break;
        }
        case "edit": {
          const edit: FileEdit = { path: relativePath(block.path, root) };
          if (block.before != null) edit.before = block.before;
          if (block.after != null) edit.after = block.after;
          if (block.diff != null) edit.diff = block.diff;
          note({ name: "Edit", input_summary: "", result_summary: "", files: [relativePath(block.path, root)], edits: [edit] });
          break;
        }
        case "error":
          note({
            name: "Error",
            input_summary: "",
            result_summary: "",
            files: [],
            status: "error",
            error: block.code ? `${block.code}: ${block.message}` : block.message,
          });
          break;
        case "attachment":
          // reference only: it is shown as plain margin text and never becomes markdown
          note({
            name: "Attachment",
            input_summary: block.label ?? "attachment",
            result_summary: `${block.mime_type ?? "unknown type"}, reference only, not opened`,
            files: [block.reference],
          });
          break;
        default:
          break;
      }
    }

    const text = bodyText(message.blocks);
    if (text !== "") {
      outMessages.push({ session_id: message.session_id, seq: message.seq, role: roleOf(message.role), text, at });
    }
  }

  return { session: folioSession, messages: outMessages, toolCalls };
}

/** The seq of the message with this id, or null when it is not in the list. */
export function anchorSeqFor(messages: ContractMessage[], messageId: string): number | null {
  return messages.find((message) => message.id === messageId)?.seq ?? null;
}
