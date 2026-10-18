/**
 * Presentation bridge: with `?presentation=1` the web build answers the app's Tauri commands and events
 * from demo/presentation/snapshot.json, which the exporter (app/src-tauri/src/bin/export-presentation.rs)
 * writes by running the REAL importer, detection, config scan and live detector over the synthetic
 * presentation dataset. The app's own client code runs unchanged: the bridge sits at the
 * window.__TAURI_INTERNALS__ level (see ipcShim.ts).
 *
 * Nothing here reads the wall clock or uses timers. Live updates and recorded events are released only by
 * the tour through window.__armillaryTour, so a frame-by-frame capture is deterministic.
 *
 * Where the core computes an answer from the archive (sessions_query filters and pages, messages_page
 * slices, search filters) the bridge applies the same rules to the exported data. Anything the snapshot
 * cannot answer is a typed error, never invented data.
 */

import type { ImportDiagnostic, Live, Message } from "@armillary/model";
import type { ImportProgress, ImportSummary, SearchHit, SearchPage, SessionRow } from "../api/types";
import { installIpcShim, type IpcShim } from "./ipcShim";
import { locate as locateTarget, registerLocator, tourAction, type Locator, type TourRect } from "./locators";

export const PRESENTATION_FORMAT = "armillary.presentation.v1";

export interface RecordedEvent {
  event: string;
  payload: unknown;
  /** Deterministic pacing hint in ms (not a measured time). */
  t: number;
}

export interface SearchEntry {
  query: string;
  limit: number;
  page?: SearchPage;
  error?: { code: string; message: string };
}

export interface LiveStep {
  name: string;
  at: number;
  list: Live[];
}

export interface PresentationSnapshot {
  format: string;
  reference_time: number;
  home?: string;
  import: { summary: ImportSummary; events: RecordedEvent[] };
  agents_list: unknown[];
  config_list: unknown;
  /** sessions_query rows as the core recorded them: contract Session plus display_title, title_source and the activity span. */
  sessions: SessionRow[];
  messages: Record<string, Message[]>;
  search: { limit: number; entries: SearchEntry[] };
  live: { process_table?: string; initial: { at: number; list: Live[] }; steps: LiveStep[] };
  /** First-run recording (FR), when the snapshot carries one. */
  firstrun?: { status?: { consented: boolean; completed: boolean }; plan?: unknown; events?: RecordedEvent[] };
  /** A recorded terminal session (asciicast v2: header plus [seconds, "o", data] events) for the Launchpad. */
  launchpad?: { cast: { header: { width?: number; height?: number; [key: string]: unknown }; events: Array<[number, string, string]> } };
  diagnostics?: ImportDiagnostic[];
}

/** What the tour (window.__armillaryTour) can do. */
export interface PresentationTour {
  /**
   * Release exactly one recorded event with this name: the one at `index` when given (0-based, in recorded
   * order), otherwise the next one not yet released. "live:update" with an index is advanceLive(index).
   * Returns how many events of that name have not been released yet.
   */
  emit(name: string, index?: number): number;
  /** Release every remaining recorded event with this name, in order. Returns how many were released. */
  emitAll(name: string): number;
  /** Show live step N (0 = the initial list) and send it as a live:update. Returns the list length. */
  advanceLive(step: number): number;
  /** Viewport rectangle of a target: "selector", "testid", or a kind a component registered ("planet"). */
  locate(kind: string, id: string): TourRect | null;
  /** Register a locator for a kind of target (DS registers "planet" from the Orrery). Returns an unregister function. */
  registerLocator(kind: string, locator: Locator): () => void;
  /**
   * Open a session in the Folio through the app's navigation: a live state ("waiting", ...) picks the first
   * session in the current live list with that state; anything else is a session id. Returns the id or null.
   */
  openSession(target: string): string | null;
  /**
   * Advance the recorded terminal to `ms` since pty_open: every recorded output chunk up to that time is
   * sent as pty:data. Seeking back clears the terminal (ESC c) and replays from the start. Returns how many
   * chunks were sent.
   */
  advancePty(ms: number): number;
  /** Where the tour stands. */
  state(): { liveStep: number; liveSteps: number; pending: Record<string, number>; referenceTime: number };
}

type Args = Record<string, unknown>;

class BridgeError {
  constructor(
    readonly code: string,
    readonly message: string,
  ) {}
}

function fail(code: string, message: string): never {
  throw new BridgeError(code, message);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function pageLimit(value: unknown, fallback: number): number {
  const limit = num(value) ?? fallback;
  if (limit < 1 || limit > 200) fail("invalid_input", "limit must be between 1 and 200");
  return limit;
}

/** sessions_query over the exported sessions, with the core's filters and order. */
export function querySessions(sessions: SessionRow[], q: Args) {
  const from = num(q.from);
  const to = num(q.to);
  if (from !== undefined && to !== undefined && from > to) {
    fail("invalid_input", "from timestamp cannot be greater than to timestamp");
  }
  const limit = pageLimit(q.limit, 50);
  const offset = num(q.offset) ?? 0;
  const agent = str(q.agent);
  const project = str(q.project);
  const status = str(q.status);
  const model = str(q.model);
  const matching = sessions.filter(
    (s) =>
      (agent === undefined || s.agent_id === agent) &&
      (project === undefined || s.project_root === project) &&
      (status === undefined || s.status === status) &&
      (model === undefined || s.model === model) &&
      (from === undefined || (s.started_at != null && s.started_at >= from)) &&
      (to === undefined || (s.started_at != null && s.started_at <= to)),
  );
  // ORDER BY started_at DESC, id (SQLite sorts NULL lowest, so unknown start times come last)
  matching.sort((a, b) => {
    const at = a.started_at ?? null;
    const bt = b.started_at ?? null;
    if (at !== bt) {
      if (at === null) return 1;
      if (bt === null) return -1;
      return bt - at;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return { items: matching.slice(offset, offset + limit), total: matching.length, limit, offset };
}

function filterHits(hits: SearchHit[], input: Args, sessions: Map<string, SessionRow>): SearchHit[] {
  const agent = str(input.agent);
  const project = str(input.project);
  const from = num(input.from);
  const to = num(input.to);
  return hits.filter((h) => {
    const s = sessions.get(h.session_id);
    if (agent !== undefined && h.agent_id !== agent) return false;
    if (project !== undefined && (s?.project_root ?? h.project_root) !== project) return false;
    if (from !== undefined && (h.at == null || h.at < from)) return false;
    if (to !== undefined && (h.at == null || h.at > to)) return false;
    return true;
  });
}

export interface InstalledBridge {
  tour: PresentationTour;
  shim: IpcShim;
  uninstall(): void;
}

/** Install the bridge for a snapshot. Sets the presentation flag and the reference time for appNow(). */
export function installPresentationBridge(snapshot: PresentationSnapshot): InstalledBridge {
  if (snapshot.format !== PRESENTATION_FORMAT) {
    throw new Error(`unsupported presentation snapshot format: ${String(snapshot.format)}`);
  }
  const w = window as unknown as Record<string, unknown>;
  const sessionsById = new Map(snapshot.sessions.map((s) => [s.id, s]));
  const events = [...(snapshot.import?.events ?? []), ...(snapshot.firstrun?.events ?? [])];
  const cursor = new Map<string, number>();
  let liveStep = 0;
  const liveLists = [snapshot.live.initial.list, ...snapshot.live.steps.map((s) => s.list)];

  const released = new Map<string, Set<number>>();
  const pendingOf = (name: string) =>
    events.filter((e) => e.event === name).length - (released.get(name)?.size ?? 0);
  let firstRun = { ...(snapshot.firstrun?.status ?? { consented: true, completed: true }) };
  let ptyCounter = 0;
  let pty: { id: string; sentMs: number; sent: number } | null = null;

  const handle = (command: string, args: Args): unknown => {
    switch (command) {
      case "agents_list":
        return snapshot.agents_list;
      case "config_list": {
        const agentId = str(args.agentId);
        const config = snapshot.config_list as { agents?: Array<{ id?: string; agent_id?: string }> } | null;
        if (!agentId || !config || !Array.isArray(config.agents)) return config;
        return { ...config, agents: config.agents.filter((a) => (a.id ?? a.agent_id) === agentId) };
      }
      case "live_list":
        return liveLists[liveStep] ?? [];
      case "sessions_query":
        return querySessions(snapshot.sessions, (args.query as Args) ?? {});
      case "session_get": {
        const id = String(args.id ?? "");
        if (!/^[0-9a-fA-F]+$/.test(id)) fail("invalid_input", "session id must be hexadecimal");
        return sessionsById.get(id) ?? fail("not_found", `session not found: ${id}`);
      }
      case "messages_page": {
        const id = String(args.id ?? "");
        if (!/^[0-9a-fA-F]+$/.test(id)) fail("invalid_input", "session id must be hexadecimal");
        if (!sessionsById.has(id)) fail("not_found", `session not found: ${id}`);
        const limit = pageLimit(args.limit, 100);
        const offset = num(args.offset) ?? 0;
        const all = snapshot.messages[id] ?? [];
        return { items: all.slice(offset, offset + limit), total: all.length, limit, offset };
      }
      case "search": {
        const input = (args.input as Args) ?? {};
        const query = typeof input.query === "string" ? input.query : "";
        if (query.trim() === "") fail("invalid_input", "search query cannot be empty");
        const limit = pageLimit(input.limit, 20);
        const entry = snapshot.search.entries.find((e) => e.query === query && e.limit === limit);
        if (!entry) fail("not_in_snapshot", `the presentation snapshot has no search for "${query}" (limit ${limit})`);
        if (entry.error) fail(entry.error.code, entry.error.message);
        const page = entry.page as SearchPage;
        const offset = num(input.offset) ?? 0;
        const items = filterHits(page.items, input, sessionsById).slice(offset);
        return { items, limit: page.limit, offset, has_more: offset === 0 ? page.has_more : false };
      }
      case "import_now":
        return snapshot.import.summary;
      case "import_diagnostics":
        return snapshot.diagnostics ?? [];
      case "services_start":
      case "ui_trace":
        return null;
      case "archive_delete":
        return fail("unavailable_in_presentation", "the sample archive cannot be deleted");
      case "archive_status":
        return { ok: true, message: null };
      case "archive_move_aside":
        return fail("unavailable_in_presentation", "the sample archive cannot be moved");
      case "display_context": {
        // The demo home is the canonical one: the exporter ran with HOME set to it.
        const home = snapshot.home ?? null;
        return { home, home_canonical: home };
      }
      case "firstrun_status":
        return { ...firstRun };
      case "firstrun_plan":
        return snapshot.firstrun?.plan ?? fail("not_in_snapshot", "the presentation snapshot has no first-run plan");
      case "firstrun_consent":
        firstRun = args.accepted === true ? { consented: true, completed: false } : { consented: false, completed: true };
        return { ...firstRun };
      case "firstrun_scan":
        // The recorded firstrun:* events are released by the tour; the first run waits for firstrun:done.
        return null;
      case "firstrun_complete":
        firstRun = { ...firstRun, completed: true };
        return { ...firstRun };
      case "firstrun_reset":
        firstRun = { ...firstRun, completed: false };
        return { ...firstRun };
      case "firstrun_fps_enabled":
        return false;
      case "firstrun_fps_report":
        return null;
      case "pty_open": {
        if (!snapshot.launchpad?.cast) return fail("unavailable_in_presentation", "terminals are not available on sample data");
        ptyCounter += 1;
        pty = { id: `presentation-pty-${ptyCounter}`, sentMs: -1, sent: 0 };
        const agentId = String(args.agentId ?? args.agent_id ?? "shell");
        return { id: pty.id, agent_id: agentId, cwd: String(args.cwd ?? "") };
      }
      case "pty_write":
      case "pty_resize":
        if (!snapshot.launchpad?.cast) return fail("unavailable_in_presentation", "terminals are not available on sample data");
        return null;
      case "pty_close":
        if (!snapshot.launchpad?.cast) return fail("unavailable_in_presentation", "terminals are not available on sample data");
        pty = null;
        return null;
      default:
        if (command.startsWith("firstrun_") || command.startsWith("capture_")) {
          return fail("unavailable_in_presentation", `${command} is not part of the presentation snapshot`);
        }
        return fail("unknown_command", `unknown command: ${command}`);
    }
  };

  const shim = installIpcShim((command, args) => {
    try {
      return handle(command, args);
    } catch (err) {
      if (err instanceof BridgeError) return Promise.reject({ code: err.code, message: err.message });
      throw err;
    }
  });

  const tour: PresentationTour = {
    emit(name, index) {
      if (name === "live:update" && index !== undefined) {
        tour.advanceLive(index);
        return 0;
      }
      const matching = events.filter((e) => e.event === name);
      const done = released.get(name) ?? new Set<number>();
      let at = index;
      if (at === undefined) {
        at = matching.findIndex((_, i) => !done.has(i));
        if (at < 0) return 0;
      } else if (!Number.isInteger(at) || at < 0 || at >= matching.length) {
        throw new Error(`no recorded ${name} event ${at} in the snapshot (it has ${matching.length})`);
      }
      done.add(at);
      released.set(name, done);
      cursor.set(name, Math.max(cursor.get(name) ?? 0, at + 1));
      shim.emit(name, matching[at].payload);
      return pendingOf(name);
    },
    emitAll(name) {
      let released = 0;
      while (pendingOf(name) > 0) {
        tour.emit(name);
        released += 1;
      }
      return released;
    },
    advanceLive(step) {
      if (!Number.isInteger(step) || step < 0 || step >= liveLists.length) {
        throw new Error(`live step ${step} is not in the snapshot (0 to ${liveLists.length - 1})`);
      }
      liveStep = step;
      shim.emit("live:update", liveLists[step]);
      return liveLists[step].length;
    },
    locate(kind, id) {
      return locateTarget(kind, id);
    },
    registerLocator(kind, locator) {
      return registerLocator(kind, locator);
    },
    openSession(target) {
      const states = ["unknown", "working", "waiting", "idle", "done"];
      let id: string | null = target;
      if (states.includes(target)) {
        const current = liveLists[liveStep] ?? [];
        const candidates = current.filter((l) => l.state === target);
        const archived = candidates.find((l) => sessionsById.has(l.session_id));
        id = (archived ?? candidates[0])?.session_id ?? null;
      }
      if (!id) return null;
      const open = tourAction("openSession");
      if (open) open(id);
      return id;
    },
    advancePty(ms) {
      const cast = snapshot.launchpad?.cast;
      if (!cast || !pty) return 0;
      const current = pty;
      const chunks = cast.events.filter((e) => e[1] === "o");
      let sent = 0;
      if (ms < current.sentMs) {
        shim.emit("pty:data", { id: current.id, data: "\u001bc" });
        current.sent = 0;
      }
      while (current.sent < chunks.length && chunks[current.sent][0] * 1000 <= ms) {
        shim.emit("pty:data", { id: current.id, data: chunks[current.sent][2] });
        current.sent += 1;
        sent += 1;
      }
      current.sentMs = ms;
      return sent;
    },
    state() {
      const pending: Record<string, number> = {};
      for (const e of events) pending[e.event] = pendingOf(e.event);
      return { liveStep, liveSteps: liveLists.length, pending, referenceTime: snapshot.reference_time };
    },
  };

  w.__ARMILLARY_PRESENTATION__ = true;
  w.__ARMILLARY_NOW__ = snapshot.reference_time;
  w.__armillaryTour = tour;

  return {
    tour,
    shim,
    uninstall() {
      shim.uninstall();
      delete w.__ARMILLARY_PRESENTATION__;
      delete w.__ARMILLARY_NOW__;
      delete w.__armillaryTour;
    },
  };
}

/** True when the page asks for presentation mode (`?presentation=1`). */
export function isPresentationRequested(search: string = typeof window === "undefined" ? "" : window.location.search): boolean {
  return new URLSearchParams(search).get("presentation") === "1";
}

/**
 * Load the committed snapshot (a lazy chunk, fetched only in presentation mode) and install the bridge.
 * Resolves to null when the build has no snapshot.
 */
export async function installPresentationFromBuild(): Promise<InstalledBridge | null> {
  // Only a presentation build (VITE_ARMILLARY_PRESENTATION=1: the web demo and its capture) bundles the
  // sample snapshot; in every other build this branch is constant-false and the chunk is not emitted.
  const loaders: Record<string, () => Promise<PresentationSnapshot>> =
    import.meta.env.VITE_ARMILLARY_PRESENTATION === "1"
      ? import.meta.glob<PresentationSnapshot>("../../../demo/presentation/snapshot.json", { import: "default" })
      : {};
  const load = Object.values(loaders)[0];
  if (!load) return null;
  return installPresentationBridge(await load());
}

export type { ImportProgress };
