/**
 * Live client for the Orrery: contract Live observations from the core's live detector (`live_list` and
 * the `live:update` event), joined with archived sessions to place planets around project suns.
 * Without a core (browser preview, tests) a typed mock answers and the UI marks it as demo data.
 * Note: NO em or en dashes in user-facing text.
 */
import type {
  Live,
  LiveState,
  Confidence,
  Evidence,
  ProcessIdentity,
  LiveAction,
  LiveMutation,
  Session,
} from "@armillary/model";
import { call, isCoreAvailable, subscribe, type Unsubscribe } from "./client";
import { sessionGet } from "./archive";
import { agentsList } from "./agents";

export type {
  Live,
  LiveState,
  Confidence,
  Evidence,
  ProcessIdentity,
  LiveAction,
  LiveMutation,
};

export type AgentFamily =
  | "anthropic"
  | "openai"
  | "google"
  | "github"
  | "cursor"
  | "open-source"
  | "chinese"
  | "other";

export interface LiveProject {
  id: string;
  name: string;
  root: string;
}

export interface LiveSession {
  id: string;
  agent_id: string;
  family: AgentFamily;
  project_root: string;
  title: string;
  /** Turns from the archive; 0 (planet size only) when the session is not archived yet. */
  turns: number;
  /** False when the live session is not in the archive yet: title, project and turns are unknown. */
  archived?: boolean;
  activity: number; // 0.0 to 1.0
  state: LiveState;
  waiting_since?: number; // Unix ms
  parent_id?: string; // Subagent parent session ID
  started_at?: number;
}

export interface LiveTelemetry {
  activePlanets: number;
  needsYou: number;
  working: number;
  idle: number;
  done: number;
  /** Live observations whose state is unknown (no evidence either way). */
  unknown?: number;
}

export interface LiveListResult {
  projects: LiveProject[];
  sessions: LiveSession[];
  telemetry: LiveTelemetry;
}

/**
 * Returns mock Live observations conforming to the frozen contract armillary.cf.v1.
 */
export function getMockLive(): Live[] {
  const now = Date.now();
  return [
    {
      session_id: "sess-hub-claude",
      state: "waiting",
      since: now - 42000,
      observed_at: now,
      confidence: "high",
      process: { pid: 1001, started_at: now - 3600000 },
      evidence: [
        {
          kind: "native_waiting_signal",
          detail: "permission_prompt: User confirmation requested",
          native_event_id: null,
          at: now - 42000,
        },
      ],
      expires_at: now + 300000,
    },
    {
      session_id: "sess-hub-sub1",
      state: "working",
      since: now - 120000,
      observed_at: now,
      confidence: "high",
      process: { pid: 1002, started_at: now - 1800000 },
      evidence: [
        {
          kind: "process_and_activity",
          detail: "claude process running with active output",
          native_event_id: null,
          at: now - 5000,
        },
      ],
      expires_at: now + 300000,
    },
    {
      session_id: "sess-hub-done",
      state: "done",
      since: now - 600000,
      observed_at: now,
      confidence: "medium",
      process: null,
      evidence: [
        {
          kind: "process_exit",
          detail: "Process exited normally",
          native_event_id: null,
          at: now - 600000,
        },
      ],
      expires_at: null,
    },
    {
      session_id: "sess-astro-idle",
      state: "idle",
      since: now - 300000,
      observed_at: now,
      confidence: "medium",
      process: { pid: 1003, started_at: now - 7200000 },
      evidence: [
        {
          kind: "process_idle",
          detail: "No activity for >120s",
          native_event_id: null,
          at: now - 300000,
        },
      ],
      expires_at: now + 300000,
    },
  ];
}

/** The detector's current list: from the core, or the typed mock without one. Core errors are not hidden. */
export async function liveList(): Promise<Live[]> {
  if (!isCoreAvailable()) return getMockLive();
  return call<Live[]>("live_list");
}

/** Older name kept for existing callers. */
export const live_list = liveList;

/** `live:update`: the detector's full current list whenever it changes. */
export function onLiveUpdate(handler: (list: Live[]) => void): Promise<Unsubscribe> {
  return subscribe<Live[]>("live:update", handler);
}

/** agents_list family names onto the Orrery's planet families. */
export function orreryFamily(family: string | undefined): AgentFamily {
  switch (family) {
    case "anthropic":
    case "openai":
    case "google":
    case "cursor":
      return family;
    case "github":
    case "github-microsoft":
      return "github";
    case "open-source":
    case "open-source-clis":
      return "open-source";
    case "chinese":
    case "chinese-labs":
      return "chinese";
    default:
      return "other";
  }
}

const ACTIVITY: Record<LiveState, number> = { working: 0.85, waiting: 0.5, idle: 0.15, unknown: 0.1, done: 0 };

function basename(root: string): string {
  const parts = root.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || root;
}

/**
 * Join live observations with archived sessions (by contract session id) and agent families.
 * A live session that is not archived yet keeps an unknown project and title; nothing is invented.
 * "Needs you" is only the detector's waiting state (a reliable native waiting signal).
 */
export function buildLiveModel(
  lives: Live[],
  sessions: Map<string, Session>,
  families: Map<string, string>,
): LiveListResult {
  const projects = new Map<string, LiveProject>();
  const out: LiveSession[] = [];
  for (const live of lives) {
    const s = sessions.get(live.session_id);
    const root = s?.project_root ?? "";
    if (!projects.has(root)) {
      projects.set(root, { id: root || "unknown-project", name: root ? basename(root) : "unknown project", root });
    }
    const agentId = s?.agent_id ?? "unknown";
    const entry: LiveSession = {
      id: live.session_id,
      agent_id: agentId,
      family: orreryFamily(families.get(agentId)),
      project_root: root,
      title: s?.title ?? "Untitled session",
      turns: s?.turns ?? 0,
      archived: Boolean(s),
      activity: ACTIVITY[live.state] ?? 0,
      state: live.state,
    };
    if (live.state === "waiting" && live.since != null) entry.waiting_since = live.since;
    if (s?.parent_id) entry.parent_id = s.parent_id;
    if (s?.started_at != null) entry.started_at = s.started_at;
    out.push(entry);
  }
  const count = (state: LiveState) => out.filter((x) => x.state === state).length;
  return {
    projects: [...projects.values()],
    sessions: out,
    telemetry: {
      activePlanets: out.filter((x) => x.state !== "done" && !x.parent_id).length,
      needsYou: count("waiting"),
      working: count("working"),
      idle: count("idle"),
      done: count("done"),
      unknown: count("unknown"),
    },
  };
}

/**
 * Synthetic mock live data representing 4 projects and live multi-agent activity for Orrery view.
 */
export function getMockLiveList(): LiveListResult {
  const now = Date.now();

  const projects: LiveProject[] = [
    { id: "proj-1", name: "agent-hub", root: "~/Projects/agent-hub" },
    { id: "proj-2", name: "astrolabe-core", root: "~/Projects/astrolabe-core" },
    { id: "proj-3", name: "quantum-sim", root: "~/Projects/quantum-sim" },
    { id: "proj-4", name: "compiler-pass", root: "~/Projects/compiler-pass" },
  ];

  const sessions: LiveSession[] = [
    // Project 1: agent-hub
    {
      id: "sess-hub-claude",
      agent_id: "claude-code",
      family: "anthropic",
      project_root: "~/Projects/agent-hub",
      title: "Work package F5 implementation",
      turns: 21,
      activity: 0.88,
      state: "waiting",
      waiting_since: now - 42000, // 42s ago
    },
    {
      id: "sess-hub-sub1",
      agent_id: "research",
      family: "anthropic",
      project_root: "~/Projects/agent-hub",
      title: "Codebase symbols check",
      turns: 8,
      activity: 0.65,
      state: "working",
      parent_id: "sess-hub-claude",
    },
    {
      id: "sess-hub-done",
      agent_id: "gemini-cli",
      family: "google",
      project_root: "~/Projects/agent-hub",
      title: "P1 token verification",
      turns: 14,
      activity: 0.0,
      state: "done",
    },

    // Project 2: astrolabe-core
    {
      id: "sess-astro-cursor",
      agent_id: "cursor-agent",
      family: "cursor",
      project_root: "~/Projects/astrolabe-core",
      title: "Coordinate rotation refactor",
      turns: 12,
      activity: 0.72,
      state: "working",
    },
    {
      id: "sess-astro-waiting",
      agent_id: "claude-opus",
      family: "anthropic",
      project_root: "~/Projects/astrolabe-core",
      title: "Precision bounds review",
      turns: 16,
      activity: 0.8,
      state: "waiting",
      waiting_since: now - 75000, // 1m 15s ago
    },
    {
      id: "sess-astro-idle",
      agent_id: "rust-analyzer",
      family: "open-source",
      project_root: "~/Projects/astrolabe-core",
      title: "LSP background check",
      turns: 4,
      activity: 0.12,
      state: "idle",
    },

    // Project 3: quantum-sim
    {
      id: "sess-quantum-codex",
      agent_id: "codex-cli",
      family: "openai",
      project_root: "~/Projects/quantum-sim",
      title: "Matrix solver kernel",
      turns: 28,
      activity: 0.95,
      state: "working",
    },
    {
      id: "sess-quantum-gemini",
      agent_id: "gemini-flash",
      family: "google",
      project_root: "~/Projects/quantum-sim",
      title: "Benchmark telemetry",
      turns: 9,
      activity: 0.45,
      state: "working",
    },

    // Project 4: compiler-pass
    {
      id: "sess-comp-github",
      agent_id: "copilot-cli",
      family: "github",
      project_root: "~/Projects/compiler-pass",
      title: "Syntax lowering",
      turns: 7,
      activity: 0.5,
      state: "working",
    },
    {
      id: "sess-comp-waiting",
      agent_id: "claude-sonnet",
      family: "anthropic",
      project_root: "~/Projects/compiler-pass",
      title: "Type checking confirmation",
      turns: 19,
      activity: 0.82,
      state: "waiting",
      waiting_since: now - 35000,
    },
  ];

  const activePlanets = sessions.filter(s => s.state !== "done" && !s.parent_id).length;
  const needsYou = sessions.filter(s => s.state === "waiting").length;
  const working = sessions.filter(s => s.state === "working").length;
  const idle = sessions.filter(s => s.state === "idle").length;
  const done = sessions.filter(s => s.state === "done").length;

  return {
    projects,
    sessions,
    telemetry: {
      activePlanets,
      needsYou,
      working,
      idle,
      done,
    },
  };
}

const sessionCache = new Map<string, Session>();

/** Look up the archived sessions behind live observations (cached; unknown ids are retried later). */
async function sessionsFor(lives: Live[]): Promise<Map<string, Session>> {
  const missing = lives.map((l) => l.session_id).filter((id) => !sessionCache.has(id));
  await Promise.all(
    [...new Set(missing)].map(async (id) => {
      const s = await sessionGet(id).catch(() => null);
      if (s) sessionCache.set(id, s);
    }),
  );
  return sessionCache;
}

let familyCache: Map<string, string> | null = null;

async function familiesFor(): Promise<Map<string, string>> {
  if (familyCache) return familyCache;
  const agents = await agentsList().catch(() => []);
  familyCache = new Map(agents.map((a) => [a.id, a.family]));
  return familyCache;
}

/** Model for a given live list (core mode). */
export async function liveModelFor(lives: Live[]): Promise<LiveListResult> {
  const [sessions, families] = await Promise.all([sessionsFor(lives), familiesFor()]);
  return buildLiveModel(lives, sessions, families);
}

/** The Orrery's model: real live data with a core, the typed mock without one. */
export async function fetchLiveList(): Promise<LiveListResult> {
  if (!isCoreAvailable()) return getMockLiveList();
  return liveModelFor(await liveList());
}

/**
 * Keep the Orrery's model current: calls onModel with each new model built from `live:update`.
 * A no-op without a core.
 */
export function watchLiveModel(onModel: (model: LiveListResult) => void): Promise<Unsubscribe> {
  return onLiveUpdate((lives) => {
    liveModelFor(lives).then(onModel, () => {});
  });
}

/** Test helper. */
export function resetLiveCaches(): void {
  sessionCache.clear();
  familyCache = null;
}
