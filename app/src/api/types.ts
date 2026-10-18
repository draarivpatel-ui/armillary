/**
 * Shapes of the core's command inputs and outputs that are NOT part of the frozen data contract.
 * Everything that IS contract data (Session, Message, ContentBlock, Live, Agent, ImportDiagnostic, ...)
 * comes from the generated types in @armillary/model and is only re-exported here.
 */

import type {
  Agent,
  ContentBlock,
  ImportDiagnostic,
  Live,
  LiveState,
  Message,
  Session,
} from "@armillary/model";

export type { Agent, ContentBlock, ImportDiagnostic, Live, LiveState, Message, Session };

/** Where a session's display_title came from. */
export type TitleSource = "native" | "first_prompt";

/**
 * What sessions_query and session_get return: the contract Session (its fields stay at the top level,
 * `title` still null when the agent gave none) plus fields the core derives. `display_title` is the
 * native title, else a title cut from the first user text (at most 70 characters), else null.
 * `first_activity_at` and `last_activity_at` are the smallest and largest message time (null when no
 * message has a time). They are activity times, never an end: only `ended_at` says a session ended.
 */
export type SessionRow = Session & {
  display_title: string | null;
  title_source: TitleSource | null;
  first_activity_at: number | null;
  last_activity_at: number | null;
};

/** One page of results (sessions_query, messages_page). */
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** sessions_query input. Times are Unix milliseconds on started_at. */
export interface SessionFilter {
  agent?: string;
  project?: string;
  from?: number;
  to?: number;
  status?: string;
  model?: string;
  /** 1 to 200 (the core rejects anything else). */
  limit?: number;
  offset?: number;
}

/** search input filter (the query string is passed separately). */
export interface SearchFilter {
  agent?: string;
  project?: string;
  from?: number;
  to?: number;
  /** 1 to 200. */
  limit?: number;
  offset?: number;
}

export type HitKind = "message" | "tool";

/**
 * One search hit. `text` is plain text (never HTML); `highlights` are [start, end) ranges in UTF-16
 * code units, i.e. JavaScript string indices into `text`. Render with highlightSegments().
 */
export interface SearchHit {
  session_id: string;
  message_id: string;
  seq: number;
  block_index: number;
  kind: HitKind;
  at: number | null;
  score: number;
  text: string;
  highlights: Array<[number, number]>;
  agent_id: string;
  project_root: string | null;
  session_title: string | null;
  /** The native title, else one derived from the session's first prompt; null when neither exists. */
  session_display_title?: string | null;
  session_started_at: number | null;
}

export interface SearchPage {
  items: SearchHit[];
  limit: number;
  offset: number;
  has_more: boolean;
}

/** Where to open a session in the Folio. */
export interface SessionAnchor {
  message_id?: string;
  seq?: number;
  block_index?: number;
}

/**
 * `import:progress` payload (importer.rs ImportPayload, the same shape as the first run's import
 * events). Per agent: "started", then "progress" as sessions are imported, then "finished" (or
 * "error" when that agent's run fails). A run is bracketed by two events with an empty `agentId`:
 * "started" before the first agent and "finished" after the last (counts are run totals).
 */
export interface ImportProgress {
  /** Adapter id; "" on the run-level "started" and "finished" events. */
  agentId: string;
  phase: "started" | "progress" | "finished" | "error";
  /** Sessions accepted into the archive so far. */
  sessionsImported: number;
  /** Sessions discovered so far (grows while sources are listed). */
  sessionsKnown: number;
  /** First source read error, or the failure reason for phase "error". */
  error: string | null;
  /** Project folder basenames of the agent's sessions (agent "finished" only). */
  projects: string[];
}

/** import_now result. */
export interface ImportSummary {
  adapters: number;
  sessions: number;
  messages: number;
}

/** agents_list entry (app/src-tauri/src/agents.rs AgentEntry): catalogue data plus what was found on this machine. */
export interface AgentEntry extends Agent {
  installed: boolean;
  version: string | null;
  data_paths: string[];
  default_data_paths: string[];
  coverage: string[];
  docs_url: string | null;
  homepage?: string | null;
}

/** `live:update` payload: the detector's full current list (omission means the session is no longer live). */
export type LiveUpdate = Live[];

export type { LiveState as ContractLiveState };
