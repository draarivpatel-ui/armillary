/** Normalized session model, mirroring SPEC section 4. Times are Unix milliseconds. */

export type SessionStatus = "working" | "waiting" | "idle" | "done" | "unknown";

export type Theme = "dark" | "light";

export interface Session {
  id: string;
  agent_id: string;
  project_root: string | null;
  title: string | null;
  started_at: number | null;
  ended_at: number | null;
  model: string | null;
  status: SessionStatus;
  turns: number;
  tokens_in: number | null;
  tokens_out: number | null;
  parent_id: string | null;
}

export type MessageRole = "user" | "assistant" | "system";

export interface Message {
  session_id: string;
  seq: number;
  role: MessageRole;
  text: string;
  at: number | null;
}

/** A file edit shown as an expandable unified diff. */
export interface FileEdit {
  path: string;
  /** Unified diff body, newline separated. Optional; derived when before/after given. */
  diff?: string;
  before?: string;
  after?: string;
  additions?: number;
  deletions?: number;
}

export type ToolStatus = "ok" | "error";

export interface ToolCall {
  session_id: string;
  seq: number;
  name: string;
  input_summary: string;
  result_summary: string;
  /**
   * The full result as Markdown, for subagent (Task) results whose one-line summary is shorter than
   * the result. Rendered by the reader through the safe Markdown renderer, never as raw HTML.
   */
  resultMarkdown?: string;
  files: string[];
  /** Folio extensions (all optional, so the model stays SPEC-compatible). */
  edits?: FileEdit[];
  status?: ToolStatus;
  error?: string;
  /** Explicit checklist for plan / to-do tool calls. */
  items?: PlanItem[];
  /** A plan block may also arrive as raw markdown task list text. */
  text?: string;
  at?: number;
}

export interface PlanItem {
  text: string;
  done: boolean;
  /** Finer than `done`, when the tool records it (to-do lists with an in-progress item). */
  state?: "pending" | "in_progress" | "done";
}

export interface NormalizedSession {
  session: Session;
  messages: Message[];
  toolCalls: ToolCall[];
}
