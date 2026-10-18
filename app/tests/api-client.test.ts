import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Live, Message, Session } from "@armillary/model";
import { installIpcShim, type IpcShim } from "../src/presentation/ipcShim";
import { ApiError, call, dataMode, isCoreAvailable, resetClientState, subscribe } from "../src/api/client";
import {
  highlightSegments,
  importDiagnostics,
  importNow,
  loadSessionMessages,
  messagesPage,
  onImportProgress,
  resetArchiveClient,
  searchPage,
  sessionGet,
  sessionsQuery,
  sessionsQueryAll,
} from "../src/api/archive";
import { agentsList, MOCK_AGENTS, resetAgentsClient } from "../src/api/agents";
import { buildLiveModel, liveList, onLiveUpdate } from "../src/api/live";

function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    agent_id: "claude-code",
    status: "unknown",
    turns: 1,
    usage: { observations: [], semantics: "unknown" },
    provenance: {
      adapter_id: "claude-code",
      adapter_version: "1.0.0",
      checkpoint: { digest: "d", offset: 0, records: 0, revision: 1 },
      file_identity: "f",
      generation: 1,
      source_id: "s",
      source_path: "a.jsonl",
      store: { canonical_root: "/tmp/x", id: "st", namespace: "claude-history", profile_id: "p" },
    },
    ...over,
  };
}

function message(seq: number): Message {
  return { id: `m${seq}`, session_id: "abc", seq, role: "assistant", blocks: [{ type: "text", text: `t${seq}` }] };
}

let shim: IpcShim | null = null;

function core(handler: (command: string, args: Record<string, unknown>) => unknown): IpcShim {
  shim = installIpcShim(handler);
  return shim;
}

beforeEach(() => {
  resetClientState();
  resetArchiveClient();
  resetAgentsClient();
});

afterEach(() => {
  shim?.uninstall();
  shim = null;
  delete (window as unknown as { __ARMILLARY_PRESENTATION__?: boolean }).__ARMILLARY_PRESENTATION__;
});

describe("client: one door for commands and events", () => {
  it("reports the data mode: mock without a core, core with one, presentation with the shim flag", () => {
    expect(isCoreAvailable()).toBe(false);
    expect(dataMode()).toBe("mock");
    core(() => null);
    expect(isCoreAvailable()).toBe(true);
    expect(dataMode()).toBe("core");
    (window as unknown as { __ARMILLARY_PRESENTATION__?: boolean }).__ARMILLARY_PRESENTATION__ = true;
    expect(dataMode()).toBe("presentation");
  });

  it("invokes a command with its arguments", async () => {
    const fake = core((command, args) => ({ command, args }));
    await expect(call("sessions_query", { query: { limit: 5 } })).resolves.toEqual({
      command: "sessions_query",
      args: { query: { limit: 5 } },
    });
    expect(fake.calls).toEqual([{ command: "sessions_query", args: { query: { limit: 5 } } }]);
  });

  it("turns a typed core error into ApiError with its code", async () => {
    core(() => Promise.reject({ code: "not_found", message: "session not found: ab" }));
    const err = (await call("session_get", { id: "ab" }).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("not_found");
    expect(err.command).toBe("session_get");
    expect(err.message).toBe("session not found: ab");
  });

  it("turns a plain string rejection into ApiError code error", async () => {
    core(() => Promise.reject("Detector lock error"));
    const err = (await call("live_list").catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("error");
    expect(err.message).toBe("Detector lock error");
  });

  it("refuses without a core instead of inventing data", async () => {
    const err = (await call("sessions_query").catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("core_unavailable");
  });

  it("delivers events through the real listen path and unsubscribes", async () => {
    const fake = core(() => null);
    const got: unknown[] = [];
    const off = await subscribe<{ n: number }>("import:progress", (p) => got.push(p));
    expect(fake.listenerCount("import:progress")).toBe(1);
    fake.emit("import:progress", { n: 1 });
    fake.emit("import:progress", { n: 2 });
    expect(got).toEqual([{ n: 1 }, { n: 2 }]);
    off();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.listenerCount("import:progress")).toBe(0);
  });

  it("traces only the first delivery of each event name, without payload content", async () => {
    const fake = core(() => null);
    await subscribe("live:update", () => {});
    fake.emit("live:update", [{ secret: "x" }]);
    fake.emit("live:update", [{ secret: "y" }]);
    await Promise.resolve();
    const traces = fake.calls.filter((c) => c.command === "ui_trace");
    expect(traces).toHaveLength(1);
    expect(String(traces[0].args.line)).toContain("live:update");
    expect(JSON.stringify(traces[0].args)).not.toContain("secret");
  });

  it("subscribe is a no-op without a core", async () => {
    const off = await subscribe("import:progress", () => {});
    expect(typeof off).toBe("function");
    off();
  });
});

describe("archive client against a core", () => {
  it("sessions_query passes the filter as `query`", async () => {
    const fake = core(() => ({ items: [session("a1")], total: 1, limit: 50, offset: 0 }));
    const page = await sessionsQuery({ agent: "claude-code", limit: 50 });
    expect(page.items[0].id).toBe("a1");
    expect(fake.calls[0]).toEqual({ command: "sessions_query", args: { query: { agent: "claude-code", limit: 50 } } });
  });

  it("sessionsQueryAll pages through every session at 200 per page", async () => {
    const all = Array.from({ length: 450 }, (_, i) => session(`s${i}`));
    const fake = core((_c, args) => {
      const q = args.query as { limit: number; offset: number };
      return { items: all.slice(q.offset, q.offset + q.limit), total: all.length, limit: q.limit, offset: q.offset };
    });
    const page = await sessionsQueryAll({ agent: "claude-code" });
    expect(page.items).toHaveLength(450);
    expect(page.total).toBe(450);
    expect(fake.calls.map((c) => (c.args.query as { offset: number }).offset)).toEqual([0, 200, 400]);
    expect(fake.calls.every((c) => (c.args.query as { limit: number }).limit === 200)).toBe(true);
  });

  it("never falls back to mock data when the core fails", async () => {
    core(() => Promise.reject({ code: "archive_failed", message: "disk" }));
    await expect(sessionsQuery()).rejects.toMatchObject({ code: "archive_failed" });
  });

  it("session_get returns the contract Session, and null for not_found", async () => {
    core((_c, args) =>
      args.id === "aa" ? session("aa") : Promise.reject({ code: "not_found", message: "session not found" }),
    );
    expect((await sessionGet("aa"))?.id).toBe("aa");
    expect(await sessionGet("bb")).toBeNull();
  });

  it("messages_page passes id, limit and offset", async () => {
    const fake = core(() => ({ items: [message(1)], total: 1, limit: 100, offset: 0 }));
    const page = await messagesPage("abc", 100, 0);
    expect(page.items[0].blocks[0]).toEqual({ type: "text", text: "t1" });
    expect(fake.calls[0]).toEqual({ command: "messages_page", args: { id: "abc", limit: 100, offset: 0 } });
  });

  it("loadSessionMessages pages in order until the total and reports each page", async () => {
    const all = Array.from({ length: 450 }, (_, i) => message(i + 1));
    core((_c, args) => {
      const limit = args.limit as number;
      const offset = args.offset as number;
      return { items: all.slice(offset, offset + limit), total: all.length, limit, offset };
    });
    const seen: number[] = [];
    const out = await loadSessionMessages("abc", { onPage: (soFar) => seen.push(soFar.length) });
    expect(out.messages.map((m) => m.seq)).toEqual(all.map((m) => m.seq));
    expect(out.total).toBe(450);
    expect(out.truncated).toBe(false);
    expect(seen).toEqual([200, 400, 450]);
  });

  it("search passes the query and filter as `input` and returns the page", async () => {
    const fake = core(() => ({
      items: [
        {
          session_id: "s",
          message_id: "m",
          seq: 3,
          block_index: 1,
          kind: "tool",
          at: null,
          score: 2,
          text: "radar sweep",
          highlights: [[0, 5]],
          agent_id: "codex-cli",
          project_root: null,
          session_title: null,
          session_started_at: null,
        },
      ],
      limit: 20,
      offset: 0,
      has_more: true,
    }));
    const page = await searchPage("radar", { agent: "codex-cli", limit: 20 });
    expect(page.has_more).toBe(true);
    expect(page.items[0]).toMatchObject({ message_id: "m", seq: 3, block_index: 1, at: null });
    expect(fake.calls[0]).toEqual({ command: "search", args: { input: { query: "radar", agent: "codex-cli", limit: 20 } } });
  });

  it("import_now and import_diagnostics use the core's argument names", async () => {
    const fake = core((command) => (command === "import_now" ? { adapters: 2, sessions: 3, messages: 4 } : []));
    await expect(importNow()).resolves.toEqual({ adapters: 2, sessions: 3, messages: 4 });
    await importNow("codex-cli");
    await importDiagnostics();
    await importDiagnostics("f".repeat(64));
    expect(fake.calls.map((c) => [c.command, c.args])).toEqual([
      ["import_now", { agentId: null }],
      ["import_now", { agentId: "codex-cli" }],
      ["import_diagnostics", { sourceKey: null }],
      ["import_diagnostics", { sourceKey: "f".repeat(64) }],
    ]);
  });

  it("delivers import:progress", async () => {
    const fake = core(() => null);
    const got: unknown[] = [];
    await onImportProgress((p) => got.push(p));
    const payload = { agentId: "", phase: "finished", sessionsImported: 64, sessionsKnown: 64, error: null, projects: [] };
    fake.emit("import:progress", payload);
    expect(got).toEqual([payload]);
  });
});

describe("archive client without a core (mock, badged as demo data)", () => {
  it("search returns plain text plus ranges, never markup", async () => {
    const page = await searchPage("contrast");
    expect(page.items.length).toBeGreaterThan(0);
    for (const hit of page.items) {
      expect(hit.text).not.toContain("<mark>");
      for (const [a, b] of hit.highlights) expect(hit.text.slice(a, b).toLowerCase()).toBe("contrast");
    }
  });

  it("messages_page answers with contract messages for a mock session", async () => {
    const page = await messagesPage("sess-001");
    expect(page.total).toBeGreaterThan(0);
    expect(page.items.map((m) => m.seq)).toEqual([...page.items.map((m) => m.seq)].sort((a, b) => a - b));
  });
});

describe("highlightSegments", () => {
  it("splits on UTF-16 ranges, including after a non-BMP character", () => {
    const text = "\u{1F600} radar sweep";
    // the emoji is two UTF-16 code units, so "radar" starts at 3
    expect(highlightSegments(text, [[3, 8]])).toEqual([
      { text: "\u{1F600} ", hit: false },
      { text: "radar", hit: true },
      { text: " sweep", hit: false },
    ]);
  });

  it("tolerates unsorted, overlapping, empty and out of range ranges", () => {
    expect(highlightSegments("abcdef", [[4, 99], [0, 2], [1, 3], [5, 5]])).toEqual([
      { text: "abc", hit: true },
      { text: "d", hit: false },
      { text: "ef", hit: true },
    ]);
    expect(highlightSegments("", [[0, 3]])).toEqual([]);
  });
});

describe("agents client", () => {
  it("uses the real agents_list with a core and does not hide its errors behind mock data", async () => {
    const entry = {
      id: "claude-code",
      name: "Claude Code",
      vendor: "Anthropic",
      family: "anthropic",
      kind: "cli",
      installed: true,
      version: null,
      data_paths: [],
      default_data_paths: [],
      coverage: ["detect", "history"],
      docs_url: null,
    };
    core(() => [entry]);
    await expect(agentsList()).resolves.toEqual([entry]);
    shim?.uninstall();
    core(() => Promise.reject("boom"));
    await expect(agentsList()).rejects.toMatchObject({ code: "error" });
  });

  it("answers from the mock catalogue only without a core", async () => {
    await expect(agentsList()).resolves.toEqual(MOCK_AGENTS);
  });
});

describe("live client", () => {
  const live = (id: string, state: Live["state"], over: Partial<Live> = {}): Live => ({
    session_id: id,
    state,
    confidence: state === "unknown" ? "low" : "high",
    evidence: [{ kind: "native_waiting_signal", detail: "d", at: 1 }],
    observed_at: 10,
    ...over,
  });

  it("live_list comes from the core and errors are not replaced by mock data", async () => {
    core(() => [live("a", "working")]);
    await expect(liveList()).resolves.toHaveLength(1);
    shim?.uninstall();
    core(() => Promise.reject({ code: "live_failed", message: "lock" }));
    await expect(liveList()).rejects.toMatchObject({ code: "live_failed" });
  });

  it("delivers live:update lists", async () => {
    const fake = core(() => null);
    const got: Live[][] = [];
    await onLiveUpdate((list) => got.push(list));
    fake.emit("live:update", [live("a", "waiting")]);
    expect(got[0][0].state).toBe("waiting");
  });

  it("builds the Orrery model from live observations and archived sessions", () => {
    const lives = [
      live("a", "waiting", { since: 5 }),
      live("b", "working"),
      live("c", "unknown"),
      live("orphan", "idle"),
    ];
    const sessions = new Map<string, Session>([
      ["a", session("a", { project_root: "/p/skyline-weather", title: "Radar", turns: 12, started_at: 1 })],
      ["b", session("b", { project_root: "/p/skyline-weather", agent_id: "codex-cli" })],
      ["c", session("c", { project_root: "/p/nexus-gateway", parent_id: "a" })],
    ]);
    const families = new Map([
      ["claude-code", "anthropic"],
      ["codex-cli", "openai"],
    ]);
    const model = buildLiveModel(lives, sessions, families);
    expect(model.projects.map((p) => p.name).sort()).toEqual(["nexus-gateway", "skyline-weather", "unknown project"]);
    const a = model.sessions.find((s) => s.id === "a")!;
    expect(a).toMatchObject({ state: "waiting", family: "anthropic", title: "Radar", turns: 12, waiting_since: 5 });
    expect(model.sessions.find((s) => s.id === "b")!.family).toBe("openai");
    expect(model.sessions.find((s) => s.id === "c")!).toMatchObject({ state: "unknown", parent_id: "a" });
    const orphan = model.sessions.find((s) => s.id === "orphan")!;
    expect(orphan.project_root).toBe("");
    expect(orphan.title).toBe("Untitled session");
    // not archived yet: turns are unknown (0 only sizes the planet), and the model says so
    expect(orphan.archived).toBe(false);
    expect(a.archived).toBe(true);
    expect(model.telemetry).toEqual({ activePlanets: 3, needsYou: 1, working: 1, idle: 1, done: 0, unknown: 1 });
  });
});
