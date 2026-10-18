/**
 * Archive client: sessions, ordered messages, search and imports, typed with the generated contract
 * (@armillary/model) plus the command shapes in ./types.
 *
 * With a core (the desktop app, or the presentation shim) every call goes to the real commands through
 * ./client. Without a core (plain browser preview, tests) a deterministic in-memory mock answers, and the
 * UI shows a "Demo data" mark (dataMode() === "mock"). The desktop app never falls back to mock data.
 *
 * Note: No em or en dashes in any user-facing strings or helpers.
 */

import type {
  Session,
  Message,
  ContentBlock,
  Usage,
  UsageSemantics,
  UsageObservation,
  SourceProvenance,
  Checkpoint,
  StoreIdentity,
  Evidence,
  Confidence,
  ImportDiagnostic,
} from "@armillary/model";
import type {
  HitKind,
  ImportProgress,
  ImportSummary,
  Page,
  SearchFilter,
  SearchHit,
  SearchPage,
  SessionFilter,
  SessionRow,
  TitleSource,
} from "./types";
import { call, isCoreAvailable, subscribe, type Unsubscribe } from "./client";
import type { Agent } from "./agents";

export type { Agent };
export type {
  Session,
  Message,
  ContentBlock,
  Usage,
  UsageSemantics,
  UsageObservation,
  SourceProvenance,
  Checkpoint,
  StoreIdentity,
  Evidence,
  Confidence,
  ImportDiagnostic,
};
export type {
  HitKind,
  ImportProgress,
  ImportSummary,
  Page,
  SearchFilter,
  SearchHit,
  SearchPage,
  SessionFilter,
  SessionRow,
  TitleSource,
};

/** Kept for older imports: a search hit is a SearchHit (plain text plus highlight ranges). */
export type SearchResult = SearchHit;

/** The core rejects pages larger than this. */
export const MAX_PAGE = 200;

export interface ArchiveClient {
  sessions_query(filter?: SessionFilter): Promise<Page<SessionRow>>;
  search(query: string, filter?: SearchFilter): Promise<SearchPage>;
  session_get(id: string): Promise<SessionRow | null>;
  messages_page(id: string, limit?: number, offset?: number): Promise<Page<Message>>;
}

// -----------------------------------------------------------------------------
// Formatters and Helpers (hyphen only, strictly no em or en dashes)
// -----------------------------------------------------------------------------

/**
 * "28m of activity" from the first and last recorded message times, for a session with no recorded end.
 * Activity is not an end: callers show it only when ended_at is unknown. Null when the span is unknown or empty.
 */
export function activitySpanLabel(row: { first_activity_at?: number | null; last_activity_at?: number | null }): string | null {
  const first = row.first_activity_at;
  const last = row.last_activity_at;
  if (first == null || last == null || last <= first) return null;
  const minutes = Math.round((last - first) / 60000);
  if (minutes < 1) return "under a minute of activity";
  if (minutes < 60) return `${minutes}m of activity`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h of activity` : `${hours}h ${rest}m of activity`;
}

/** The title to show: the native title, else the derived display title, else a plain fallback. */
export function sessionLabel(row: { title?: string | null; display_title?: string | null }): string {
  return row.title?.trim() || row.display_title?.trim() || "Untitled session";
}

export function formatDuration(startedAt?: number | null, endedAt?: number | null): string {
  if (!startedAt) {
    return "Unknown";
  }
  if (endedAt == null || endedAt < startedAt) {
    // Unknown stays unknown: without a recorded end the archive cannot tell a running session from one
    // that stopped without saying so.
    return "No end recorded";
  }
  const diffMs = endedAt - startedAt;
  const totalSecs = Math.floor(diffMs / 1000);
  if (totalSecs < 60) {
    return `${totalSecs}s`;
  }
  const minutes = Math.floor(totalSecs / 60);
  const seconds = totalSecs % 60;
  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

export function formatDateHeading(timestamp?: number | null): string {
  if (!timestamp) return "Unknown Date";
  const date = new Date(timestamp);
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function formatTime(timestamp?: number | null): string {
  if (!timestamp) return "--:--";
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function getProjectBasename(projectRoot?: string | null): string {
  if (!projectRoot) return "unknown";
  const normalized = projectRoot.replace(/[/\\]+$/, "");
  const parts = normalized.split(/[/\\]/);
  return parts[parts.length - 1] || projectRoot;
}

// -----------------------------------------------------------------------------
// Synthetic Seed Data
// -----------------------------------------------------------------------------

export function createSyntheticProvenance(
  agentId: string,
  sessionId: string,
  records: number
): SourceProvenance {
  return {
    adapter_id: agentId,
    adapter_version: "1.0.0",
    checkpoint: {
      digest: `mock-digest-${sessionId}`,
      offset: 0,
      records,
      revision: 1,
    },
    file_identity: `mock-file-${sessionId}`,
    generation: 1,
    source_id: `src-${sessionId}`,
    source_path: `projects/${agentId}/session-${sessionId}.jsonl`,
    store: {
      canonical_root: `/Users/dev/.${agentId}/sessions`,
      id: `store-${agentId}`,
      namespace: `${agentId}-history`,
      profile_id: "default",
    },
  };
}

export function createSyntheticUsage(inputTokens: number, outputTokens: number): Usage {
  return {
    semantics: "cumulative",
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    observations: [],
  };
}

// Reference anchor time: Monday, October 12, 2026 15:30:00 UTC
const ANCHOR_TIME = 1791819000000;

export const INITIAL_SYNTHETIC_SESSIONS: Session[] = [
  {
    id: "sess-001",
    agent_id: "claude-code",
    native_id: "cc-101",
    project_root: "/Users/dev/Products/agent-hub",
    title: "Work package P1 shell design and token verification",
    started_at: ANCHOR_TIME - 3600000 * 2, // Today 13:30
    ended_at: ANCHOR_TIME - 3600000 * 1.2, // ~48m
    model: "claude-3-5-sonnet",
    status: "done",
    turns: 18,
    usage: createSyntheticUsage(14210, 3180),
    provenance: createSyntheticProvenance("claude-code", "sess-001", 18),
    parent_id: null,
  },
  {
    id: "sess-002",
    agent_id: "codex-cli",
    native_id: "cx-202",
    project_root: "/Users/dev/Products/agent-hub",
    title: "SQLite archive indexing and FTS5 search optimization",
    started_at: ANCHOR_TIME - 3600000 * 4, // Today 11:30
    ended_at: ANCHOR_TIME - 3600000 * 3.4, // ~36m
    model: "o1-preview",
    status: "done",
    turns: 32,
    usage: createSyntheticUsage(48900, 9400),
    provenance: createSyntheticProvenance("codex-cli", "sess-002", 32),
    parent_id: null,
  },
  {
    id: "sess-003",
    agent_id: "cursor",
    native_id: "cur-303",
    project_root: "/Users/dev/Products/example-app",
    title: "TypeScript interface alignment and React 19 hooks",
    started_at: ANCHOR_TIME - 3600000 * 5, // Today 10:30
    ended_at: ANCHOR_TIME - 3600000 * 4.8, // ~12m
    model: "claude-3-5-sonnet",
    status: "closed",
    turns: 8,
    usage: createSyntheticUsage(9320, 1450),
    provenance: createSyntheticProvenance("cursor", "sess-003", 8),
    parent_id: null,
  },
  {
    id: "sess-004",
    agent_id: "claude-code",
    native_id: "cc-104",
    project_root: "/Users/dev/Products/armillary",
    title: "Celestial orrery canvas layout and orbital math",
    started_at: ANCHOR_TIME - 86400000 - 3600000 * 2, // Yesterday
    ended_at: ANCHOR_TIME - 86400000 - 3600000 * 0.5,
    model: "claude-3-5-sonnet",
    status: "done",
    turns: 26,
    usage: createSyntheticUsage(28400, 6200),
    provenance: createSyntheticProvenance("claude-code", "sess-004", 26),
    parent_id: null,
  },
  {
    id: "sess-005",
    agent_id: "gemini-cli",
    native_id: "gem-505",
    project_root: "/Users/dev/Products/armillary",
    title: "Adapter engine TOML declarations and path expansion",
    started_at: ANCHOR_TIME - 86400000 - 3600000 * 6, // Yesterday
    ended_at: ANCHOR_TIME - 86400000 - 3600000 * 5.2,
    model: "gemini-1.5-pro",
    status: "done",
    turns: 14,
    usage: createSyntheticUsage(18700, 3900),
    provenance: createSyntheticProvenance("gemini-cli", "sess-005", 14),
    parent_id: null,
  },
  {
    id: "sess-006",
    agent_id: "aider",
    native_id: "aid-606",
    project_root: "/Users/dev/Products/nous-hermes",
    title: "Benchmarking 100k message query and memory compaction",
    started_at: ANCHOR_TIME - 86400000 * 2 - 3600000 * 3, // 2 days ago
    ended_at: ANCHOR_TIME - 86400000 * 2 - 3600000 * 2.1,
    model: "gpt-4o",
    status: "closed",
    turns: 41,
    usage: createSyntheticUsage(64200, 11800),
    provenance: createSyntheticProvenance("aider", "sess-006", 41),
    parent_id: null,
  },
  {
    id: "sess-007",
    agent_id: "claude-code",
    native_id: "cc-107",
    project_root: "/Users/dev/Products/agent-hub",
    title: "User prompt refinement for Folio reader checklists",
    started_at: ANCHOR_TIME - 3600000 * 0.5, // Active recently
    ended_at: null,
    model: "claude-3-5-sonnet",
    status: "active",
    turns: 6,
    usage: createSyntheticUsage(7200, 1400),
    provenance: createSyntheticProvenance("claude-code", "sess-007", 6),
    parent_id: null,
  },
];

export interface SyntheticMessageRecord {
  session_id: string;
  seq: number;
  kind: HitKind;
  text: string;
  at: number;
}

export const INITIAL_SYNTHETIC_MESSAGES: SyntheticMessageRecord[] = [
  {
    session_id: "sess-001",
    seq: 1,
    kind: "message",
    text: "Claude Code: Build the Observatory design system tokens and test contrast ratios for WCAG AA compliance.",
    at: ANCHOR_TIME - 3600000 * 2,
  },
  {
    session_id: "sess-001",
    seq: 2,
    kind: "tool",
    text: "view_file: design/src/tokens.ts checked WCAG AA contrast for star and dust across ink-0 ink-1 and ink-2.",
    at: ANCHOR_TIME - 3600000 * 1.9,
  },
  {
    session_id: "sess-001",
    seq: 3,
    kind: "message",
    text: "Verified 4.5:1 contrast for all dark and day almanac pairs; tuned light dust to guarantee compliance.",
    at: ANCHOR_TIME - 3600000 * 1.8,
  },
  {
    session_id: "sess-007",
    seq: 1,
    kind: "message",
    text: "Claude Code: Review source code changes and interactive checklist states in Folio.",
    at: ANCHOR_TIME - 3600000 * 0.5,
  },
  {
    session_id: "sess-004",
    seq: 2,
    kind: "tool",
    text: "read_file: design/src/orrery-layout.ts confirmed the orbit radii for five project suns.",
    at: ANCHOR_TIME - 86400000 - 3600000 * 1.9,
  },
  {
    session_id: "sess-006",
    seq: 1,
    kind: "message",
    text: "Review the Folio parchment design and the marginalia spacing for long tool output.",
    at: ANCHOR_TIME - 86400000 * 2,
  },
  {
    session_id: "sess-002",
    seq: 1,
    kind: "message",
    text: "Implement SQLite FTS5 search index with BM25 ranking and snippet generation.",
    at: ANCHOR_TIME - 3600000 * 4,
  },
  {
    session_id: "sess-002",
    seq: 2,
    kind: "tool",
    text: "run_command: cargo test -p orrery-archive passed 17 tests with sub-millisecond search latency.",
    at: ANCHOR_TIME - 3600000 * 3.7,
  },
  {
    session_id: "sess-003",
    seq: 1,
    kind: "message",
    text: "Align TypeScript interface definitions with Rust Serde models in crates/archive/src/model.rs.",
    at: ANCHOR_TIME - 3600000 * 5,
  },
  {
    session_id: "sess-004",
    seq: 1,
    kind: "message",
    text: "Draw the solar system view on Canvas 2D with rotating planetary orbits and vermilion halos.",
    at: ANCHOR_TIME - 86400000 - 3600000 * 2,
  },
  {
    session_id: "sess-005",
    seq: 1,
    kind: "message",
    text: "Add TOML declarative adapter support for Claude Code and Codex CLI history files.",
    at: ANCHOR_TIME - 86400000 - 3600000 * 6,
  },
];

/**
 * Generate N synthetic sessions deterministically for virtualization stress testing.
 */
export function generateSyntheticSessions(count: number): Session[] {
  const agents = ["claude-code", "codex-cli", "cursor", "gemini-cli", "aider"];
  const projects = [
    "/Users/dev/Products/agent-hub",
    "/Users/dev/Products/armillary",
    "/Users/dev/Products/example-app",
    "/Users/dev/Products/nous-hermes",
    "/Users/dev/Products/celestial-core",
  ];
  const models = [
    "claude-3-5-sonnet",
    "o1-preview",
    "gpt-4o",
    "gemini-1.5-pro",
    "claude-3-haiku",
  ];
  const statuses = ["done", "closed", "active", "waiting", "idle"];
  const titles = [
    "Refactor SQLite schema and migrations",
    "Optimize canvas frame rendering speed",
    "Verify WCAG AA contrast on light theme",
    "Parse JSONL transcript entries into archive",
    "Add keyboard shortcuts for navigation",
    "Implement virtual scroll for 10,000 sessions",
    "Clean up stray em and en dashes in UI copy",
    "Export session markdown with redaction pass",
    "Calculate planetary coordinates along orbit",
    "Benchmark search latency under high load",
  ];
  const sampleFiles = [
    "src/App.tsx",
    "src/tokens.ts",
    "crates/archive.rs",
    "SPEC.md",
    "src/api/archive.ts",
    "design/primitives.css",
  ];

  const sessions: Session[] = [];
  const baseTime = ANCHOR_TIME;

  for (let i = 0; i < count; i++) {
    const dayOffset = Math.floor(i / 15);
    const minuteOffset = (i % 15) * 45;
    const started = baseTime - dayOffset * 86400000 - minuteOffset * 60000;
    const durationMs = 120000 + ((i * 37) % 7200000); // between 2m and 2h
    const ended = i % 12 === 0 ? null : started + durationMs;
    const status = ended === null ? "active" : statuses[i % statuses.length];

    const fileCount = 1 + (i % 4);
    const touched: string[] = [];
    for (let f = 0; f < fileCount; f++) {
      touched.push(sampleFiles[(i + f) % sampleFiles.length]);
    }

    const id = `synthetic-${i.toString().padStart(6, "0")}`;
    const agentId = agents[i % agents.length];
    const turns = 2 + (i % 50);
    const tokensIn = 1000 + ((i * 123) % 80000);
    const tokensOut = 200 + ((i * 47) % 15000);

    sessions.push({
      id,
      agent_id: agentId,
      native_id: `nat-${i}`,
      project_root: projects[i % projects.length],
      title: `${titles[i % titles.length]} #${i + 1}`,
      started_at: started,
      ended_at: ended,
      model: models[i % models.length],
      status,
      turns,
      usage: createSyntheticUsage(tokensIn, tokensOut),
      provenance: createSyntheticProvenance(agentId, id, turns),
      parent_id: null,
    });
  }

  return sessions;
}

// -----------------------------------------------------------------------------
// Display title (mirrors the core: app/src-tauri/src/archive_api.rs derive_display_title)
// -----------------------------------------------------------------------------

/** Longest display title in characters, including a trailing "...". */
export const DISPLAY_TITLE_MAX = 70;

/**
 * A title from a first prompt: its first sentence or first line, whichever is shorter, whitespace
 * collapsed, at most 70 characters (cut at a word boundary with a plain "..."). Null when blank.
 */
export function deriveDisplayTitle(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const collapse = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");
  const line = collapse(trimmed.split("\n")[0]);
  const whole = [...collapse(trimmed)];
  let end = whole.length;
  for (let i = 0; i < whole.length; i++) {
    if (".!?".includes(whole[i]) && (i + 1 === whole.length || whole[i + 1] === " ")) {
      end = i + 1;
      break;
    }
  }
  const sentence = whole.slice(0, end).join("");
  const chosen = [...(([...line].length <= [...sentence].length ? line : sentence))];
  if (chosen.length <= DISPLAY_TITLE_MAX) return chosen.join("");
  const budget = DISPLAY_TITLE_MAX - 3;
  let cut = budget;
  if (chosen[budget] !== " ") {
    const space = chosen.slice(0, budget).lastIndexOf(" ");
    if (space > 0) cut = space;
  }
  return `${chosen.slice(0, cut).join("").trimEnd()}...`;
}

// -----------------------------------------------------------------------------
// Highlights (plain text plus UTF-16 ranges; never HTML)
// -----------------------------------------------------------------------------

export interface HighlightSegment {
  text: string;
  hit: boolean;
}

/**
 * Split plain text into highlighted and plain segments. Ranges are [start, end) JavaScript string
 * indices (UTF-16 code units). Out of range, empty, overlapping or unsorted ranges are tolerated.
 * Render each segment as a text node (inside <mark> when hit): never as HTML.
 */
export function highlightSegments(text: string, highlights: ReadonlyArray<readonly [number, number]>): HighlightSegment[] {
  const clamp = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(Math.trunc(n), text.length)) : 0);
  const ranges = highlights
    .map(([a, b]) => [clamp(a), clamp(b)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out: HighlightSegment[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    const from = Math.max(start, cursor);
    if (end <= from) continue;
    if (from > cursor) out.push({ text: text.slice(cursor, from), hit: false });
    const last = out[out.length - 1];
    if (last && last.hit && from === cursor) last.text += text.slice(from, end);
    else out.push({ text: text.slice(from, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
  return out;
}

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Find every case-insensitive occurrence of any term; returns sorted, merged ranges. */
function findRanges(text: string, terms: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    if (!term) continue;
    const regex = new RegExp(escapeRegExp(term), "gi");
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      ranges.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) regex.lastIndex++;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

// -----------------------------------------------------------------------------
// In-memory mock archive (only without a core)
// -----------------------------------------------------------------------------

/** Contract messages for a mock session, built from the synthetic records. */
export function syntheticMessagesFor(sessionId: string, records = INITIAL_SYNTHETIC_MESSAGES): Message[] {
  return records
    .filter((r) => r.session_id === sessionId)
    .sort((a, b) => a.seq - b.seq)
    .map((r) => {
      const blocks: ContentBlock[] =
        r.kind === "tool"
          ? [
              {
                type: "tool_call",
                call_id: `${sessionId}-call-${r.seq}`,
                name: r.text.split(":")[0] || "tool",
                input: { description: r.text.split(":").slice(1).join(":").trim() },
                files: [],
              },
            ]
          : [{ type: "text", text: r.text }];
      return {
        id: `${sessionId}-m${r.seq}`,
        session_id: sessionId,
        seq: r.seq,
        role: r.seq === 1 ? "user" : "assistant",
        at: r.at,
        blocks,
      };
    });
}

export class MockArchiveClient implements ArchiveClient {
  private sessions: Session[];
  private messages: SyntheticMessageRecord[];

  constructor(sessions: Session[] = INITIAL_SYNTHETIC_SESSIONS, messages = INITIAL_SYNTHETIC_MESSAGES) {
    this.sessions = [...sessions];
    this.messages = [...messages];
  }

  /** The session with the derived fields the core adds (display title and activity span). */
  private row(session: Session): SessionRow {
    const records = this.messages.filter((m) => m.session_id === session.id);
    const times = records.map((m) => m.at).filter((t) => Number.isFinite(t));
    let display_title: string | null = null;
    let title_source: TitleSource | null = null;
    if (session.title != null && session.title.trim() !== "") {
      display_title = session.title;
      title_source = "native";
    } else {
      for (const m of syntheticMessagesFor(session.id, this.messages)) {
        if (m.role !== "user") continue;
        const block = m.blocks.find((b) => b.type === "text" && b.text.trim() !== "");
        const derived = block && block.type === "text" ? deriveDisplayTitle(block.text) : null;
        if (derived) {
          display_title = derived;
          title_source = "first_prompt";
          break;
        }
      }
    }
    return {
      ...session,
      display_title,
      title_source,
      first_activity_at: times.length ? Math.min(...times) : null,
      last_activity_at: times.length ? Math.max(...times) : null,
    };
  }

  async session_get(id: string): Promise<SessionRow | null> {
    const session = this.sessions.find((s) => s.id === id);
    return session ? this.row(session) : null;
  }

  async messages_page(id: string, limit = 100, offset = 0): Promise<Page<Message>> {
    const all = syntheticMessagesFor(id, this.messages);
    return { items: all.slice(offset, offset + limit), total: all.length, limit, offset };
  }

  async sessions_query(filter?: SessionFilter): Promise<Page<SessionRow>> {
    const limit = filter?.limit ?? 50;
    const offset = filter?.offset ?? 0;
    let filtered = [...this.sessions];

    if (filter?.agent) {
      filtered = filtered.filter((s) => s.agent_id === filter.agent);
    }
    if (filter?.project) {
      const p = filter.project.toLowerCase();
      filtered = filtered.filter((s) => (s.project_root || "").toLowerCase().includes(p));
    }
    if (filter?.status) {
      filtered = filtered.filter((s) => s.status.toLowerCase() === filter.status?.toLowerCase());
    }
    if (filter?.model) {
      filtered = filtered.filter((s) => (s.model || "").toLowerCase().includes(filter.model!.toLowerCase()));
    }
    if (filter?.from !== undefined) {
      filtered = filtered.filter((s) => s.started_at != null && s.started_at >= filter.from!);
    }
    if (filter?.to !== undefined) {
      filtered = filtered.filter((s) => s.started_at != null && s.started_at <= filter.to!);
    }

    // Newest first: started_at DESC (unknown last), id ASC
    filtered.sort((a, b) => {
      const aTime = a.started_at ?? -Infinity;
      const bTime = b.started_at ?? -Infinity;
      if (bTime !== aTime) return bTime > aTime ? 1 : -1;
      return a.id.localeCompare(b.id);
    });

    return { items: filtered.slice(offset, offset + limit).map((s) => this.row(s)), total: filtered.length, limit, offset };
  }

  async search(query: string, filter?: SearchFilter): Promise<SearchPage> {
    const limit = filter?.limit ?? 20;
    const offset = filter?.offset ?? 0;
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return { items: [], limit, offset, has_more: false };

    const hits: SearchHit[] = [];
    for (const msg of this.messages) {
      const session = this.sessions.find((s) => s.id === msg.session_id);
      if (!session) continue;
      if (filter?.agent && session.agent_id !== filter.agent) continue;
      if (filter?.project && !(session.project_root ?? "").toLowerCase().includes(filter.project.toLowerCase())) continue;
      if (filter?.from !== undefined && msg.at < filter.from) continue;
      if (filter?.to !== undefined && msg.at > filter.to) continue;
      const ranges = findRanges(msg.text, terms);
      if (ranges.length === 0) continue;
      const matched = terms.filter((t) => msg.text.toLowerCase().includes(t)).length;
      hits.push({
        session_id: msg.session_id,
        message_id: `${msg.session_id}-m${msg.seq}`,
        seq: msg.seq,
        block_index: 0,
        kind: msg.kind,
        at: msg.at,
        score: Number((matched * 1.5 + (terms.length / (msg.text.length + 1)) * 50).toFixed(2)),
        text: msg.text,
        highlights: ranges,
        agent_id: session.agent_id,
        project_root: session.project_root ?? null,
        session_title: session.title ?? null,
        session_started_at: session.started_at ?? null,
      });
    }
    hits.sort((a, b) => b.score - a.score || (b.at ?? 0) - (a.at ?? 0));
    const items = hits.slice(offset, offset + limit);
    return { items, limit, offset, has_more: hits.length > offset + limit };
  }
}

// -----------------------------------------------------------------------------
// Core archive client (desktop app or presentation shim)
// -----------------------------------------------------------------------------

export class CoreArchiveClient implements ArchiveClient {
  async sessions_query(filter: SessionFilter = {}): Promise<Page<SessionRow>> {
    return call<Page<SessionRow>>("sessions_query", { query: filter });
  }

  async search(query: string, filter: SearchFilter = {}): Promise<SearchPage> {
    return call<SearchPage>("search", { input: { query, ...filter } });
  }

  async session_get(id: string): Promise<SessionRow | null> {
    try {
      return await call<SessionRow>("session_get", { id });
    } catch (err) {
      if ((err as { code?: string }).code === "not_found") return null;
      throw err;
    }
  }

  async messages_page(id: string, limit = 100, offset = 0): Promise<Page<Message>> {
    return call<Page<Message>>("messages_page", { id, limit, offset });
  }
}

let overrideClient: ArchiveClient | null = null;
const mockClient = new MockArchiveClient();
const coreClient = new CoreArchiveClient();

/** The core client when a core is available, otherwise the mock (never a silent fallback on errors). */
export function getArchiveClient(): ArchiveClient {
  if (overrideClient) return overrideClient;
  return isCoreAvailable() ? coreClient : mockClient;
}

export function setArchiveClient(client: ArchiveClient): void {
  overrideClient = client;
}

export function resetArchiveClient(): void {
  overrideClient = null;
}

export function createMockArchiveClient(sessions?: Session[]): ArchiveClient {
  return new MockArchiveClient(sessions);
}

// -----------------------------------------------------------------------------
// Module API used by the views
// -----------------------------------------------------------------------------

export async function sessionsQuery(filter?: SessionFilter): Promise<Page<SessionRow>> {
  return getArchiveClient().sessions_query(filter);
}

/** Every session matching the filter, fetched page by page (MAX_PAGE each), up to `max`. */
export async function sessionsQueryAll(filter: SessionFilter = {}, max = 5000): Promise<Page<SessionRow>> {
  const items: SessionRow[] = [];
  let offset = filter.offset ?? 0;
  let total = 0;
  for (;;) {
    const page = await getArchiveClient().sessions_query({ ...filter, limit: MAX_PAGE, offset });
    total = page.total;
    items.push(...page.items);
    offset += page.items.length;
    if (page.items.length === 0 || offset >= total || items.length >= max) break;
  }
  return { items: items.slice(0, max), total, limit: items.length, offset: filter.offset ?? 0 };
}

export async function sessionGet(id: string): Promise<SessionRow | null> {
  return getArchiveClient().session_get(id);
}

export async function messagesPage(id: string, limit = 100, offset = 0): Promise<Page<Message>> {
  return getArchiveClient().messages_page(id, limit, offset);
}

/**
 * A session's messages in seq order, page by page. Calls onPage after every page so a reader can
 * render the first page at once. Stops at `max` messages.
 */
export async function loadSessionMessages(
  id: string,
  options: { pageSize?: number; max?: number; onPage?: (soFar: Message[], total: number) => void } = {},
): Promise<{ messages: Message[]; total: number; truncated: boolean }> {
  const pageSize = Math.min(options.pageSize ?? MAX_PAGE, MAX_PAGE);
  const max = options.max ?? 20000;
  const messages: Message[] = [];
  let total = 0;
  for (;;) {
    const page = await messagesPage(id, pageSize, messages.length);
    total = page.total;
    messages.push(...page.items);
    options.onPage?.([...messages], total);
    if (page.items.length === 0 || messages.length >= total || messages.length >= max) break;
  }
  return { messages: messages.slice(0, max), total, truncated: total > max };
}

export async function searchPage(query: string, filter?: SearchFilter): Promise<SearchPage> {
  return getArchiveClient().search(query, filter);
}

/** One page of hits as a list (use searchPage for has_more). */
export async function searchHits(query: string, filter?: SearchFilter): Promise<SearchHit[]> {
  return (await searchPage(query, filter)).items;
}

/** Run an import now (all agents, or one). Progress arrives on onImportProgress. Needs a core. */
export async function importNow(agentId?: string | null): Promise<ImportSummary> {
  return call<ImportSummary>("import_now", { agentId: agentId ?? null });
}

/** Diagnostics for one source key, or the newest ones across sources. Needs a core. */
export async function importDiagnostics(sourceKey?: string | null): Promise<ImportDiagnostic[]> {
  return call<ImportDiagnostic[]>("import_diagnostics", { sourceKey: sourceKey ?? null });
}

export function onImportProgress(handler: (progress: ImportProgress) => void): Promise<Unsubscribe> {
  return subscribe<ImportProgress>("import:progress", handler);
}

// Older names kept for existing views and tests.
export const sessions_query = sessionsQuery;
export const session_get = sessionGet;
export const messages_page = messagesPage;
export const search = searchHits;
