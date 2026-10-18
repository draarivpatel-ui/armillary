/**
 * The Switchboard asks the core for the user's real projects: it loads the archive's distinct project roots
 * first, then calls config_list once with those roots. Tested against a fake core (the IPC shim).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Session } from "@armillary/model";
import { installIpcShim, type IpcShim } from "../src/presentation/ipcShim";
import { resetClientState } from "../src/api/client";
import { resetArchiveClient } from "../src/api/archive";
import { Switchboard } from "../src/views/Switchboard/Switchboard";
import goldenSnapshot from "../../fixtures/switchboard/expected/snapshot.json";
import type { ConfigSnapshot } from "../src/views/Switchboard/types";

function session(n: number, projectRoot: string | null): Session {
  return {
    id: n.toString(16).padStart(64, "0"),
    agent_id: "claude-code",
    title: `Session ${n}`,
    model: null,
    status: "done",
    turns: 1,
    started_at: 1_791_850_000_000 - n,
    ended_at: null,
    project_root: projectRoot,
  } as unknown as Session;
}

/** The synthetic snapshot with its one project renamed, so the test can tell it came from the fake core. */
function snapshotFor(project: string): ConfigSnapshot {
  const text = JSON.stringify(goldenSnapshot).replaceAll("webapp", project);
  return JSON.parse(text) as ConfigSnapshot;
}

let shim: IpcShim | null = null;

function core(handler: (command: string, args: Record<string, unknown>) => unknown): IpcShim {
  shim = installIpcShim((command, args) => (command === "ui_trace" ? null : handler(command, args)));
  return shim;
}

function configCalls(): Array<Record<string, unknown>> {
  return (shim?.calls ?? []).filter((c) => c.command === "config_list").map((c) => c.args);
}

function archiveWith(sessions: Session[]) {
  return (command: string, args: Record<string, unknown>): unknown => {
    if (command === "sessions_query") {
      const q = (args.query ?? {}) as { limit?: number; offset?: number };
      const limit = q.limit ?? 50;
      const offset = q.offset ?? 0;
      return { items: sessions.slice(offset, offset + limit), total: sessions.length, limit, offset };
    }
    if (command === "config_list") return snapshotFor("alpha-app");
    return null;
  };
}

beforeEach(() => {
  resetClientState();
  resetArchiveClient();
});

afterEach(() => {
  cleanup();
  shim?.uninstall();
  shim = null;
  vi.restoreAllMocks();
});

/** The Switchboard opens on the server matrix; rules files live on the Rules tab. */
async function rulesTabShows(text: string): Promise<boolean> {
  const tab = await screen.findByRole("tab", { name: /Rules/ });
  fireEvent.click(tab);
  return (await screen.findAllByText(text)).length > 0;
}

describe("Switchboard project roots", () => {
  it("calls config_list once with the archive's distinct project roots and shows the project's rules", async () => {
    core(
      archiveWith([
        session(1, "/work/alpha-app"),
        session(2, "/srv/beta"),
        session(3, "/work/alpha-app"),
        session(4, null),
      ]),
    );
    render(<Switchboard />);

    expect(await rulesTabShows("alpha-app/CLAUDE.md")).toBe(true);
    const calls = configCalls();
    expect(calls).toHaveLength(1);
    expect([...(calls[0].projectRoots as string[])].sort()).toEqual(["/srv/beta", "/work/alpha-app"]);
  });

  it("waits for the roots: no config_list call and no error while the archive is still answering", async () => {
    let release: (page: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    core((command, args) => {
      if (command === "sessions_query") return pending;
      return archiveWith([])(command, args);
    });
    render(<Switchboard />);

    expect(await screen.findByText(/Loading agent configuration/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 30));
    expect(configCalls()).toHaveLength(0);
    expect(screen.queryByText(/Could not load/)).not.toBeInTheDocument();

    release({ items: [session(1, "/work/alpha-app")], total: 1, limit: 200, offset: 0 });
    await waitFor(() => expect(configCalls()).toHaveLength(1));
    expect(configCalls()[0].projectRoots).toEqual(["/work/alpha-app"]);
  });

  it("calls config_list once with no roots when the archive has none", async () => {
    core(archiveWith([]));
    render(<Switchboard />);

    expect(await rulesTabShows("alpha-app/CLAUDE.md")).toBe(true);
    const calls = configCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].projectRoots ?? null).toBeNull();
  });

  it("still loads the global configuration when the archive cannot list its projects", async () => {
    core((command, args) =>
      command === "sessions_query"
        ? Promise.reject({ code: "archive_failed", message: "archive is locked" })
        : archiveWith([])(command, args),
    );
    render(<Switchboard />);

    expect(await rulesTabShows("alpha-app/CLAUDE.md")).toBe(true);
    expect(configCalls()).toHaveLength(1);
    expect(configCalls()[0].projectRoots ?? null).toBeNull();
  });
});
