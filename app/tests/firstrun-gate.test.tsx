import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installIpcShim, type IpcShim } from "../src/presentation/ipcShim";
import { resetClientState } from "../src/api/client";
import { FIRSTRUN_EVENT, RecordedSource } from "@orrery/firstrun";
import type { CoreEvent, FirstRunPlan, HandoffTarget } from "@orrery/firstrun";
import { FirstRunGate } from "../src/firstrun/FirstRunGate";
import { computeLayout, type Session } from "@orrery/orrery";
import { ORRERY_LAYOUT_SEED } from "../src/firstrun/target";
import { getMockLiveList } from "../src/api/live";
import { TauriFirstRunSource, resetInCore, statusFromCore } from "../src/firstrun/events";
import { firstRunForced, readLocalStatus, shouldShowFirstRun, writeLocalStatus } from "../src/firstrun/status";

// The real FirstRun needs WebGL; the gate only talks to it through its props. This stub records them and
// exposes buttons for the host's callbacks. Everything else in @orrery/firstrun (the parsers) stays real.
const stub = vi.hoisted(() => ({
  props: null as null | Record<string, any>,
  mounts: 0,
  unmounts: 0,
}));

vi.mock("@orrery/firstrun", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@orrery/firstrun")>();
  const R = await import("react");
  function FirstRun(props: Record<string, any>) {
    stub.props = props;
    R.useEffect(() => {
      stub.mounts += 1;
      return () => {
        stub.unmounts += 1;
      };
    }, []);
    const h = R.createElement;
    return h(
      "div",
      { "data-testid": "firstrun-stub" },
      h("button", { type: "button", onClick: () => props.onHandoffStart?.() }, "stub-handoff"),
      h("button", { type: "button", onClick: () => props.onAppAlpha?.(0.4) }, "stub-alpha"),
      h("button", { type: "button", onClick: () => props.onComplete?.({ declined: false, skipped: false }) }, "stub-complete"),
      h("button", { type: "button", onClick: () => props.onComplete?.({ declined: true, skipped: false }) }, "stub-decline"),
    );
  }
  return { ...actual, FirstRun };
});

type Handler = (command: string, args: Record<string, unknown>) => unknown;

let shim: IpcShim | null = null;
let withStage = false;

function core(overrides: Record<string, unknown | Handler> = {}): IpcShim {
  const defaults: Record<string, unknown> = {
    firstrun_status: { consented: false, completed: false },
    firstrun_reset: null,
    firstrun_fps_enabled: false,
    live_list: [],
    agents_list: [],
  };
  shim = installIpcShim((command, args) => {
    const v = command in overrides ? overrides[command] : defaults[command];
    return typeof v === "function" ? (v as Handler)(command, args) : v ?? null;
  });
  return shim;
}

function App({ api }: { api: { replay: () => void } }) {
  return (
    <div data-testid="app-child">
      <button type="button" onClick={api.replay}>
        replay
      </button>
      {withStage ? (
        <div data-orrery-stage="" data-testid="stage">
          <canvas />
        </div>
      ) : null}
    </div>
  );
}

function gate() {
  return render(<FirstRunGate>{(api) => <App api={api} />}</FirstRunGate>);
}

const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const root = () => document.querySelector("[data-app-root]") as HTMLElement | null;

beforeEach(() => {
  resetClientState();
  localStorage.clear();
  stub.props = null;
  stub.mounts = 0;
  stub.unmounts = 0;
  withStage = false;
  window.history.replaceState({}, "", "/");
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  cleanup();
  shim?.uninstall();
  shim = null;
  window.history.replaceState({}, "", "/");
});

describe("first-run status helpers", () => {
  it("forces the first run only for ?firstrun=1", () => {
    expect(firstRunForced("?firstrun=1")).toBe(true);
    expect(firstRunForced("?a=b&firstrun=1")).toBe(true);
    expect(firstRunForced("")).toBe(false);
    expect(firstRunForced("?firstrun=0")).toBe(false);
    expect(firstRunForced("?presentation=1")).toBe(false);
  });

  it("shows the first run when forced or not completed, never otherwise", () => {
    const done = { consented: true, completed: true };
    const fresh = { consented: false, completed: false };
    expect(shouldShowFirstRun({ forced: false, status: fresh })).toBe(true);
    expect(shouldShowFirstRun({ forced: false, status: done })).toBe(false);
    expect(shouldShowFirstRun({ forced: true, status: done })).toBe(true);
    expect(shouldShowFirstRun({ forced: true, status: fresh })).toBe(true);
  });

  it("keeps the browser status under armillary.firstrun and merges patches", () => {
    expect(readLocalStatus()).toEqual({ consented: false, completed: false });
    writeLocalStatus({ consented: true });
    expect(JSON.parse(localStorage.getItem("armillary.firstrun")!)).toEqual({ consented: true, completed: false });
    writeLocalStatus({ completed: true });
    expect(JSON.parse(localStorage.getItem("armillary.firstrun")!)).toEqual({ consented: true, completed: true });
    expect(readLocalStatus()).toEqual({ consented: true, completed: true });
  });

  it("treats unreadable browser status as not started", () => {
    localStorage.setItem("armillary.firstrun", "{not json");
    expect(readLocalStatus()).toEqual({ consented: false, completed: false });
    localStorage.setItem("armillary.firstrun", JSON.stringify({ completed: "yes" }));
    expect(readLocalStatus()).toEqual({ consented: false, completed: false });
  });
});

describe("FirstRunGate with a core", () => {
  it("shows an ink screen, not the app, until firstrun_status answers", async () => {
    let answer: (v: unknown) => void = () => {};
    core({ firstrun_status: () => new Promise((r) => (answer = r)) });
    gate();
    expect(document.querySelector("[data-firstrun-pending]")).not.toBeNull();
    expect(screen.queryByTestId("app-child")).toBeNull();
    expect(screen.queryByTestId("firstrun-stub")).toBeNull();
    await act(async () => answer({ consented: true, completed: true }));
    await waitFor(() => expect(screen.getByTestId("app-child")).toBeInTheDocument());
    expect(document.querySelector("[data-firstrun-pending]")).toBeNull();
  });

  it("shows the first run when firstrun_status says not completed", async () => {
    core({ firstrun_status: { consented: false, completed: false } });
    gate();
    expect(await screen.findByTestId("firstrun-stub")).toBeInTheDocument();
    expect(document.querySelector("[data-firstrun-pending]")).toBeNull();
    expect(stub.props!.source).toBeInstanceOf(TauriFirstRunSource);
  });

  it("?firstrunSource=recorded replays the recorded log even with a core (captures over the presentation snapshot)", async () => {
    core({ firstrun_status: { consented: true, completed: true } });
    window.history.replaceState({}, "", "/?firstrun=1&firstrunSource=recorded");
    gate();
    await screen.findByTestId("firstrun-stub");
    await waitFor(() => expect(stub.props!.source).toBeInstanceOf(RecordedSource));
  });

  it("does not show the first run when firstrun_status says completed", async () => {
    core({ firstrun_status: { consented: true, completed: true } });
    gate();
    const child = await screen.findByTestId("app-child");
    expect(screen.queryByTestId("firstrun-stub")).toBeNull();
    expect(child.closest("[inert]")).toBeNull();
    expect(child.closest("[aria-hidden]")).toBeNull();
  });

  it("?firstrun=1 shows it even when completed", async () => {
    window.history.replaceState({}, "", "/?firstrun=1");
    core({ firstrun_status: { consented: true, completed: true } });
    gate();
    expect(await screen.findByTestId("firstrun-stub")).toBeInTheDocument();
  });

  it("treats a failing firstrun_status as a first launch", async () => {
    core({ firstrun_status: () => Promise.reject({ code: "error", message: "boom" }) });
    gate();
    expect(await screen.findByTestId("firstrun-stub")).toBeInTheDocument();
  });

  it("does not write browser storage when a core handles completion", async () => {
    core();
    gate();
    await screen.findByTestId("firstrun-stub");
    click("stub-handoff");
    click("stub-complete");
    await waitFor(() => expect(screen.queryByTestId("firstrun-stub")).toBeNull());
    expect(localStorage.getItem("armillary.firstrun")).toBeNull();
  });

  it("passes no fpsLog unless firstrun_fps_enabled is true", async () => {
    core({ firstrun_fps_enabled: false });
    gate();
    await screen.findByTestId("firstrun-stub");
    await waitFor(() => expect(shim!.calls.some((c) => c.command === "firstrun_fps_enabled")).toBe(true));
    expect(stub.props!.fpsLog).toBeUndefined();
  });

  it("reports frame times through firstrun_fps_report when enabled", async () => {
    core({ firstrun_fps_enabled: true });
    gate();
    await screen.findByTestId("firstrun-stub");
    await waitFor(() => expect(typeof stub.props!.fpsLog).toBe("function"));
    stub.props!.fpsLog("p50 8.3ms");
    await waitFor(() =>
      expect(shim!.calls.filter((c) => c.command === "firstrun_fps_report")).toEqual([
        { command: "firstrun_fps_report", args: { line: "p50 8.3ms" } },
      ]),
    );
    expect(shim!.calls.filter((c) => c.command === "firstrun_fps_enabled")).toHaveLength(1);
  });
});

describe("FirstRunGate without a core", () => {
  it("reads the status from localStorage: shows when empty, hides when completed", async () => {
    gate();
    expect(await screen.findByTestId("firstrun-stub")).toBeInTheDocument();
    cleanup();
    localStorage.setItem("armillary.firstrun", JSON.stringify({ consented: true, completed: true }));
    gate();
    expect(await screen.findByTestId("app-child")).toBeInTheDocument();
    expect(screen.queryByTestId("firstrun-stub")).toBeNull();
  });

  it("replays the recorded mock event log, not a core", async () => {
    gate();
    await screen.findByTestId("firstrun-stub");
    await waitFor(() => expect(stub.props!.source).toBeInstanceOf(RecordedSource));
    const source = stub.props!.source as RecordedSource;
    expect(source.recorded.events.length).toBeGreaterThan(0);
  });

  it("?firstrun=1 shows it even when completed", async () => {
    localStorage.setItem("armillary.firstrun", JSON.stringify({ consented: true, completed: true }));
    window.history.replaceState({}, "", "/?firstrun=1");
    gate();
    expect(await screen.findByTestId("firstrun-stub")).toBeInTheDocument();
  });

  it("writes completed true and consented true when the first run completes", async () => {
    gate();
    await screen.findByTestId("firstrun-stub");
    click("stub-handoff");
    click("stub-complete");
    await waitFor(() => expect(screen.queryByTestId("firstrun-stub")).toBeNull());
    expect(JSON.parse(localStorage.getItem("armillary.firstrun")!)).toEqual({ consented: true, completed: true });
  });

  it("writes consented false when the visitor declined", async () => {
    gate();
    await screen.findByTestId("firstrun-stub");
    click("stub-handoff");
    click("stub-decline");
    await waitFor(() => expect(screen.queryByTestId("firstrun-stub")).toBeNull());
    expect(JSON.parse(localStorage.getItem("armillary.firstrun")!)).toMatchObject({ consented: false, completed: true });
  });
});

describe("FirstRunGate hand-over", () => {
  it("mounts the app only after onHandoffStart, hidden from assistive tech and inert until complete", async () => {
    gate();
    await screen.findByTestId("firstrun-stub");
    expect(screen.queryByTestId("app-child")).toBeNull();

    click("stub-handoff");
    const child = await screen.findByTestId("app-child");
    const container = root()!;
    expect(container).not.toBeNull();
    expect(container.contains(child)).toBe(true);
    expect(container).toHaveAttribute("aria-hidden", "true");
    expect(container.hasAttribute("inert")).toBe(true);

    click("stub-complete");
    await waitFor(() => expect(screen.queryByTestId("firstrun-stub")).toBeNull());
    expect(screen.getByTestId("app-child")).toBe(child);
    expect(root()!.hasAttribute("inert")).toBe(false);
    expect(root()!.hasAttribute("aria-hidden")).toBe(false);
    expect(root()!.style.opacity).toBe("1");
  });

  it("sets the app opacity straight from onAppAlpha", async () => {
    gate();
    await screen.findByTestId("firstrun-stub");
    click("stub-handoff");
    await screen.findByTestId("app-child");
    click("stub-alpha");
    expect(root()!.style.opacity).toBe("0.4");
  });

  it("keeps the app mounted through a repeated onHandoffStart", async () => {
    gate();
    await screen.findByTestId("firstrun-stub");
    click("stub-handoff");
    const child = await screen.findByTestId("app-child");
    click("stub-handoff");
    expect(screen.getByTestId("app-child")).toBe(child);
  });
});

describe("FirstRunGate replay", () => {
  async function completeFirstRun() {
    await screen.findByTestId("firstrun-stub");
    click("stub-handoff");
    const child = await screen.findByTestId("app-child");
    click("stub-complete");
    await waitFor(() => expect(screen.queryByTestId("firstrun-stub")).toBeNull());
    return child;
  }

  it("with a core: resets the core, shows the first run again and keeps the app mounted underneath", async () => {
    core();
    gate();
    const child = await completeFirstRun();
    expect(stub.mounts).toBe(1);

    click("replay");
    expect(await screen.findByTestId("firstrun-stub")).toBeInTheDocument();
    expect(shim!.calls.filter((c) => c.command === "firstrun_reset")).toHaveLength(1);
    expect(screen.getByTestId("app-child")).toBe(child);
    expect(root()!.hasAttribute("inert")).toBe(true);
    expect(root()!.getAttribute("aria-hidden")).toBe("true");
    expect(stub.mounts).toBe(2);

    click("stub-complete");
    await waitFor(() => expect(screen.queryByTestId("firstrun-stub")).toBeNull());
    expect(screen.getByTestId("app-child")).toBe(child);
    expect(root()!.hasAttribute("inert")).toBe(false);
  });

  it("without a core: writes completed false and shows the first run again", async () => {
    gate();
    await completeFirstRun();
    expect(JSON.parse(localStorage.getItem("armillary.firstrun")!).completed).toBe(true);

    click("replay");
    expect(await screen.findByTestId("firstrun-stub")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("armillary.firstrun")!).completed).toBe(false);
    expect(screen.getByTestId("app-child")).toBeInTheDocument();
  });
});

describe("FirstRunGate getTarget", () => {
  const rect = { left: 10, top: 20, width: 900, height: 600, right: 910, bottom: 620, x: 10, y: 20, toJSON: () => ({}) };

  async function ready(): Promise<(ms?: number) => HandoffTarget | null> {
    gate();
    await screen.findByTestId("firstrun-stub");
    click("stub-handoff");
    await screen.findByTestId("app-child");
    return (ms?: number) => (stub.props!.getTarget as (ms?: number) => HandoffTarget | null)(ms);
  }

  it("is null while the app has no Orrery stage", async () => {
    const getTarget = await ready();
    expect(getTarget(0)).toBeNull();
    expect(getTarget()).toBeNull();
  });

  it("measures the stage and lays out the live model once the Orrery is on screen", async () => {
    withStage = true;
    gate();
    await screen.findByTestId("firstrun-stub");
    const stage = () => screen.getByTestId("stage");
    click("stub-handoff");
    await screen.findByTestId("stage");
    vi.spyOn(stage(), "getBoundingClientRect").mockReturnValue(rect as DOMRect);
    const getTarget = (ms?: number) => (stub.props!.getTarget as (ms?: number) => HandoffTarget | null)(ms);

    await waitFor(() => expect(getTarget(0)).not.toBeNull());
    const t = getTarget(0)!;
    expect(t.stage).toEqual({ x: 10, y: 20, w: 900, h: 600 });
    expect(t.theme).toBe("dark");
    expect(t.suns.length).toBeGreaterThan(0);
    expect(t.planets.length).toBeGreaterThan(0);

    document.documentElement.setAttribute("data-theme", "light");
    expect(getTarget(0)!.theme).toBe("light");
  });

  it("defaults the landing time so it also works when the host passes no argument", async () => {
    withStage = true;
    gate();
    await screen.findByTestId("firstrun-stub");
    click("stub-handoff");
    const stage = await screen.findByTestId("stage");
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(rect as DOMRect);
    const getTarget = (ms?: number) => (stub.props!.getTarget as (ms?: number) => HandoffTarget | null)(ms);
    await waitFor(() => expect(getTarget()).not.toBeNull());
  });
});

describe("FirstRunGate getTarget with the Orrery's own hook", () => {
  const rect = { left: 10, top: 20, width: 900, height: 600, right: 910, bottom: 620, x: 10, y: 20, toJSON: () => ({}) };

  it("asks the stage's __armillaryOrrery.layoutAt for now() plus the time until landing, and needs no live model", async () => {
    withStage = true;
    // a core whose live list never answers: the exact path must not wait for it
    core({ firstrun_status: { consented: false, completed: false }, live_list: () => new Promise(() => {}) });
    gate();
    await screen.findByTestId("firstrun-stub");
    click("stub-handoff");
    const stage = await screen.findByTestId("stage");
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(rect as DOMRect);

    const mock = getMockLiveList();
    const layout = computeLayout(mock.projects, mock.sessions as unknown as Session[], { width: 900, height: 600, seed: ORRERY_LAYOUT_SEED });
    const planets = layout.planets.map((p) => ({ ...p, angle: 2, currentX: 400, currentY: 300 }));
    const layoutAt = vi.fn((_t: number) => ({ ...layout, planets }));
    (stage as unknown as Record<string, unknown>).__armillaryOrrery = { getLayout: () => layout, layoutAt, now: () => 5000 };

    const getTarget = stub.props!.getTarget as (ms?: number) => HandoffTarget | null;
    const t = getTarget(1500)!;
    expect(t).not.toBeNull();
    expect(layoutAt).toHaveBeenCalledWith(6500);
    expect(t.stage).toEqual({ x: 10, y: 20, w: 900, h: 600 });
    expect(t.suns).toHaveLength(layout.suns.length);
    expect(t.planets).toHaveLength(planets.length);
    expect(t.planets[0].angle).toBe(2);
    expect(t.planets[0].x).toBeCloseTo(10 + 400, 5);
    expect(t.planets[0].y).toBeCloseTo(20 + 300, 5);
    expect(getTarget()).not.toBeNull();
    expect(layoutAt).toHaveBeenLastCalledWith(5000 + 2950);
  });
});

describe("TauriFirstRunSource", () => {
  const NAMES = Object.values(FIRSTRUN_EVENT);

  const catalogue = { platform: "macos", entries: [{ id: "claude-code", name: "Claude Code", vendor: "Anthropic", family: "anthropic", kind: "cli", history: true }] };
  const agent = { id: "claude-code", found: true, version: null, folders: ["~/.claude"], history: true };
  const done = { constellations: [], liveSessions: 0, sessionsImported: 3, agentsFound: 1, catalogueSize: 1, errors: 0 };

  const scanCalls = (s: IpcShim) => s.calls.map((c) => c.command);

  it("plan() parses firstrun_plan and rejects when the core answers nonsense", async () => {
    const plan: FirstRunPlan = { platform: "macos", entries: [], folders: ["~/.claude"] };
    core({ firstrun_plan: plan });
    await expect(new TauriFirstRunSource().plan()).resolves.toEqual(plan);
    shim!.uninstall();
    core({ firstrun_plan: null });
    await expect(new TauriFirstRunSource().plan()).rejects.toBeTruthy();
  });

  it("consent() and complete() call their commands, statusFromCore and resetInCore likewise", async () => {
    core({ firstrun_status: { consented: true, completed: false } });
    const source = new TauriFirstRunSource();
    await source.consent(true);
    await source.consent(false);
    await source.complete();
    await expect(statusFromCore()).resolves.toEqual({ consented: true, completed: false });
    await resetInCore();
    expect(shim!.calls).toEqual([
      { command: "firstrun_consent", args: { accepted: true } },
      { command: "firstrun_consent", args: { accepted: false } },
      { command: "firstrun_complete", args: {} },
      { command: "firstrun_status", args: {} },
      { command: "firstrun_reset", args: {} },
    ]);
  });

  it("scan() listens to all four events BEFORE it invokes firstrun_scan", async () => {
    let listenersAtScan: number[] = [];
    core({
      firstrun_scan: () => {
        listenersAtScan = NAMES.map((n) => shim!.listenerCount(n));
        return null;
      },
    });
    const promise = new TauriFirstRunSource().scan(() => {});
    await waitFor(() => expect(scanCalls(shim!)).toContain("firstrun_scan"));
    expect(listenersAtScan).toEqual([1, 1, 1, 1]);
    shim!.emit(FIRSTRUN_EVENT.done, done);
    await promise;
  });

  it("scan() forwards parsed events without an offset and ignores malformed ones", async () => {
    core();
    const seen: Array<[CoreEvent, number | undefined]> = [];
    const promise = new TauriFirstRunSource().scan((e, offset) => seen.push([e, offset]));
    await waitFor(() => expect(scanCalls(shim!)).toContain("firstrun_scan"));

    shim!.emit(FIRSTRUN_EVENT.catalogue, catalogue);
    shim!.emit(FIRSTRUN_EVENT.agent, "not an object");
    shim!.emit(FIRSTRUN_EVENT.import, { agentId: "claude-code", phase: "sideways" });
    shim!.emit(FIRSTRUN_EVENT.agent, agent);
    shim!.emit(FIRSTRUN_EVENT.done, done);
    await promise;

    expect(seen.map(([e]) => e.name)).toEqual([FIRSTRUN_EVENT.catalogue, FIRSTRUN_EVENT.agent, FIRSTRUN_EVENT.done]);
    expect(seen.every(([, offset]) => offset === undefined)).toBe(true);
    expect(seen[1][0]).toMatchObject({ payload: { id: "claude-code", found: true } });
  });

  it("scan() resolves only once firstrun:done has been emitted, not when the invoke returns", async () => {
    core();
    let resolved = false;
    const promise = new TauriFirstRunSource().scan(() => {}).then(() => {
      resolved = true;
    });
    await waitFor(() => expect(scanCalls(shim!)).toContain("firstrun_scan"));
    shim!.emit(FIRSTRUN_EVENT.catalogue, catalogue);
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(false);
    expect(scanCalls(shim!)).not.toContain("services_start");

    shim!.emit(FIRSTRUN_EVENT.done, done);
    await promise;
    expect(resolved).toBe(true);
  });

  it("scan() also resolves when every event, done included, arrives before the invoke returns", async () => {
    core({
      firstrun_scan: () => {
        shim!.emit(FIRSTRUN_EVENT.catalogue, catalogue);
        shim!.emit(FIRSTRUN_EVENT.done, done);
        return null;
      },
    });
    await expect(new TauriFirstRunSource().scan(() => {})).resolves.toBeUndefined();
  });

  it("scan() unlistens everything, then starts the services once", async () => {
    core();
    const promise = new TauriFirstRunSource().scan(() => {});
    await waitFor(() => expect(scanCalls(shim!)).toContain("firstrun_scan"));
    shim!.emit(FIRSTRUN_EVENT.done, done);
    await promise;
    expect(NAMES.map((n) => shim!.listenerCount(n))).toEqual([0, 0, 0, 0]);
    expect(scanCalls(shim!)).toEqual(["firstrun_scan", "services_start"]);
  });

  it("scan() still resolves when services_start fails", async () => {
    core({ services_start: () => Promise.reject({ code: "error", message: "no services" }) });
    const promise = new TauriFirstRunSource().scan(() => {});
    await waitFor(() => expect(scanCalls(shim!)).toContain("firstrun_scan"));
    shim!.emit(FIRSTRUN_EVENT.done, done);
    await expect(promise).resolves.toBeUndefined();
  });

  it("scan() rejects and unlistens when firstrun_scan fails before done, without starting services", async () => {
    core({ firstrun_scan: () => Promise.reject({ code: "consent_required", message: "no consent" }) });
    await expect(new TauriFirstRunSource().scan(() => {})).rejects.toMatchObject({ code: "consent_required" });
    expect(NAMES.map((n) => shim!.listenerCount(n))).toEqual([0, 0, 0, 0]);
    expect(scanCalls(shim!)).toEqual(["firstrun_scan"]);
  });
});
