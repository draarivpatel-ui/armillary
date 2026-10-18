import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installIpcShim, type IpcShim } from "../src/presentation/ipcShim";
import { resetClientState } from "../src/api/client";
import { FirstRunGate } from "../src/firstrun/FirstRunGate";
import { App } from "../src/App";

// The real FirstRun needs WebGL; this stub only marks that the plaque is showing.
vi.mock("@orrery/firstrun", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@orrery/firstrun")>();
  const R = await import("react");
  function FirstRun() {
    return R.createElement("div", { "data-testid": "firstrun-stub" }, "plaque");
  }
  return { ...actual, FirstRun };
});

let shim: IpcShim | null = null;

function core(status: { consented: boolean; completed: boolean }, extra: Record<string, unknown> = {}): IpcShim {
  const answers: Record<string, unknown> = {
    firstrun_status: status,
    firstrun_reset: { consented: status.consented, completed: false },
    firstrun_fps_enabled: false,
    firstrun_plan: null,
    display_context: { home: "/tmp/fake-home", home_canonical: "/tmp/fake-home" },
    sessions_query: { items: [], total: 0, limit: 50, offset: 0 },
    live_list: [],
    agents_list: [],
    archive_status: { ok: true, path: null, message: null },
    archive_delete: { consented: false, completed: false },
    ...extra,
  };
  shim = installIpcShim((command) => {
    const v = answers[command];
    return typeof v === "function" ? (v as () => unknown)() : v ?? null;
  });
  return shim;
}

function mount() {
  return render(
    <FirstRunGate>
      {(api) => (
        <App
          onReplayFirstRun={api.replay}
          accessGranted={api.accessGranted}
          onDeleteArchive={api.deleteArchive}
        />
      )}
    </FirstRunGate>,
  );
}

const READS = ["live_list", "agents_list", "config_list", "import_now", "pty_open"];
const commands = () => (shim?.calls ?? []).map((c) => c.command);

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

describe("no access after Not now (R2-REV-1)", () => {
  it("shows the not-given-access state in the views that read agent folders and calls none of their commands", async () => {
    core({ consented: false, completed: true });
    mount();
    expect(await screen.findByText("Armillary has not been given access")).toBeInTheDocument();
    for (const view of ["Field Guide", "Switchboard", "Launchpad", "Search"]) {
      if (view === "Search") {
        fireEvent.click(within(screen.getByRole("navigation", { name: "Observatory Views" })).getByRole("button", { name: /Search/ }));
        await waitFor(() => expect(document.querySelector('[data-view="search"]')).not.toBeNull());
        continue;
      }
      fireEvent.click(within(screen.getByRole("navigation", { name: "Observatory Views" })).getByRole("button", { name: new RegExp(view) }));
      await waitFor(() => expect(document.querySelector(`[data-view="${view === "Field Guide" ? "field-guide" : view.toLowerCase()}"] [data-no-access]`)).not.toBeNull());
    }
    for (const c of READS) expect(commands()).not.toContain(c);
  });

  it("the Give access button replays the consent plaque", async () => {
    core({ consented: false, completed: true });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Give access" }));
    expect(await screen.findByTestId("firstrun-stub")).toBeInTheDocument();
    expect(commands()).toContain("firstrun_reset");
  });
});

describe("Delete archive and reset (R2-REV-3)", () => {
  it("asks first, then deletes, clears local storage and returns to the plaque", async () => {
    core({ consented: true, completed: true });
    localStorage.setItem("armillary:recent_launches", JSON.stringify([{ agentId: "x", cwd: "/tmp/p" }]));
    localStorage.setItem("armillary.theme", "light");
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Delete archive and reset" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete the archive?" });
    // Cancel keeps everything.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(commands()).not.toContain("archive_delete");

    fireEvent.click(screen.getByRole("button", { name: "Delete archive and reset" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete archive" }));
    expect(await screen.findByTestId("firstrun-stub")).toBeInTheDocument();
    expect(commands()).toContain("archive_delete");
    expect(commands()).not.toContain("firstrun_reset");
    expect(localStorage.getItem("armillary:recent_launches")).toBeNull();
    expect(localStorage.getItem("armillary.theme")).toBeNull();
  });

  it("a failed delete says so and stays put", async () => {
    core({ consented: true, completed: true }, {});
    shim!.uninstall();
    shim = installIpcShim((command) => {
      if (command === "archive_delete") throw { code: "archive_failed", message: "could not remove the archive file" };
      if (command === "firstrun_status") return { consented: true, completed: true };
      if (command === "sessions_query") return { items: [], total: 0, limit: 50, offset: 0 };
      if (command === "live_list" || command === "agents_list") return [];
      return null;
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Delete archive and reset" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete archive" }));
    expect(await screen.findByText(/could not remove the archive file/)).toBeInTheDocument();
    expect(screen.queryByTestId("firstrun-stub")).toBeNull();
  });
});

describe("Delete archive and reset: partial delete (V-REG-10)", () => {
  it("says the archive was partly deleted when the core emptied it but could not remove a file", async () => {
    shim = installIpcShim((command) => {
      if (command === "archive_delete")
        throw { code: "partly_deleted", message: "the archive was emptied, but not everything was removed (could not remove firstrun.json)." };
      if (command === "firstrun_status") return { consented: true, completed: true };
      if (command === "sessions_query") return { items: [], total: 0, limit: 50, offset: 0 };
      if (command === "live_list" || command === "agents_list") return [];
      return null;
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Delete archive and reset" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/copies kept by "Move it aside"/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete archive" }));
    expect(await screen.findByText(/^Partly deleted: the archive was emptied/)).toBeInTheDocument();
    expect(screen.queryByText(/was not deleted/)).toBeNull();
  });
});

describe("Switchboard refusal notes (R2-RC-1)", () => {
  it("names a link that leaves its folder separately from a credential file", async () => {
    const { AgentColumn } = await import("../src/views/Switchboard/AgentColumn");
    render(
      <AgentColumn
        agent={{
          agent: "codex-cli",
          displayName: "Codex CLI",
          vendor: "OpenAI",
          servers: [],
          rules: [],
          skipped: [
            { path: "evilrepo/.codex/config.toml", reason: "linkOutsideFolder" },
            { path: "~/.codex/auth.json", reason: "credentialFile" },
          ],
          notes: ["could not parse ~/.codex/config.toml"],
        }}
      />,
    );
    expect(screen.getByText(/is a link that leads outside its folder, not opened/)).toBeInTheDocument();
    expect(screen.getByText(/holds credentials, never opened/)).toBeInTheDocument();
  });
});

describe("Field Guide: oversized files (R2-RC-3)", () => {
  it("shows 'Skipped, too large' for a file over the 64 MiB read limit", async () => {
    core({ consented: true, completed: true });
    const { FieldGuideView } = await import("../src/views/FieldGuide");
    render(<FieldGuideView initialAgents={[]} />);
    await waitFor(() => expect(shim!.listenerCount("import:progress")).toBeGreaterThan(0));
    shim!.emit("import:progress", {
      agentId: "claude-code",
      phase: "progress",
      sessionsImported: 0,
      sessionsKnown: 1,
      error: "Skipped, too large (over 64 MiB): projects/p/big.jsonl",
      projects: [],
    });
    expect(await screen.findByText(/Skipped, too large \(over 64 MiB\): projects\/p\/big\.jsonl/)).toBeInTheDocument();
  });

  // P2-2 / V-REG-8: the launch import and the first-run import run while the Field Guide is not
  // open, so the view also reads the skips the archive kept, once, when it opens.
  it("shows a skip from an earlier import when it opens, without a running import", async () => {
    core(
      { consented: true, completed: true },
      {
        import_diagnostics: [
          { source_key: "a".repeat(64), code: "incomplete", message: "read did not produce a complete batch", retryable: true },
          { source_key: "a".repeat(64), code: "limit", message: "Skipped, too large (over 64 MiB): tasks/t1/api_conversation_history.json", retryable: false },
          { source_key: "a".repeat(64), code: "limit", message: "Skipped, too large (over 64 MiB): tasks/t1/api_conversation_history.json", retryable: false },
          { source_key: "b".repeat(64), code: "io", message: "IO error: permission denied", retryable: true },
        ],
      },
    );
    const { FieldGuideView } = await import("../src/views/FieldGuide");
    render(<FieldGuideView initialAgents={[]} />);
    const notes = await screen.findAllByText(/Skipped, too large \(over 64 MiB\): tasks\/t1\/api_conversation_history\.json/);
    expect(notes).toHaveLength(1);
    expect(screen.queryByText(/permission denied/)).toBeNull();
  });

  it("opens normally when the core has no diagnostics to give", async () => {
    core({ consented: true, completed: true });
    const { FieldGuideView } = await import("../src/views/FieldGuide");
    render(<FieldGuideView initialAgents={[]} />);
    await waitFor(() => expect(commands()).toContain("import_diagnostics"));
    expect(screen.queryByText(/Skipped, too large/)).toBeNull();
  });
});

describe("damaged or newer archive (R2-REV-7)", () => {
  it("explains the problem instead of failing, and moves the file aside only when asked", async () => {
    let moved = false;
    core(
      { consented: true, completed: true },
      {
        archive_status: () =>
          moved ? { ok: true, message: null } : { ok: false, message: "The archive file is damaged or is not an Armillary archive, so it could not be opened." },
        archive_move_aside: () => {
          moved = true;
          return { ok: true, message: null };
        },
      },
    );
    mount();
    expect(await screen.findByRole("heading", { name: "The archive could not be opened" })).toBeInTheDocument();
    expect(screen.getByText(/damaged or is not an Armillary archive/)).toBeInTheDocument();
    expect(commands()).not.toContain("archive_move_aside");
    for (const c of READS) expect(commands()).not.toContain(c);

    fireEvent.click(screen.getByRole("button", { name: "Move it aside and start fresh" }));
    await waitFor(() => expect(commands()).toContain("archive_move_aside"));
    // Then the app opens as usual on the new, empty archive, and the services start (consent stands).
    await waitFor(() => expect(document.querySelector("[data-view=\"orrery\"]")).not.toBeNull());
    expect(commands()).toContain("services_start");
    expect(screen.queryByRole("heading", { name: "The archive could not be opened" })).toBeNull();
  });
});
