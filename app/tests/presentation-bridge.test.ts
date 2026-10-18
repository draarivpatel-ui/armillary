import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Live, Message, Session } from "@armillary/model";
import {
  installPresentationBridge,
  isPresentationRequested,
  PRESENTATION_FORMAT,
  querySessions,
  type InstalledBridge,
  type PresentationSnapshot,
} from "../src/presentation/bridge";
import { ApiError, call, dataMode, resetClientState, subscribe } from "../src/api/client";
import { resetArchiveClient, searchPage, sessionsQuery, type SessionRow } from "../src/api/archive";
import { registerLocator, registerTourAction, resetLocators } from "../src/presentation/locators";

const hex = (n: number) => n.toString(16).padStart(64, "0");

function session(n: number, over: Partial<Session> = {}): Session {
  return {
    id: hex(n),
    agent_id: n % 2 ? "claude-code" : "codex-cli",
    project_root: n % 3 ? "/Users/fictional-dev/projects/skyline-weather" : "/Users/fictional-dev/projects/nexus-gateway",
    title: `Session ${n}`,
    status: "unknown",
    turns: n,
    started_at: 1_791_800_000_000 + n * 1000,
    usage: { observations: [], semantics: "unknown" },
    provenance: {
      adapter_id: "claude-code",
      adapter_version: "1.0.0",
      checkpoint: { digest: "d", offset: 0, records: 0, revision: 1 },
      file_identity: "f",
      generation: 1,
      source_id: "s",
      source_path: "a.jsonl",
      store: { canonical_root: "/tmp/demo-home/.claude/projects", id: "st", namespace: "claude-history", profile_id: "p" },
    },
    ...over,
  };
}

function messages(id: string, count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${id}-${i + 1}`,
    session_id: id,
    seq: i + 1,
    role: i % 2 ? "assistant" : "user",
    blocks: [{ type: "text", text: `line ${i + 1}` }],
  }));
}

const live = (id: string, state: Live["state"]): Live => ({
  session_id: id,
  state,
  confidence: "high",
  evidence: [{ kind: state === "waiting" ? "native_waiting_signal" : "process_and_activity", detail: "d", at: 1 }],
  observed_at: 1_791_828_000_000,
});

function fixture(): PresentationSnapshot {
  const toRow = (s: Session, i: number): SessionRow => ({
    ...s,
    display_title: s.title ?? null,
    title_source: s.title ? "native" : null,
    first_activity_at: s.started_at != null ? s.started_at + 1 : null,
    last_activity_at: s.started_at != null ? s.started_at + 1000 * (i + 1) : null,
  });
  const sessions = [1, 2, 3, 4, 5, 6].map((n) => session(n)).map(toRow);
  sessions.push(toRow(session(7, { started_at: null }), 6));
  const msgs: Record<string, Message[]> = {};
  for (const s of sessions) msgs[s.id] = messages(s.id, s.turns + 2);
  const snapshot: PresentationSnapshot = {
    format: PRESENTATION_FORMAT,
    reference_time: 1_791_828_000_000,
    home: "/private/tmp/demo-home",
    import: {
      summary: { adapters: 2, sessions: 7, messages: 42 },
      events: [
        { event: "import:progress", payload: { agentId: "", phase: "started", sessionsImported: 0, sessionsKnown: 0, error: null, projects: [] }, t: 0 },
        { event: "import:progress", payload: { agentId: "claude-code", phase: "progress", sessionsImported: 4, sessionsKnown: 4, error: null, projects: [] }, t: 400 },
        { event: "import:progress", payload: { agentId: "", phase: "finished", sessionsImported: 7, sessionsKnown: 7, error: null, projects: [] }, t: 800 },
      ],
    },
    agents_list: [{ id: "claude-code", name: "Claude Code", vendor: "Anthropic", family: "anthropic", kind: "cli", installed: true }],
    config_list: { agents: [{ id: "claude-code" }, { id: "codex-cli" }] },
    sessions,
    messages: msgs,
    search: {
      limit: 50,
      entries: [
        {
          query: "radar",
          limit: 50,
          page: {
            items: [
              {
                session_id: hex(1),
                message_id: `${hex(1)}-2`,
                seq: 2,
                block_index: 0,
                kind: "message",
                at: 1,
                score: 3,
                text: "Doppler radar sweep",
                highlights: [[8, 13]],
                agent_id: "claude-code",
                project_root: "/Users/fictional-dev/projects/skyline-weather",
                session_title: "Session 1",
                session_started_at: 1,
              },
              {
                session_id: hex(2),
                message_id: `${hex(2)}-1`,
                seq: 1,
                block_index: 0,
                kind: "tool",
                at: 2,
                score: 2,
                text: "radar tiles",
                highlights: [[0, 5]],
                agent_id: "codex-cli",
                project_root: "/Users/fictional-dev/projects/skyline-weather",
                session_title: "Session 2",
                session_started_at: 2,
              },
            ],
            limit: 50,
            offset: 0,
            has_more: false,
          },
        },
      ],
    },
    live: {
      process_table: "dataset",
      initial: { at: 1_791_828_000_000, list: [live(hex(1), "working"), live(hex(2), "waiting")] },
      steps: [{ name: "claude-aurora-working asks for permission", at: 1_791_828_041_000, list: [live(hex(1), "waiting"), live(hex(2), "waiting")] }],
    },
    firstrun: {
      status: { consented: false, completed: false },
      plan: { platform: "macos", entries: [{ id: "claude-code", name: "Claude Code", vendor: "Anthropic", family: "anthropic", kind: "cli", history: true }], folders: ["~/.claude/projects"] },
      events: [
        { event: "firstrun:agent", payload: { agentId: "claude-code", found: true }, t: 0 },
        { event: "firstrun:agent", payload: { agentId: "codex-cli", found: true }, t: 250 },
        { event: "firstrun:done", payload: { agents: 2 }, t: 900 },
      ],
    },
    launchpad: {
      cast: {
        header: { version: 2, width: 100, height: 28 },
        events: [
          [0.019, "o", "START\r\n"],
          [0.5, "o", "\u001b[1;33mcolour\u001b[0m\r\n"],
          [1.25, "o", "END\r\n"],
        ],
      },
    },
  };
  return snapshot;
}

let bridge: InstalledBridge | null = null;

beforeEach(() => {
  resetClientState();
  resetArchiveClient();
  bridge = installPresentationBridge(fixture());
});

afterEach(() => {
  bridge?.uninstall();
  bridge = null;
  resetLocators();
});

describe("presentation bridge", () => {
  it("marks the data as sample data and exposes the tour", () => {
    expect(dataMode()).toBe("presentation");
    expect((window as unknown as { __armillaryTour?: unknown }).__armillaryTour).toBeDefined();
    expect((window as unknown as { __ARMILLARY_NOW__?: number }).__ARMILLARY_NOW__).toBe(1_791_828_000_000);
    expect(isPresentationRequested("?presentation=1")).toBe(true);
    expect(isPresentationRequested("?presentation=0")).toBe(false);
  });

  it("answers sessions_query with the core's order, filters and pages through the real client", async () => {
    const all = await sessionsQuery({ limit: 200 });
    expect(all.total).toBe(7);
    expect(all.items.map((s) => s.title)).toEqual(["Session 6", "Session 5", "Session 4", "Session 3", "Session 2", "Session 1", "Session 7"]);
    const page = await sessionsQuery({ limit: 2, offset: 2, agent: "claude-code" });
    expect(page).toMatchObject({ total: 4, limit: 2, offset: 2 });
    expect(page.items.map((s) => s.title)).toEqual(["Session 1", "Session 7"]);
    await expect(sessionsQuery({ limit: 500 })).rejects.toMatchObject({ code: "invalid_input" });
    expect(querySessions(fixture().sessions, { project: "/Users/fictional-dev/projects/nexus-gateway" }).total).toBe(2);
  });

  it("serves the recorded display title and activity span unchanged", async () => {
    const page = await sessionsQuery({ limit: 200 });
    for (const row of page.items) {
      expect(row.display_title).toBe(row.title);
      expect(row.title_source).toBe("native");
    }
    const withTime = page.items.find((r) => r.started_at != null)!;
    expect(withTime.first_activity_at).toBe(withTime.started_at! + 1);
    expect(typeof withTime.last_activity_at).toBe("number");
    const unknown = page.items.find((r) => r.started_at == null)!;
    expect([unknown.first_activity_at, unknown.last_activity_at]).toEqual([null, null]);
  });

  it("answers session_get and messages_page from the exported data, typed errors otherwise", async () => {
    await expect(call("session_get", { id: hex(3) })).resolves.toMatchObject({ title: "Session 3" });
    await expect(call("session_get", { id: hex(99) })).rejects.toMatchObject({ code: "not_found" });
    const page = await call<{ items: Message[]; total: number }>("messages_page", { id: hex(3), limit: 2, offset: 1 });
    expect(page.total).toBe(5);
    expect(page.items.map((m) => m.seq)).toEqual([2, 3]);
  });

  it("answers recorded searches and refuses unrecorded ones", async () => {
    const page = await searchPage("radar", { limit: 50 });
    expect(page.items).toHaveLength(2);
    const filtered = await searchPage("radar", { limit: 50, agent: "codex-cli" });
    expect(filtered.items.map((h) => h.session_id)).toEqual([hex(2)]);
    const err = (await searchPage("sonar", { limit: 50 }).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("not_in_snapshot");
  });

  it("releases recorded events only when the tour asks, in order", async () => {
    const got: Array<{ phase: string }> = [];
    await subscribe<{ phase: string }>("import:progress", (p) => got.push(p));
    expect(got).toHaveLength(0);
    const tour = bridge!.tour;
    expect(tour.state().pending["import:progress"]).toBe(3);
    expect(tour.emit("import:progress")).toBe(2);
    expect(got.map((p) => p.phase)).toEqual(["started"]);
    expect(tour.emitAll("import:progress")).toBe(2);
    expect(got.map((p) => p.phase)).toEqual(["started", "progress", "finished"]);
    expect(tour.emit("import:progress")).toBe(0);
  });

  it("swings live state forward only on advanceLive, and live_list follows", async () => {
    const lists: Live[][] = [];
    await subscribe<Live[]>("live:update", (l) => lists.push(l));
    const waiting = (l: Live[]) => l.filter((x) => x.state === "waiting").length;
    expect(waiting(await call<Live[]>("live_list"))).toBe(1);
    bridge!.tour.advanceLive(1);
    expect(lists).toHaveLength(1);
    expect(waiting(lists[0])).toBe(2);
    expect(waiting(await call<Live[]>("live_list"))).toBe(2);
    expect(() => bridge!.tour.advanceLive(5)).toThrow(/not in the snapshot/);
  });

  it("refuses terminals honestly when the snapshot has no recorded terminal", async () => {
    bridge!.uninstall();
    const { launchpad: _omit, ...rest } = fixture();
    bridge = installPresentationBridge(rest);
    await expect(call("pty_open", { agentId: "shell" })).rejects.toMatchObject({ code: "unavailable_in_presentation" });
  });

  it("answers every command the app calls, or a typed error that is not unknown_command", async () => {
    const src = path.resolve(__dirname, "../src");
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !full.includes("__tests__")) out.push(full);
      }
      return out;
    };
    const commands = new Set<string>();
    for (const file of walk(src)) {
      if (file.includes(`${path.sep}capture${path.sep}`)) continue; // SNAP's capture build talks to the capture core
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\b(?:invoke|call)(?:<[^>]*>)?\(\s*["']([a-z0-9_]+)["']/g)) commands.add(m[1]);
    }
    expect(commands.size).toBeGreaterThan(8);
    const args: Record<string, Record<string, unknown>> = {
      sessions_query: { query: {} },
      session_get: { id: hex(1) },
      messages_page: { id: hex(1), limit: 10, offset: 0 },
      search: { input: { query: "radar", limit: 50 } },
    };
    for (const command of commands) {
      const outcome = await call(command, args[command] ?? {}).then(
        () => "ok",
        (e: ApiError) => e.code,
      );
      expect(outcome, command).not.toBe("unknown_command");
    }
  });

  it("emit(name, index) releases exactly that one recorded event, from the first-run and live logs too", async () => {
    const agents: unknown[] = [];
    const lists: Live[][] = [];
    await subscribe("firstrun:agent", (p) => agents.push(p));
    await subscribe<Live[]>("live:update", (l) => lists.push(l));
    bridge!.tour.emit("firstrun:agent", 1);
    expect(agents).toEqual([{ agentId: "codex-cli", found: true }]);
    bridge!.tour.emit("firstrun:agent", 0);
    expect(agents).toEqual([{ agentId: "codex-cli", found: true }, { agentId: "claude-code", found: true }]);
    expect(() => bridge!.tour.emit("firstrun:agent", 7)).toThrow(/no recorded firstrun:agent event 7/);
    bridge!.tour.emit("live:update", 1);
    expect(lists).toHaveLength(1);
    expect(lists[0].filter((x) => x.state === "waiting")).toHaveLength(2);
    await expect(call("firstrun_status")).resolves.toEqual({ consented: false, completed: false });
  });

  it("locate(kind, id) asks registered locators and falls back to DOM selectors", () => {
    const el = document.createElement("button");
    el.setAttribute("data-testid", "probe");
    document.body.appendChild(el);
    el.getBoundingClientRect = () => ({ x: 10, y: 20, width: 30, height: 40, top: 20, left: 10, right: 40, bottom: 60, toJSON() {} }) as DOMRect;
    expect(bridge!.tour.locate("selector", "[data-testid='probe']")).toMatchObject({ x: 10, y: 20, width: 30, height: 40 });
    expect(bridge!.tour.locate("testid", "probe")).toMatchObject({ x: 10, y: 20 });
    expect(bridge!.tour.locate("selector", ".missing")).toBeNull();
    expect(bridge!.tour.locate("planet", "waiting")).toBeNull();
    const off = registerLocator("planet", (id) => (id === "waiting" ? { x: 400, y: 300, width: 24, height: 24 } : null));
    expect(bridge!.tour.locate("planet", "waiting")).toMatchObject({ x: 400, y: 300, width: 24, height: 24, left: 400, top: 300, right: 424, bottom: 324 });
    off();
    expect(bridge!.tour.locate("planet", "waiting")).toBeNull();
    el.remove();
  });

  it("tour.registerLocator returns an unregister function, and window.__armillaryLocators is a fallback", () => {
    const tour = bridge!.tour;
    const off = tour.registerLocator("planet", (id) => (id === hex(2) ? { x: 1, y: 2, width: 3, height: 4 } : null));
    expect(tour.locate("planet", hex(2))).toMatchObject({ x: 1, y: 2, width: 3, height: 4, right: 4, bottom: 6 });
    off();
    expect(tour.locate("planet", hex(2))).toBeNull();
    const w = window as unknown as { __armillaryLocators?: Record<string, (id: string) => unknown> };
    w.__armillaryLocators = { planet: () => ({ x: 9, y: 8, width: 7, height: 6 }) };
    expect(tour.locate("planet", "anything")).toMatchObject({ x: 9, y: 8, width: 7, height: 6 });
    delete w.__armillaryLocators;
  });

  it("answers the first-run commands so the first run can play on sample data", async () => {
    await expect(call("firstrun_status")).resolves.toEqual({ consented: false, completed: false });
    await expect(call("firstrun_plan")).resolves.toMatchObject({ platform: "macos", entries: [{ id: "claude-code" }] });
    await expect(call("firstrun_consent", { accepted: true })).resolves.toEqual({ consented: true, completed: false });
    await expect(call("firstrun_scan")).resolves.toBeNull();
    await expect(call("firstrun_complete")).resolves.toEqual({ consented: true, completed: true });
    await expect(call("firstrun_status")).resolves.toEqual({ consented: true, completed: true });
    await expect(call("firstrun_reset")).resolves.toEqual({ consented: true, completed: false });
    await expect(call("firstrun_fps_enabled")).resolves.toBe(false);
    await expect(call("firstrun_fps_report", { line: "x" })).resolves.toBeNull();
  });

  it("openSession(state or id) opens through the app's navigation", () => {
    const opened: string[] = [];
    registerTourAction("openSession", (id: string) => opened.push(id));
    expect(bridge!.tour.openSession("waiting")).toBe(hex(2));
    bridge!.tour.advanceLive(1);
    expect(bridge!.tour.openSession("waiting")).toBe(hex(1));
    expect(bridge!.tour.openSession(hex(3))).toBe(hex(3));
    expect(bridge!.tour.openSession("done")).toBeNull();
    expect(opened).toEqual([hex(2), hex(1), hex(3)]);
  });

  it("replays the recorded terminal only as the tour advances its clock", async () => {
    const chunks: Array<{ id: string; data: string }> = [];
    await subscribe<{ id: string; data: string }>("pty:data", (p) => chunks.push(p));
    const info = await call<{ id: string; agent_id: string; cwd: string }>("pty_open", { agentId: "claude-code", agent_id: "claude-code", cwd: "/Users/fictional-dev/projects/skyline-weather" });
    expect(info).toMatchObject({ agent_id: "claude-code", cwd: "/Users/fictional-dev/projects/skyline-weather" });
    await expect(call("pty_write", { id: info.id, data: "ls\r" })).resolves.toBeNull();
    await expect(call("pty_resize", { id: info.id, cols: 100, rows: 28 })).resolves.toBeNull();
    expect(chunks).toHaveLength(0);
    expect(bridge!.tour.advancePty(600)).toBe(2);
    expect(chunks.map((c) => c.data)).toEqual(["START\r\n", "\u001b[1;33mcolour\u001b[0m\r\n"]);
    expect(chunks.every((c) => c.id === info.id)).toBe(true);
    expect(bridge!.tour.advancePty(600)).toBe(0);
    expect(bridge!.tour.advancePty(2000)).toBe(1);
    // seeking back clears the terminal and replays from the first event up to the new time
    chunks.length = 0;
    expect(bridge!.tour.advancePty(100)).toBe(1);
    expect(chunks.map((c) => c.data)).toEqual(["\u001bc", "START\r\n"]);
    await expect(call("pty_close", { id: info.id })).resolves.toBeNull();
  });

  it("answers display_context with the snapshot's demo home, so the UI shows ~", async () => {
    await expect(call("display_context")).resolves.toEqual({ home: "/private/tmp/demo-home", home_canonical: "/private/tmp/demo-home" });
    bridge!.uninstall();
    const { home: _omit, ...rest } = fixture();
    bridge = installPresentationBridge(rest);
    await expect(call("display_context")).resolves.toEqual({ home: null, home_canonical: null });
  });

  it("only a presentation build (VITE_ARMILLARY_PRESENTATION=1) can contain the sample snapshot", () => {
    const bridgeSource = readFileSync(path.resolve(__dirname, "../src/presentation/bridge.ts"), "utf8");
    const mainSource = readFileSync(path.resolve(__dirname, "../src/main.tsx"), "utf8");
    // the snapshot glob sits behind the build-time flag, so a normal build drops the chunk entirely
    expect(bridgeSource).toMatch(/import\.meta\.env\.VITE_ARMILLARY_PRESENTATION === "1"\s*\?\s*import\.meta\.glob/);
    // and the app only loads the bridge in such a build
    expect(mainSource).toMatch(/import\.meta\.env\.VITE_ARMILLARY_PRESENTATION === "1"/);
  });

  it("never reads the wall clock or schedules timers", () => {
    for (const file of ["bridge.ts", "locators.ts", "ipcShim.ts"]) {
      const source = readFileSync(path.resolve(__dirname, "../src/presentation", file), "utf8");
      expect(source, file).not.toMatch(/Date\.now\(|performance\.now\(|setTimeout\(|setInterval\(|requestAnimationFrame\(/);
    }
  });
});
