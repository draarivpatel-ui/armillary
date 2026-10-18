// V-REG-1 (r2 fix round 1): on a fresh install (and after Delete archive and reset) the app is
// mounted under the first run's hand-over before the first run completes. Saying yes in the plaque
// must already count as access there, or the Orrery paints "not given access" while it lands.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installIpcShim, type IpcShim } from "../src/presentation/ipcShim";
import { resetClientState } from "../src/api/client";
import { FirstRunGate } from "../src/firstrun/FirstRunGate";
import { App } from "../src/App";

// Stub the first run: a "Continue" that records consent in the core like the real one (consent then
// hand-over start), and a "Finish" that calls onComplete.
vi.mock("@orrery/firstrun", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@orrery/firstrun")>();
  const R = await import("react");
  function FirstRun(props: { source: { consent: (a: boolean) => Promise<void> }; onHandoffStart?: () => void; onComplete: (r: { declined: boolean }) => void }) {
    return R.createElement(
      "div",
      { "data-testid": "firstrun-stub" },
      R.createElement("button", { onClick: () => void props.source.consent(true).then(() => props.onHandoffStart?.()) }, "handoff"),
      R.createElement("button", { onClick: () => props.onComplete({ declined: false } as never) }, "finish"),
    );
  }
  return { ...actual, FirstRun };
});

let shim: IpcShim | null = null;
beforeEach(() => {
  resetClientState();
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});
afterEach(() => {
  cleanup();
  shim?.uninstall();
  shim = null;
});

describe("fresh install, user consented: hand-over", () => {
  it("does not show 'not given access' under the hand-over after the user said yes", async () => {
    shim = installIpcShim((command) => {
      const answers: Record<string, unknown> = {
        firstrun_status: { consented: false, completed: false },
        firstrun_fps_enabled: false,
        firstrun_plan: null,
        display_context: { home: "/tmp/fake-home", home_canonical: "/tmp/fake-home" },
        sessions_query: { items: [], total: 0, limit: 50, offset: 0 },
        live_list: [],
        agents_list: [],
        archive_status: { ok: true, message: null },
      };
      return answers[command] ?? null;
    });
    render(
      <FirstRunGate>
        {(api) => <App onReplayFirstRun={api.replay} accessGranted={api.accessGranted} onDeleteArchive={api.deleteArchive} />}
      </FirstRunGate>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "handoff" }));
    // The app is mounted under the hand-over, as the real first run does.
    await waitFor(() => expect(document.querySelector("[data-view]") || document.querySelector("[data-no-access]")).not.toBeNull());
    expect(document.querySelector("[data-no-access]"), "no-access notice painted under the hand-over").toBeNull();
  });

  it("after Delete archive and reset, saying yes again lands on the Orrery, not the no-access notice", async () => {
    shim = installIpcShim((command) => {
      const answers: Record<string, unknown> = {
        firstrun_status: { consented: true, completed: true },
        firstrun_fps_enabled: false,
        firstrun_plan: null,
        display_context: { home: "/tmp/fake-home", home_canonical: "/tmp/fake-home" },
        sessions_query: { items: [], total: 0, limit: 50, offset: 0 },
        live_list: [],
        agents_list: [],
        archive_status: { ok: true, message: null },
        archive_delete: null,
      };
      return answers[command] ?? null;
    });
    render(
      <FirstRunGate>
        {(api) => <App onReplayFirstRun={api.replay} accessGranted={api.accessGranted} onDeleteArchive={api.deleteArchive} />}
      </FirstRunGate>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete archive and reset" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete archive" }));
    fireEvent.click(await screen.findByRole("button", { name: "handoff" }));
    await waitFor(() => expect(document.querySelector("[data-view]") || document.querySelector("[data-no-access]")).not.toBeNull());
    expect(document.querySelector("[data-no-access]"), "no-access notice painted under the hand-over").toBeNull();
  });
});
