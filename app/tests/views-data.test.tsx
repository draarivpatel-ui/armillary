/**
 * Data side of the views, against a fake core (the presentation IPC shim) the way the real app talks to
 * the Rust core: Orrery, Field Guide, Switchboard, Almanac (plus its date picker) and Launchpad.
 * With a core there is no mock data anywhere and errors are shown, not hidden.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Live, Session } from "@armillary/model";
import { installIpcShim, type IpcShim } from "../src/presentation/ipcShim";
import { appNow, resetClientState } from "../src/api/client";
import { resetArchiveClient } from "../src/api/archive";
import { resetDisplayContext } from "../src/api/paths";
import { resetAgentsClient, type AgentWithInstall } from "../src/api/agents";
import { getMockLiveList, resetLiveCaches } from "../src/api/live";
import { StandaloneNavigation, useNavigation } from "../src/navigation";
import { OrreryView } from "../src/views/Orrery";
import { FieldGuideView } from "../src/views/FieldGuide";
import { Switchboard } from "../src/views/Switchboard/Switchboard";
import { Almanac } from "../src/views/Almanac/Almanac";
import { DateRangePicker } from "../src/views/Almanac/DateRangePicker";
import { Launchpad } from "../src/views/Launchpad/Launchpad";

// The canvas cannot draw in jsdom. This stand-in prints what it was given as text and offers one button per
// planet, so the tests can read the project names and select a planet.
vi.mock("@orrery/orrery", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    OrreryView: (props: {
      projects: Array<{ id: string; name: string }>;
      sessions: Array<{ id: string }>;
      wallEpochMs?: number;
      onSelectSession?: (s: unknown) => void;
    }) =>
      React.createElement(
        "div",
        { "data-testid": "orrery-canvas", "data-wall-epoch": String(props.wallEpochMs ?? "") },
        props.projects.map((p) => React.createElement("span", { key: p.id }, `project ${p.name}`)),
        props.sessions.map((s) =>
          React.createElement("button", { key: s.id, type: "button", onClick: () => props.onSelectSession?.(s) }, `planet ${s.id}`),
        ),
      ),
  };
});

vi.mock("@xterm/xterm", () => {
  class MockTerminal {
    open = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    loadAddon = vi.fn();
    focus = vi.fn();
    options = { theme: {}, fontFamily: "", cursorStyle: "block", cursorBlink: true };
    cols = 80;
    rows = 24;
  }
  return { Terminal: MockTerminal, default: { Terminal: MockTerminal } };
});

vi.mock("@xterm/addon-fit", () => {
  class MockFitAddon {
    fit = vi.fn();
  }
  return { FitAddon: MockFitAddon, default: { FitAddon: MockFitAddon } };
});

// ---------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------

function sid(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    agent_id: "claude-code",
    title: `Session ${id.slice(-3)}`,
    model: null,
    status: "done",
    turns: 3,
    started_at: 1_791_850_000_000,
    ended_at: 1_791_850_600_000,
    project_root: "/work/alpha",
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

function live(sessionId: string, state: Live["state"]): Live {
  const now = Date.now();
  return {
    session_id: sessionId,
    state,
    since: now - 5000,
    observed_at: now,
    confidence: "high",
    process: null,
    evidence: [],
    expires_at: null,
  };
}

function agent(i: number, over: Partial<AgentWithInstall> = {}): AgentWithInstall {
  const families = ["anthropic", "openai", "google", "cursor", "open-source-clis", "chinese-labs"];
  const kinds = ["cli", "desktop", "ide", "ide_extension"];
  return {
    id: `agent-${i}`,
    name: `Agent Number ${i}`,
    vendor: `Vendor ${i % 7}`,
    family: families[i % families.length],
    kind: kinds[i % kinds.length],
    installed: i % 4 === 0,
    version: i % 4 === 0 ? `v${i}.0` : null,
    data_paths: [],
    default_data_paths: [`~/.agent-${i}`],
    coverage: ["detect"],
    docs_url: null,
    homepage: null,
    ...over,
  } as AgentWithInstall;
}

type Handler = (command: string, args: Record<string, unknown>) => unknown;

let shim: IpcShim | null = null;

function core(handler: Handler): IpcShim {
  shim = installIpcShim((command, args) => {
    if (command === "ui_trace") return null;
    return handler(command, args);
  });
  return shim;
}

function callsOf(command: string): Array<Record<string, unknown>> {
  return (shim?.calls ?? []).filter((c) => c.command === command).map((c) => c.args);
}

beforeEach(() => {
  resetClientState();
  resetArchiveClient();
  resetAgentsClient();
  resetLiveCaches();
  resetDisplayContext();
});

afterEach(() => {
  // unmount first: unmounting unsubscribes from core events, which needs the fake core still installed
  cleanup();
  shim?.uninstall();
  shim = null;
  delete (window as unknown as Record<string, unknown>).__ARMILLARY_NOW__;
});

// ---------------------------------------------------------------------------------------------------------
// 1. Orrery
// ---------------------------------------------------------------------------------------------------------

describe("Orrery data", () => {
  const A = sid(1);
  const B = sid(2);
  const C = sid(3);

  function orreryCore(initial: Live[]) {
    return core((command, args) => {
      if (command === "live_list") return initial;
      if (command === "session_get") {
        return session(String(args.id), { title: `Real work ${String(args.id).slice(-1)}`, project_root: "/work/realproj" });
      }
      if (command === "agents_list") return [agent(1, { id: "claude-code", family: "anthropic" })];
      return null;
    });
  }

  function Probe() {
    const nav = useNavigation();
    return <output data-testid="nav">{`${nav.view}:${nav.folioTarget?.sessionId ?? "none"}`}</output>;
  }

  it("shows counts from the real live list, never the mock, and follows live:update", async () => {
    const s = orreryCore([live(A, "waiting")]);
    render(<OrreryView />);

    // not the mock's 3 needing you while the real list loads (figures read "<n><label>")
    const figures = () => screen.getByRole("group", { name: /live sessions/i });
    expect(figures()).not.toHaveTextContent("3need you");
    await waitFor(() => expect(figures()).toHaveTextContent("1needs you"));
    expect(figures()).toHaveTextContent("1session");
    expect(figures()).toHaveTextContent("0working");
    expect(await screen.findByText("project realproj")).toBeInTheDocument();

    for (const p of getMockLiveList().projects) {
      expect(screen.queryByText(new RegExp(p.name))).not.toBeInTheDocument();
    }

    await waitFor(() => expect(s.listenerCount("live:update")).toBe(1));
    act(() => {
      s.emit("live:update", [live(A, "waiting"), live(B, "waiting"), live(C, "working")]);
    });
    await waitFor(() => expect(figures()).toHaveTextContent("2need you"));
    expect(figures()).toHaveTextContent("1working");
    expect(figures()).toHaveTextContent("3sessions");
  });

  it("unsubscribes from live:update when it unmounts", async () => {
    const s = orreryCore([live(A, "idle")]);
    const view = render(<OrreryView />);
    await waitFor(() => expect(s.listenerCount("live:update")).toBe(1));
    view.unmount();
    await waitFor(() => expect(s.listenerCount("live:update")).toBe(0));
  });

  it("shows an empty model (no mock projects) when the core has nothing live", async () => {
    orreryCore([]);
    render(<OrreryView />);
    expect(await screen.findByText("No agent is running right now.")).toBeInTheDocument();
    expect(screen.queryByTestId("orrery-canvas")).not.toBeInTheDocument();
  });

  it("selecting a planet keeps its summary and offers one Open in Folio button", async () => {
    orreryCore([live(A, "waiting")]);
    render(
      <StandaloneNavigation initialView="orrery">
        <Probe />
        <OrreryView />
      </StandaloneNavigation>,
    );
    expect(screen.queryByRole("button", { name: "Open in Folio" })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: `planet ${A}` }));
    expect(screen.getByText(/Selected session/)).toBeInTheDocument();
    expect(screen.getByText(/Real work 1/)).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: "Open in Folio" });
    expect(buttons).toHaveLength(1);

    fireEvent.click(buttons[0]);
    expect(screen.getByTestId("nav").textContent).toBe(`folio:${A}`);
  });

  it("without a core the mock still renders", async () => {
    const mock = getMockLiveList();
    render(<OrreryView />);
    const figures = await screen.findByRole("group", { name: /live sessions/i });
    expect(figures).toHaveTextContent(`${mock.telemetry.needsYou}need you`);
    expect(screen.getByText(`project ${mock.projects[0].name}`)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------------------
// 2. Field Guide
// ---------------------------------------------------------------------------------------------------------

describe("Field Guide data", () => {
  it("counts the agents the core returned (80) and shows no Demo marks", async () => {
    const list = Array.from({ length: 80 }, (_, i) => agent(i));
    core((command) => (command === "agents_list" ? list : null));
    const { container } = render(<FieldGuideView />);
    expect(await screen.findByRole("group", { name: "Registry summary" })).toHaveTextContent(/80\s*agents/);
    expect(container.textContent).not.toMatch(/Demo/);
  });

  it("Import now invokes import_now with {agentId: null} and follows import:progress events", async () => {
    let finishImport: (summary: unknown) => void = () => {};
    const s = core((command) => {
      if (command === "agents_list") return [agent(1)];
      if (command === "import_now") return new Promise((resolve) => (finishImport = resolve));
      return null;
    });
    render(<FieldGuideView />);
    await screen.findByTestId("agent-card-agent-1");
    await waitFor(() => expect(s.listenerCount("import:progress")).toBe(1));

    const button = screen.getByTestId("import-now-button");
    fireEvent.click(button);
    await waitFor(() => expect(callsOf("import_now")).toEqual([{ agentId: null }]));

    const payload = (over: Record<string, unknown>) => ({
      agentId: "codex-cli",
      phase: "progress",
      sessionsImported: 0,
      sessionsKnown: 0,
      error: null,
      projects: [],
      ...over,
    });

    act(() => {
      s.emit("import:progress", payload({ agentId: "", phase: "started" }));
    });
    await waitFor(() => expect(button.textContent).toBe("Starting import..."));

    act(() => {
      s.emit("import:progress", payload({ phase: "started" }));
    });
    await waitFor(() => expect(button.textContent).toBe("Importing codex-cli (0 of 0 sessions)"));

    act(() => {
      s.emit("import:progress", payload({ phase: "progress", sessionsImported: 3, sessionsKnown: 12 }));
    });
    await waitFor(() => expect(button.textContent).toBe("Importing codex-cli (3 of 12 sessions)"));

    // An agent's failure lands in the existing import error line; the run goes on.
    act(() => {
      s.emit("import:progress", payload({ agentId: "claude-code", phase: "error", error: "archive is locked" }));
    });
    expect(await screen.findByText(/archive is locked/)).toBeInTheDocument();
    expect(button.textContent).toMatch(/^Importing /);

    // The run-level "finished" (empty agentId) ends the import display.
    act(() => {
      s.emit("import:progress", payload({ agentId: "", phase: "finished", sessionsImported: 3, sessionsKnown: 12 }));
    });
    await waitFor(() => expect(button.textContent).toBe("Import now"));
    await act(async () => finishImport({ adapters: 5, sessions: 3, messages: 9 }));
  });

  it("shows an import error instead of swallowing it", async () => {
    core((command) => {
      if (command === "agents_list") return [agent(1)];
      if (command === "import_now") return Promise.reject({ code: "import_failed", message: "disk is full" });
      return null;
    });
    render(<FieldGuideView />);
    await screen.findByTestId("agent-card-agent-1");
    fireEvent.click(screen.getByTestId("import-now-button"));
    expect(await screen.findByText(/disk is full/)).toBeInTheDocument();
    expect(screen.getByTestId("import-now-button").textContent).toBe("Import now");
  });

  it("an agents_list error shows an error line, not mock agents", async () => {
    core((command) => (command === "agents_list" ? Promise.reject({ code: "agents_failed", message: "detection exploded" }) : null));
    const { container } = render(<FieldGuideView />);
    expect(await screen.findByText(/detection exploded/)).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^agent-card-/)).toHaveLength(0);
    expect(container.textContent).not.toMatch(/Demo/);
    expect(screen.queryByText("Aider")).not.toBeInTheDocument();
  });

  it("exposes detection_note on the card as a title attribute", async () => {
    const note = "found on PATH but not counted: not a known install location";
    core((command) =>
      command === "agents_list" ? [agent(1, { detection_note: note }), agent(2)] : null,
    );
    render(<FieldGuideView />);
    expect(await screen.findByTestId("agent-card-agent-1")).toHaveAttribute("title", note);
    expect(screen.getByTestId("agent-card-agent-2")).not.toHaveAttribute("title");
  });

  it("goes through the API client only: no direct Tauri access in the view source", () => {
    const source = readFileSync(path.resolve(__dirname, "../src/views/FieldGuide/FieldGuideView.tsx"), "utf8");
    expect(source).not.toContain("__TAURI_INTERNALS__");
    expect(source).not.toContain("__TAURI__");
    expect(source).not.toContain("@tauri-apps");
  });
});

// ---------------------------------------------------------------------------------------------------------
// 3. Switchboard
// ---------------------------------------------------------------------------------------------------------

describe("Switchboard data", () => {
  it("shows the config_list error instead of loading forever", async () => {
    core((command) =>
      command === "config_list" ? Promise.reject({ code: "config_failed", message: "cannot read agent configs" }) : null,
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Switchboard />);
    expect(await screen.findByText(/cannot read agent configs/)).toBeInTheDocument();
    expect(screen.queryByText(/Loading agent configuration/)).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------------------------------------
// 4. Almanac
// ---------------------------------------------------------------------------------------------------------

describe("Almanac data", () => {
  const ROOTS = ["/work/alpha", "/srv/beta", "/home/u/gamma"];

  function archive(sessions: Session[]) {
    return core((command, args) => {
      if (command === "agents_list") return [];
      if (command === "sessions_query") {
        const q = (args.query ?? {}) as { project?: string; status?: string; limit?: number; offset?: number };
        const limit = q.limit ?? 50;
        if (limit < 1 || limit > 200) return Promise.reject({ code: "invalid_input", message: "limit must be 1 to 200" });
        const offset = q.offset ?? 0;
        let items = sessions.filter((s) => (q.project ? s.project_root === q.project : true));
        if (q.status) items = items.filter((s) => s.status === q.status);
        items = [...items].sort((a, b) => (b.started_at ?? -Infinity) - (a.started_at ?? -Infinity));
        return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
      }
      return null;
    });
  }

  function many(count: number): Session[] {
    return Array.from({ length: count }, (_, i) =>
      session(sid(1000 + i), {
        project_root: ROOTS[i % 3],
        status: i % 2 === 0 ? "done" : "idle",
        started_at: 1_791_850_000_000 - i * 60_000,
      }),
    );
  }

  /** The head's summary figures: a value beside its label, e.g. 450 sessions. */
  async function expectSummary(value: string, label: string, timeout = 1000) {
    await waitFor(
      () => {
        const figure = Array.from(document.querySelectorAll(".obs-figure")).find(
          (f) => f.querySelector(".obs-figure__label")?.textContent === label,
        );
        expect(figure?.querySelector(".obs-figure__value")?.textContent).toBe(value);
      },
      { timeout },
    );
  }

  function selectOptions(label: RegExp): Array<{ text: string; value: string }> {
    const select = screen.getByLabelText(label) as HTMLSelectElement;
    return within(select)
      .getAllByRole("option")
      .map((o) => ({ text: o.textContent ?? "", value: (o as HTMLOptionElement).value }));
  }

  it("loads every session by pages of 200 (never above 200)", async () => {
    archive(many(450));
    render(<Almanac />);
    await expectSummary("450", "sessions");

    const queries = callsOf("sessions_query").map((a) => a.query as { limit?: number; offset?: number });
    expect(queries.length).toBeGreaterThan(0);
    expect(Math.max(...queries.map((q) => q.limit ?? 0))).toBe(200);
    const offsets = new Set(queries.map((q) => q.offset ?? 0));
    expect(offsets.has(0) && offsets.has(200) && offsets.has(400)).toBe(true);
    expect(queries.every((q) => (q.limit ?? 0) <= 200)).toBe(true);
  });

  const SLOW = 10_000;
  it("offers the 3 project basenames with full roots as values, and filters by the full root", async () => {
    archive(many(450));
    render(<Almanac />);
    await expectSummary("450", "sessions", SLOW);

    await waitFor(() => expect(selectOptions(/^Project$/)).toHaveLength(4), { timeout: SLOW });
    expect(selectOptions(/^Project$/)).toEqual([
      { text: "All projects", value: "" },
      { text: "alpha", value: "/work/alpha" },
      { text: "beta", value: "/srv/beta" },
      { text: "gamma", value: "/home/u/gamma" },
    ]);

    fireEvent.change(screen.getByLabelText(/^Project$/), { target: { value: "/srv/beta" } });
    await expectSummary("150", "sessions", SLOW);
    const projectQueries = callsOf("sessions_query")
      .map((a) => a.query as { project?: string })
      .filter((q) => q.project !== undefined);
    expect(projectQueries.length).toBeGreaterThan(0);
    expect(projectQueries.every((q) => q.project === "/srv/beta")).toBe(true);
    // R2-RC-6: 450 rendered sessions take 6 to 9 s on a loaded machine; the work is the same, only
    // the budget is wider than vitest's 5 s default.
  }, 30_000);

  it("builds the status options from the statuses present in the loaded sessions", async () => {
    archive(many(450));
    render(<Almanac />);
    await expectSummary("450", "sessions");
    // two statuses: a segmented control, "All" first, then one segment per status present
    const group = await screen.findByRole("radiogroup", { name: "Status" });
    await waitFor(() =>
      expect(within(group).getAllByRole("radio").map((r) => r.textContent)).toEqual(["All", "Finished", "Idle"]),
    );
  });

  it("lists a session with an unknown start under an unknown date heading", async () => {
    archive([
      session(sid(1), { title: "Dated one", started_at: 1_791_850_000_000 }),
      session(sid(2), { title: "Undated one", started_at: null, ended_at: null }),
      session(sid(3), { title: "Dated two", started_at: 1_791_800_000_000 }),
    ]);
    render(<Almanac />);
    const undated = await screen.findByText("Undated one");
    expect(screen.getByRole("heading", { name: "Undated" })).toBeInTheDocument();
    const item = undated.closest("[data-testid='almanac-session-item']") as HTMLElement;
    expect(within(item).getByTestId("session-duration").textContent).toBe("duration unknown");
    expect(screen.getByText("Dated one")).toBeInTheDocument();
    expect(screen.getByText("Dated two")).toBeInTheDocument();
  });

  it("opens a session by id", async () => {
    archive([session(sid(7), { title: "Open me" })]);
    const onOpen = vi.fn();
    render(<Almanac onOpenSession={onOpen} />);
    fireEvent.click(await screen.findByText("Open me"));
    expect(onOpen).toHaveBeenCalledWith(sid(7));
  });

  it("shows a sessions_query error instead of an empty calendar", async () => {
    core((command) => {
      if (command === "agents_list") return [];
      if (command === "sessions_query") return Promise.reject({ code: "archive_failed", message: "archive is locked" });
      return null;
    });
    render(<Almanac />);
    expect(await screen.findByText(/archive is locked/)).toBeInTheDocument();
    expect(screen.queryByTestId("almanac-session-item")).not.toBeInTheDocument();
  });
});

describe("appNow and the date picker", () => {
  it("appNow returns __ARMILLARY_NOW__ when it is a finite number, Date.now() otherwise", () => {
    const w = window as unknown as Record<string, unknown>;
    w.__ARMILLARY_NOW__ = 1_800_000_000_000;
    expect(appNow()).toBe(1_800_000_000_000);

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "1800000000000", null, undefined]) {
      w.__ARMILLARY_NOW__ = bad;
      const before = Date.now();
      const got = appNow();
      expect(got).toBeGreaterThanOrEqual(before);
      expect(got).toBeLessThanOrEqual(Date.now());
    }

    delete w.__ARMILLARY_NOW__;
    const before = Date.now();
    expect(appNow()).toBeGreaterThanOrEqual(before);
  });

  it("anchors today, the presets and the default month on appNow()", async () => {
    (window as unknown as Record<string, unknown>).__ARMILLARY_NOW__ = new Date(2031, 2, 15, 12, 0).getTime();
    const onChange = vi.fn();
    render(<DateRangePicker onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /Date range/i }));
    expect(screen.getByTestId("calendar-month-heading").textContent).toMatch(/March/);
    expect(screen.getByTestId("calendar-month-heading").textContent).toMatch(/2031/);
    expect(document.querySelector(".obs-calendar-day--today")?.textContent).toBe("15");

    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(onChange).toHaveBeenLastCalledWith("2031-03-15", "2031-03-15");

    fireEvent.click(screen.getByRole("button", { name: /Date range/i }));
    fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    expect(onChange).toHaveBeenLastCalledWith("2031-03-09", "2031-03-15");

    fireEvent.click(screen.getByRole("button", { name: /Date range/i }));
    fireEvent.click(screen.getByRole("button", { name: "Last 30 days" }));
    expect(onChange).toHaveBeenLastCalledWith("2031-02-14", "2031-03-15");
  });
});

// ---------------------------------------------------------------------------------------------------------
// 5. Launchpad
// ---------------------------------------------------------------------------------------------------------

describe("Launchpad data", () => {
  function launchpadCore(sessions: Session[]) {
    return core((command) => {
      if (command === "agents_list") return [agent(1, { id: "claude", name: "Claude Code", kind: "cli", installed: true })];
      if (command === "sessions_query") return { items: sessions, total: sessions.length, limit: 200, offset: 0 };
      if (command === "pty_open") return { id: "pty-1", agent_id: "claude", cwd: "/work/alpha" };
      return null;
    });
  }

  it("defaults the project folder to the first project root and uses it for pty_open and pty_close", async () => {
    launchpadCore([
      session(sid(1), { project_root: "/work/alpha" }),
      session(sid(2), { project_root: "/srv/beta" }),
      session(sid(3), { project_root: "/work/alpha" }),
    ]);
    render(<Launchpad />);

    const folder = screen.getByLabelText(/Project folder/i);
    await waitFor(() => expect(folder).toHaveValue("/work/alpha"));
    expect(folder).not.toHaveValue("~/Projects/agent-hub");

    const launch = await screen.findByRole("button", { name: "Launch Claude Code" });
    await waitFor(() => expect(launch).toBeEnabled());
    fireEvent.click(launch);
    await waitFor(() => expect(callsOf("pty_open")).toHaveLength(1));
    expect(callsOf("pty_open")[0]).toEqual({ agentId: "claude", agent_id: "claude", cwd: "/work/alpha" });

    fireEvent.click(await screen.findByRole("button", { name: "Close Claude Code" }));
    await waitFor(() => expect(callsOf("pty_close")).toEqual([{ id: "pty-1" }]));
  });

  it("has no default folder when there are no project roots", async () => {
    const s = launchpadCore([]);
    render(<Launchpad />);
    await waitFor(() => expect(s.calls.some((c) => c.command === "sessions_query")).toBe(true));
    await screen.findAllByText("Claude Code");
    const folder = screen.getByLabelText(/Project folder/i);
    expect(folder).toHaveValue("");
    expect(folder).not.toHaveValue("~/Projects/agent-hub");
  });

  it("keeps a folder the user typed even if the roots arrive later", async () => {
    launchpadCore([session(sid(1), { project_root: "/work/alpha" })]);
    render(<Launchpad />);
    const folder = screen.getByLabelText(/Project folder/i);
    fireEvent.change(folder, { target: { value: "/my/own/folder" } });
    await waitFor(() => expect(callsOf("sessions_query").length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(folder).toHaveValue("/my/own/folder");
  });
});

describe("Orrery clock seam", () => {
  it("anchors the canvas wall clock on appNow(), so sample data shows waiting times from its reference time", async () => {
    const id = "c".repeat(64);
    const shim = installIpcShim((command) => {
      if (command === "live_list") {
        return [{ session_id: id, state: "waiting", confidence: "high", evidence: [{ kind: "native_waiting_signal", detail: "d", at: 1 }], observed_at: 1, since: 1_791_828_000_000 }];
      }
      if (command === "session_get") return Promise.reject({ code: "not_found", message: "not archived" });
      if (command === "agents_list") return [];
      return null;
    });
    (window as unknown as { __ARMILLARY_NOW__?: number }).__ARMILLARY_NOW__ = 1_791_828_000_000;
    try {
      render(<OrreryView />);
      await waitFor(() =>
        expect(document.querySelector("[data-testid='orrery-canvas']")?.getAttribute("data-wall-epoch")).toBe("1791828000000"),
      );
    } finally {
      delete (window as unknown as { __ARMILLARY_NOW__?: number }).__ARMILLARY_NOW__;
      cleanup();
      shim.uninstall();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// Home-relative paths: the UI shows "~", never the user's home folder
// ---------------------------------------------------------------------------------------------------------

describe("Home-relative paths", () => {
  // macOS temp homes show up as /private/tmp/...: the core reports both spellings.
  const HOME = "/tmp/demo-home";
  const HOME_CANONICAL = "/private/tmp/demo-home";

  function homeCore(extra: Handler) {
    return core((command, args) => {
      if (command === "display_context") return { home: HOME, home_canonical: HOME_CANONICAL };
      return extra(command, args);
    });
  }

  it("the Field Guide shows ~/.aider and never the absolute home", async () => {
    homeCore((command) =>
      command === "agents_list"
        ? [
            agent(1, { id: "aider", installed: true, data_paths: [`${HOME_CANONICAL}/.aider`], default_data_paths: ["~/.aider"] }),
            agent(2, { id: "amp", installed: false, data_paths: [], default_data_paths: [`${HOME}/.amp/threads`] }),
          ]
        : null,
    );
    const { container } = render(<FieldGuideView />);
    await screen.findByTestId("agent-card-aider");
    await waitFor(() => {
      expect(within(screen.getByTestId("agent-card-aider")).getByText((_, el) => el?.className === "fg-entry__path" && el.textContent === "~/.aider")).toBeInTheDocument();
    });
    expect(container.textContent).toContain("~/.amp/threads");
    expect(container.textContent).not.toContain("/tmp/demo-home");
    expect(container.textContent).not.toContain("/private/tmp");
  });

  it("the Almanac shows the project path as ~/projects/x for a root under home", async () => {
    homeCore((command) => {
      if (command === "agents_list") return [];
      if (command === "sessions_query") {
        const items = [session(sid(1), { project_root: `${HOME_CANONICAL}/projects/x` })];
        return { items, total: 1, limit: 200, offset: 0 };
      }
      return null;
    });
    const { container } = render(<Almanac />);
    const path = await waitFor(() => {
      const el = container.querySelector(".almanac-project__path");
      expect(el).not.toBeNull();
      expect(el!.textContent).toBe("~/projects/x");
      return el as HTMLElement;
    });
    expect(path.getAttribute("title")).toBe("~/projects/x");
    expect(container.textContent).not.toContain("/private/tmp");
  });

  it("the Launchpad shows the terminal folder and the project chip with ~", async () => {
    homeCore((command) => {
      if (command === "agents_list") return [agent(1, { id: "claude", name: "Claude Code", kind: "cli", installed: true })];
      if (command === "sessions_query") {
        const items = [
          session(sid(1), { project_root: `${HOME}/work/same` }),
          session(sid(2), { project_root: "/srv/other/same" }),
        ];
        return { items, total: 2, limit: 200, offset: 0 };
      }
      if (command === "pty_open") return { id: "pty-1", agent_id: "claude", cwd: `${HOME}/work/same` };
      return null;
    });
    render(<Launchpad />);
    // two roots share the folder name "same", so the chips are labelled with the path
    fireEvent.click(await screen.findByRole("button", { name: "~/work/same" }));
    const launch = await screen.findByRole("button", { name: "Launch Claude Code" });
    await waitFor(() => expect(launch).toBeEnabled());
    fireEvent.click(launch);
    await waitFor(() => expect(screen.getByTestId("terminal-cwd")).toHaveTextContent("~/work/same"));
    expect(screen.getByTestId("terminal-cwd").textContent).not.toContain("/tmp/demo-home");
    // the logic still uses the absolute folder
    expect(callsOf("pty_open")[0].cwd).toBe(`${HOME}/work/same`);
  });
});

describe("Display titles and activity spans in the views", () => {
  it("the Almanac shows the derived title and the activity span instead of Untitled and duration unknown", async () => {
    const row = {
      id: "d".repeat(64),
      agent_id: "claude-code",
      title: null,
      display_title: "Fix the flaky login test.",
      title_source: "first_prompt",
      first_activity_at: 1_791_800_000_000,
      last_activity_at: 1_791_800_000_000 + 28 * 60_000,
      project_root: "/work/alpha",
      started_at: 1_791_800_000_000,
      ended_at: null,
      status: "unknown",
      turns: 3,
      usage: { observations: [], semantics: "unknown" },
      provenance: {
        adapter_id: "claude-code",
        adapter_version: "1",
        checkpoint: { digest: "d", offset: 0, records: 0, revision: 1 },
        file_identity: "f",
        generation: 1,
        source_id: "s",
        source_path: "a.jsonl",
        store: { canonical_root: "/x", id: "st", namespace: "claude-history", profile_id: "p" },
      },
    };
    const shim = installIpcShim((command) => {
      if (command === "sessions_query") return { items: [row], total: 1, limit: 200, offset: 0 };
      if (command === "agents_list") return [];
      if (command === "display_context") return { home: null, home_canonical: null };
      return null;
    });
    try {
      const { AlmanacView } = await import("../src/views/AlmanacView");
      render(<AlmanacView />);
      expect(await screen.findByText("Fix the flaky login test.")).toBeInTheDocument();
      expect(screen.queryByText("Untitled session")).toBeNull();
      expect(document.body.textContent).toContain("28m of activity");
    } finally {
      cleanup();
      shim.uninstall();
    }
  });
});
