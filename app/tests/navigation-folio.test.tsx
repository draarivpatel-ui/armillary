import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { Message, Session } from "@armillary/model";
import { installIpcShim, type IpcShim } from "../src/presentation/ipcShim";
import { resetClientState } from "../src/api/client";
import { resetArchiveClient } from "../src/api/archive";
import { StandaloneNavigation, useNavigation } from "../src/navigation";
import { FolioView } from "../src/views/FolioView";
import { tourAction } from "../src/presentation/locators";

const SID = "a".repeat(64);
const OTHER = "b".repeat(64);

function session(id: string, title: string): Session {
  return {
    id,
    agent_id: "claude-code",
    title,
    model: null,
    status: "unknown",
    turns: 2,
    started_at: 1_791_850_000_000,
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
  };
}

function conversation(sessionId: string, count: number): Message[] {
  const out: Message[] = [];
  for (let seq = 1; seq <= count; seq += 1) {
    if (seq % 3 === 1) {
      out.push({ id: `${sessionId}-${seq}`, session_id: sessionId, seq, role: "user", blocks: [{ type: "text", text: `Prompt number ${seq}` }] });
    } else if (seq % 3 === 2) {
      out.push({
        id: `${sessionId}-${seq}`,
        session_id: sessionId,
        seq,
        role: "assistant",
        blocks: [
          { type: "text", text: `Reply number ${seq}` },
          { type: "tool_call", call_id: `c${seq}`, name: "Bash", input: { command: `echo ${seq}` }, files: [] },
        ],
      });
    } else {
      out.push({
        id: `${sessionId}-${seq}`,
        session_id: sessionId,
        seq,
        role: "user",
        blocks: [{ type: "tool_result", call_id: `c${seq - 1}`, output: `out ${seq - 1}` }],
      });
    }
  }
  return out;
}

let shim: IpcShim | null = null;

function fakeCore(messagesBySession: Record<string, Message[]>, sessions: Session[]) {
  shim = installIpcShim((command, args) => {
    if (command === "session_get") {
      const s = sessions.find((x) => x.id === args.id);
      return s ?? Promise.reject({ code: "not_found", message: "session not found" });
    }
    if (command === "sessions_query") {
      return { items: sessions.slice(0, 1), total: sessions.length, limit: 1, offset: 0 };
    }
    if (command === "messages_page") {
      const all = messagesBySession[String(args.id)] ?? [];
      const limit = Number(args.limit);
      const offset = Number(args.offset);
      return { items: all.slice(offset, offset + limit), total: all.length, limit, offset };
    }
    return null;
  });
  return shim;
}

function Opener({ id, seq }: { id: string; seq?: number }) {
  const nav = useNavigation();
  return (
    <button type="button" onClick={() => nav.openSession(id, seq === undefined ? null : { seq, message_id: `${id}-${seq}` })}>
      open {id.slice(0, 1)} {seq ?? ""}
    </button>
  );
}

function ViewProbe() {
  return <output data-testid="view">{useNavigation().view}</output>;
}

beforeEach(() => {
  resetClientState();
  resetArchiveClient();
});

afterEach(() => {
  shim?.uninstall();
  shim = null;
});

describe("navigation", () => {
  it("openSession switches to the Folio and carries the anchor", async () => {
    fakeCore({ [SID]: conversation(SID, 6) }, [session(SID, "Radar sweep tuning")]);
    render(
      <StandaloneNavigation initialView="search">
        <ViewProbe />
        <Opener id={SID} seq={5} />
      </StandaloneNavigation>,
    );
    expect(screen.getByTestId("view").textContent).toBe("search");
    act(() => screen.getByRole("button").click());
    expect(screen.getByTestId("view").textContent).toBe("folio");
  });

  it("registers openSession for the presentation tour", () => {
    render(
      <StandaloneNavigation initialView="orrery">
        <ViewProbe />
      </StandaloneNavigation>,
    );
    const open = tourAction("openSession");
    expect(open).not.toBeNull();
    act(() => {
      open!(SID);
    });
    expect(screen.getByTestId("view").textContent).toBe("folio");
  });

  it("is inert outside a provider", () => {
    render(<ViewProbe />);
    expect(screen.getByTestId("view").textContent).toBe("orrery");
  });
});

describe("FolioView on the contract", () => {
  it("opens the target session through session_get and messages_page, every page, in order", async () => {
    const fake = fakeCore({ [SID]: conversation(SID, 450) }, [session(SID, "Radar sweep tuning")]);
    render(
      <StandaloneNavigation initialView="search">
        <Opener id={SID} />
        <FolioView />
      </StandaloneNavigation>,
    );
    act(() => screen.getByRole("button", { name: /open a/ }).click());
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Radar sweep tuning"));
    await waitFor(() => expect(document.querySelector("[data-folio-state='ready']")).not.toBeNull());
    const pages = fake.calls.filter((c) => c.command === "messages_page").map((c) => c.args.offset);
    expect(pages).toEqual([0, 200, 400]);
    await waitFor(() => expect(document.querySelector("[data-folio-scroll]")?.getAttribute("data-total-blocks")).toBe("300"));
    // tool results correlated into the margin notes of their calls, unknown model stays unknown
    expect(document.querySelector("[data-tool='Bash']")?.textContent).toContain("echo 2");
    expect(document.querySelector("[data-tool='Bash']")?.textContent).toContain("out 2");
    expect(document.body.textContent).toContain("model unknown");
    expect(document.body.textContent).not.toContain("Demo data");
  });

  it("opens at the search hit anchor", async () => {
    fakeCore({ [SID]: conversation(SID, 30) }, [session(SID, "Radar sweep tuning")]);
    render(
      <StandaloneNavigation initialView="search">
        <Opener id={SID} seq={14} />
        <FolioView />
      </StandaloneNavigation>,
    );
    act(() => screen.getByRole("button", { name: /open a/ }).click());
    await waitFor(() => {
      const current = document.querySelector(".folio-row[data-current='true']") as HTMLElement | null;
      expect(current?.dataset.seq).toBe("14");
    });
  });

  it("with no target opens the most recent session", async () => {
    const fake = fakeCore({ [OTHER]: conversation(OTHER, 3) }, [session(OTHER, "Newest session")]);
    render(
      <StandaloneNavigation initialView="folio">
        <FolioView />
      </StandaloneNavigation>,
    );
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Newest session"));
    expect(fake.calls[0]).toEqual({ command: "sessions_query", args: { query: { limit: 1 } } });
  });

  it("shows a typed error instead of mock data when the core fails", async () => {
    shim = installIpcShim(() => Promise.reject({ code: "archive_failed", message: "disk unavailable" }));
    render(
      <StandaloneNavigation initialView="folio">
        <FolioView />
      </StandaloneNavigation>,
    );
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("disk unavailable"));
    expect(document.body.textContent).not.toContain("Demo data");
  });

  it("marks mock data as demo data when there is no core", async () => {
    render(
      <StandaloneNavigation initialView="folio">
        <FolioView />
      </StandaloneNavigation>,
    );
    await waitFor(() => expect(document.querySelector("[data-folio-state='ready']")).not.toBeNull());
    expect(screen.getByText("Demo data")).toBeTruthy();
  });
});
