import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, within, fireEvent, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { AlmanacView } from "../src/views/Almanac";
import {
  generateSyntheticSessions,
  setArchiveClient,
  resetArchiveClient,
  createMockArchiveClient,
  type Session,
} from "../src/api/archive";
import { calculateVariableRange } from "../src/views/Almanac/useVirtualList";
import { formatSessionDuration } from "../src/views/Almanac/layout";
import { groupStatuses, rawStatusesIn, statusGroupOf } from "../src/views/Almanac/status";

const T = new Date(2026, 9, 7, 14, 30).getTime(); // 7 Oct 2026, 14:30 local
const DAY = 86_400_000;

function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    agent_id: "claude-code",
    title: `Session ${id}`,
    model: "claude-opus",
    status: "done",
    turns: 4,
    started_at: T,
    ended_at: T + 25 * 60_000,
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

/** Five sessions: two on one day, one on each of two more days, one undated. */
function fixture(): Session[] {
  return [
    session("s1", { title: "Fix the login redirect", status: "waiting", turns: 12 }),
    session("s2", { title: "Tidy the stylesheet", status: "working", ended_at: null, model: null, started_at: T - 3_600_000 }),
    session("s3", { title: "Draft the release notes", status: "done", started_at: T - DAY, ended_at: T - DAY + 5 * 60_000, project_root: "/srv/beta" }),
    session("s4", { title: "Check the cache", status: "idle", started_at: T - 2 * DAY, ended_at: T - 2 * DAY + 90_000, project_root: "/home/u/gamma" }),
    session("s5", { title: "Lost transcript", status: "idle", started_at: null, ended_at: null, project_root: null }),
  ];
}

function useFixture(sessions: Session[] = fixture()) {
  setArchiveClient(createMockArchiveClient(sessions));
}

async function loaded() {
  await waitFor(() => expect(screen.getAllByTestId("almanac-session-item").length).toBeGreaterThan(0));
}

describe("Almanac view", () => {
  beforeEach(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  });
  afterEach(() => {
    cleanup();
    resetArchiveClient();
    delete (window as unknown as Record<string, unknown>).__ARMILLARY_NOW__;
  });

  describe("head", () => {
    it("uses the shell chrome: History eyebrow, one h2, a lede and honest figures, no pills", async () => {
      useFixture();
      const { container } = render(<AlmanacView />);
      await loaded();

      const section = container.querySelector("section.view");
      expect(section).not.toBeNull();
      expect(container.querySelector("main")).toBeNull();
      expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
      expect(screen.getByRole("heading", { name: "The Almanac", level: 2 })).toBeInTheDocument();
      expect(section!.querySelector(".view-eyebrow")?.textContent).toBe("History");
      expect(section!.querySelector(".view-lede")?.textContent).toBe("Every session with every agent, day by day.");

      const figures = screen.getByRole("group", { name: "Summary" });
      const labels = Array.from(figures.querySelectorAll(".obs-figure")).map((f) => [
        f.querySelector(".obs-figure__label")?.textContent,
        f.querySelector(".obs-figure__value")?.textContent,
      ]);
      expect(labels).toEqual([
        ["sessions", "5"],
        ["days", "3"],
        ["projects", "3"],
      ]);

      expect(container.querySelector("[class*='badge']")).toBeNull();
    });

    it("says 'sessions loaded' when the archive holds more than were loaded", async () => {
      // 20 200 synthetic sessions: the view loads at most 20 000.
      setArchiveClient(createMockArchiveClient(generateSyntheticSessions(20_200)));
      render(<AlmanacView />);
      await loaded();
      const figures = screen.getByRole("group", { name: "Summary" });
      await waitFor(() => expect(within(figures).getByText("sessions loaded")).toBeInTheDocument());
      expect(within(figures).getByText("20,000")).toBeInTheDocument();
    }, 60_000);
  });

  describe("filters", () => {
    it("offers Agent, Project and Model as small selects with hidden labels and 'All ...' first options", async () => {
      useFixture();
      render(<AlmanacView />);
      await loaded();

      const agent = screen.getByRole("combobox", { name: "Agent" });
      const project = screen.getByRole("combobox", { name: "Project" });
      const model = screen.getByRole("combobox", { name: "Model" });
      for (const el of [agent, project, model]) {
        expect(el.closest(".obs-select")).toHaveClass("obs-select--sm");
        expect(el.closest(".obs-select")!.querySelector("label")).toHaveClass("obs-visually-hidden");
      }
      expect(within(agent).getAllByRole("option")[0]).toHaveTextContent("All agents");
      expect(within(project).getAllByRole("option")[0]).toHaveTextContent("All projects");
      expect(within(model).getAllByRole("option")[0]).toHaveTextContent("All models");

      // the old boxed bar and shouting labels are gone
      expect(screen.queryByText(/Filter by/i)).not.toBeInTheDocument();
      expect(document.querySelector(".almanac-filters")?.className).not.toMatch(/box|panel/);
    });

    it("shows Clear filters only while a filter is active, and clears every filter", async () => {
      useFixture();
      render(<AlmanacView />);
      await loaded();

      expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();

      const project = screen.getByRole("combobox", { name: "Project" });
      await waitFor(() => expect(within(project).getAllByRole("option").length).toBeGreaterThan(1));
      fireEvent.change(project, { target: { value: "/srv/beta" } });

      const clear = await screen.findByRole("button", { name: "Clear filters" });
      expect(clear).toHaveClass("obs-button--ghost");
      await waitFor(() => {
        for (const item of screen.getAllByTestId("almanac-session-item")) {
          expect(item).toHaveTextContent("Draft the release notes");
        }
      });

      await userEvent.click(clear);
      await waitFor(() => expect(screen.getAllByTestId("almanac-session-item")).toHaveLength(5));
      expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("");
    });

    it("uses a segmented Status control when there are four status groups or fewer", async () => {
      useFixture(); // waiting, working, done, idle: four groups
      render(<AlmanacView />);
      await loaded();

      const group = screen.getByRole("radiogroup", { name: "Status" });
      const radios = within(group).getAllByRole("radio");
      expect(radios.map((r) => r.textContent)).toEqual(["All", "Open", "Needs you", "Finished", "Idle"]);
      expect(radios[0]).toHaveAttribute("aria-checked", "true");

      await userEvent.click(within(group).getByRole("radio", { name: "Idle" }));
      await waitFor(() => {
        const items = screen.getAllByTestId("almanac-session-item");
        expect(items).toHaveLength(2);
        items.forEach((i) => expect(i).toHaveAttribute("data-status", "idle"));
      });
      expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
    });

    it("uses one FilterChip per status group, with counts, when there are more than four", async () => {
      // six raw statuses in five groups: completed and done merge into Finished
      const raws = ["active", "waiting", "done", "closed", "idle", "failed"];
      const data = Array.from({ length: 60 }, (_, i) =>
        session(`c${i}`, { status: raws[i % raws.length], started_at: T - i * 60_000, ended_at: null }),
      );
      setArchiveClient(createMockArchiveClient(data));
      render(<AlmanacView />);
      await loaded();

      expect(screen.queryByRole("radiogroup", { name: "Status" })).not.toBeInTheDocument();

      const group = screen.getByRole("group", { name: "Status" });
      const chips = within(group).getAllByRole("button");
      expect(chips.map((c) => c.textContent?.replace(/\s*\d+$/, ""))).toEqual([
        "Open",
        "Needs you",
        "Finished",
        "Failed",
        "Idle",
      ]);
      const expected: Array<[string, number]> = [
        ["Open", 10],
        ["Needs you", 10],
        ["Finished", 20],
        ["Failed", 10],
        ["Idle", 10],
      ];
      for (const [label, count] of expected) {
        const chip = within(group).getByRole("button", { name: new RegExp(`^${label}\\s*${count}$`) });
        expect(chip).toHaveAttribute("aria-pressed", "false");
      }

      const finished = within(group).getByRole("button", { name: /^Finished/ });
      await userEvent.click(finished);
      expect(finished).toHaveAttribute("aria-pressed", "true");
      await waitFor(() => expect(screen.getAllByTestId("almanac-session-item")).toHaveLength(20));
      const rows = screen.getAllByTestId("almanac-session-item");
      expect(new Set(rows.map((r) => r.getAttribute("data-status")))).toEqual(new Set(["done", "closed"]));
      rows.forEach((r) => expect(r).toHaveAttribute("data-status-group", "finished"));

      await userEvent.click(finished);
      expect(finished).toHaveAttribute("aria-pressed", "false");
      await waitFor(() => expect(screen.getAllByTestId("almanac-session-item")).toHaveLength(60));
    });

    describe("status groups", () => {
      /** Two raw statuses in one group (Finished), and one Unknown. */
      function merged(): Session[] {
        return [
          session("m1", { title: "Merged completed", status: "completed", started_at: T - 1000, ended_at: T }),
          session("m2", { title: "Merged done", status: "done", started_at: T - 2000, ended_at: T }),
          session("m3", { title: "Merged unknown", status: "unknown", started_at: T - 3000, ended_at: null }),
        ];
      }

      it("never shows two options for statuses in the same group", async () => {
        useFixture(merged());
        render(<AlmanacView />);
        await loaded();
        const group = screen.getByRole("radiogroup", { name: "Status" });
        expect(within(group).getAllByRole("radio").map((r) => r.textContent)).toEqual(["All", "Finished", "Unknown"]);
      });

      it("selecting Finished shows both completed and done sessions, keeping their raw status", async () => {
        useFixture(merged());
        render(<AlmanacView />);
        await loaded();
        const group = screen.getByRole("radiogroup", { name: "Status" });
        await userEvent.click(within(group).getByRole("radio", { name: "Finished" }));
        await waitFor(() => expect(screen.getAllByTestId("almanac-session-item")).toHaveLength(2));
        const rows = screen.getAllByTestId("almanac-session-item");
        expect(rows.map((r) => r.getAttribute("data-status")).sort()).toEqual(["completed", "done"]);
        rows.forEach((r) => expect(r).toHaveAttribute("data-status-group", "finished"));
        expect(within(group).getByRole("radio", { name: "Finished" })).toHaveAttribute("aria-checked", "true");
      });

      it("sends filter.status when the group is one raw status in the data", async () => {
        const client = createMockArchiveClient(fixture());
        const spy = vi.spyOn(client, "sessions_query");
        setArchiveClient(client);
        render(<AlmanacView />);
        await loaded();

        const before = spy.mock.calls.length;
        await userEvent.click(within(screen.getByRole("radiogroup", { name: "Status" })).getByRole("radio", { name: "Idle" }));
        await waitFor(() => expect(screen.getAllByTestId("almanac-session-item")).toHaveLength(2));
        const sent = spy.mock.calls.slice(before).map(([f]) => f?.status);
        expect(sent.length).toBeGreaterThan(0);
        expect(sent.every((s) => s === "idle")).toBe(true);
      });

      it("queries without a status when the group is several raw statuses, and filters by group", async () => {
        const client = createMockArchiveClient(merged());
        const spy = vi.spyOn(client, "sessions_query");
        setArchiveClient(client);
        render(<AlmanacView />);
        await loaded();

        const before = spy.mock.calls.length;
        await userEvent.click(within(screen.getByRole("radiogroup", { name: "Status" })).getByRole("radio", { name: "Finished" }));
        await waitFor(() => expect(screen.getAllByTestId("almanac-session-item")).toHaveLength(2));
        const sent = spy.mock.calls.slice(before).map(([f]) => f);
        expect(sent.length).toBeGreaterThan(0);
        expect(sent.every((f) => f?.status === undefined)).toBe(true);
      });

      it("marks each row by its group, keeps the raw status on data-status, and shows Open durations as in progress", async () => {
        useFixture([
          session("r1", { status: "working", ended_at: null }),
          session("r2", { status: "waiting" }),
          session("r3", { status: "completed" }),
          session("r4", { status: "Failed" }),
          session("r5", { status: "" }),
          session("r6", { status: "idle" }),
          session("r7", { status: "in_progress", ended_at: null }),
        ]);
        render(<AlmanacView />);
        await loaded();
        const row = (id: string) =>
          screen.getAllByTestId("almanac-session-item").find((r) => r.getAttribute("data-session-id") === id)!;

        const expectMark = (id: string, raw: string, group: string, classes: string[], text: string) => {
          const el = row(id);
          expect(el).toHaveAttribute("data-status", raw);
          expect(el).toHaveAttribute("data-status-group", group);
          for (const c of classes) expect(el.querySelector(`.${c}`)).not.toBeNull();
          expect(within(el).getByText(text, { selector: ".obs-mark__text" })).toBeInTheDocument();
        };
        expectMark("r1", "working", "open", ["obs-mark--gilt", "obs-mark--dot", "obs-mark--emphasis"], "Open");
        expectMark("r2", "waiting", "needs", ["obs-mark--alert", "obs-mark--dot", "obs-mark--emphasis"], "Needs you");
        expectMark("r3", "completed", "finished", ["obs-mark--success", "obs-mark--dot"], "Finished");
        expectMark("r4", "Failed", "failed", ["obs-mark--alert", "obs-mark--ring"], "Failed");
        expectMark("r5", "", "unknown", ["obs-mark--neutral", "obs-mark--ring"], "Unknown");
        expectMark("r6", "idle", "other:idle", ["obs-mark--neutral", "obs-mark--ring"], "Idle");
        expectMark("r7", "in_progress", "open", ["obs-mark--gilt"], "Open");
        expect(within(row("r7")).getByTestId("session-duration")).toHaveTextContent("in progress");
      });
    });
  });

  describe("date range", () => {
    it("has a Select-like trigger, a real clear button, and Escape returns focus to the trigger", async () => {
      useFixture();
      render(<AlmanacView />);
      await loaded();

      const trigger = screen.getByRole("button", { name: /Date range/i });
      expect(trigger).toHaveTextContent("All dates");
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(trigger.querySelector(".obs-date-range-chevron")).not.toBeNull();
      expect(screen.queryByRole("button", { name: /Clear date/i })).not.toBeInTheDocument();

      await userEvent.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      const popover = screen.getByTestId("date-range-popover");
      expect(screen.getByTestId("calendar-month-heading")).toHaveClass("obs-date-range-month-title");

      // design Buttons for presets and month navigation
      const today = within(popover).getByRole("button", { name: "Today" });
      expect(today).toHaveClass("obs-button");
      expect(within(popover).getByRole("button", { name: "Previous month" })).toHaveClass("obs-icon-button");
      expect(within(popover).getByRole("button", { name: "Next month" })).toHaveClass("obs-icon-button");

      const days = within(popover).getAllByRole("gridcell");
      await userEvent.click(days.find((d) => d.textContent === "10")!);
      await userEvent.click(days.find((d) => d.textContent === "12")!);
      expect(days.find((d) => d.textContent === "10")).toHaveClass("obs-calendar-day--selected");
      expect(days.find((d) => d.textContent === "12")).toHaveClass("obs-calendar-day--selected");

      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByTestId("date-range-popover")).not.toBeInTheDocument());
      expect(trigger).toHaveFocus();

      // the clear control is a real button, not a span with a role
      const clear = screen.getByRole("button", { name: /Clear date/i });
      expect(clear.tagName).toBe("BUTTON");
      expect(document.querySelector("span[role='button']")).toBeNull();
      expect(clear.closest("button.obs-date-range-trigger")).toBeNull();
      expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();

      await userEvent.click(clear);
      expect(screen.getByRole("button", { name: /Date range/i })).toHaveTextContent("All dates");
    });

    it("closes with Escape while focus is still on the trigger", async () => {
      useFixture();
      render(<AlmanacView />);
      await loaded();
      const trigger = screen.getByRole("button", { name: /Date range/i });
      await userEvent.click(trigger);
      trigger.focus();
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByTestId("date-range-popover")).not.toBeInTheDocument());
      expect(trigger).toHaveFocus();
    });
  });

  describe("day pages", () => {
    it("sets each day as a page: numeral, weekday, month and year, then sessions by project", async () => {
      useFixture();
      render(<AlmanacView />);
      await loaded();

      const days = screen.getAllByTestId("almanac-day");
      expect(days).toHaveLength(4); // three dated days and "Undated"

      const first = days[0];
      expect(within(first).getByRole("heading", { level: 3, name: "Wednesday, October 7, 2026" })).toBeInTheDocument();
      expect(first.querySelector(".almanac-day__numeral")?.textContent).toBe("7");
      expect(first.querySelector(".almanac-day__weekday")?.textContent).toBe("Wednesday");
      expect(first.querySelector(".almanac-day__month")?.textContent).toBe("October 2026");

      const group = within(first).getAllByTestId("almanac-project-group")[0];
      expect(within(group).getByRole("heading", { level: 4, name: "alpha" })).toBeInTheDocument();
      const path = group.querySelector(".almanac-project__path") as HTMLElement;
      expect(path.textContent).toBe("/work/alpha");
      expect(path).toHaveAttribute("title", "/work/alpha");

      // Undated is last
      expect(within(days[3]).getByRole("heading", { level: 3, name: "Undated" })).toBeInTheDocument();
      expect(within(days[3]).getByText("Lost transcript")).toBeInTheDocument();
    });

    it("truncates a long project path in the middle and keeps the full path in a title", async () => {
      const long = "/Users/someone/Products/a-very-long-folder-name/with/many/nested/parts/final-project";
      useFixture([session("long", { project_root: long })]);
      render(<AlmanacView />);
      await loaded();
      const path = document.querySelector(".almanac-project__path") as HTMLElement;
      expect(path).toHaveAttribute("title", long);
      expect(path.textContent!.length).toBeLessThan(long.length);
      expect(path.textContent).toContain("...");
      expect(path.textContent!.startsWith("/Users")).toBe(true);
      expect(path.textContent!.endsWith("final-project")).toBe(true);
    });

    it("shows each session as one row button with glyph, meta line and a quiet status mark", async () => {
      useFixture();
      render(<AlmanacView />);
      await loaded();

      const rows = screen.getAllByTestId("almanac-session-item");
      const byTitle = (title: string) => rows.find((r) => r.textContent!.includes(title))!;

      for (const row of rows) {
        expect(row.tagName).toBe("BUTTON");
        expect(within(row).getByTestId("agent-glyph")).toBeInTheDocument();
        expect(row.querySelector(".obs-mark")).not.toBeNull();
        expect(row.querySelector("[class*='badge']")).toBeNull();
      }

      const waiting = byTitle("Fix the login redirect");
      expect(waiting.querySelector(".obs-mark--alert")).not.toBeNull();
      expect(within(waiting).getByText("Needs you")).toBeInTheDocument();
      expect(within(waiting).getByText("12 turns")).toBeInTheDocument();
      expect(within(waiting).getByTestId("session-duration")).toHaveTextContent(/^25m$/);
      expect(within(waiting).getByText("claude-opus")).toBeInTheDocument();
      expect(waiting).toHaveTextContent("14:30");

      const working = byTitle("Tidy the stylesheet");
      expect(working.querySelector(".obs-mark--gilt")).not.toBeNull();
      // unknown values stay unknown, never zero
      expect(within(working).getByText("model unknown")).toBeInTheDocument();
      expect(within(working).getByTestId("session-duration")).not.toHaveTextContent(/^0/);

      const done = byTitle("Draft the release notes");
      expect(done.querySelector(".obs-mark--success")).not.toBeNull();

      const idle = byTitle("Check the cache");
      expect(idle.querySelector(".obs-mark--neutral.obs-mark--ring")).not.toBeNull();
      expect(within(idle).getByText("Idle")).toBeInTheDocument();

      const undated = byTitle("Lost transcript");
      expect(within(undated).getByTestId("session-duration")).toHaveTextContent("duration unknown");
      expect(undated).toHaveTextContent("time unknown");
    });

    it("puts data-testid and data-session-id on every row's interactive element (the demo tour hooks)", async () => {
      const data = fixture();
      useFixture(data);
      const { container } = render(<AlmanacView />);
      await loaded();

      const rows = screen.getAllByTestId("almanac-session-item");
      expect(rows).toHaveLength(data.length);
      expect(container.querySelectorAll("[data-session-id]")).toHaveLength(rows.length);
      for (const row of rows) {
        expect(row.tagName).toBe("BUTTON");
        expect(row.getAttribute("data-session-id")).toBeTruthy();
      }
      expect(rows.map((r) => r.getAttribute("data-session-id")).sort()).toEqual(data.map((s) => s.id).sort());
    });

    it("formats durations without zero parts: 42s, 48m, 1h 30m, 2h", () => {
      const min = 60_000;
      expect(formatSessionDuration(0)).toBe("0s");
      expect(formatSessionDuration(42_000)).toBe("42s");
      expect(formatSessionDuration(59_999)).toBe("59s");
      expect(formatSessionDuration(min)).toBe("1m");
      expect(formatSessionDuration(48 * min)).toBe("48m");
      expect(formatSessionDuration(12 * min + 59_000)).toBe("12m");
      expect(formatSessionDuration(60 * min)).toBe("1h");
      expect(formatSessionDuration(90 * min)).toBe("1h 30m");
      expect(formatSessionDuration(120 * min)).toBe("2h");
      expect(formatSessionDuration(125 * min + 30_000)).toBe("2h 5m");
    });

    it("shows those durations on rows, with unknown and live values unchanged", async () => {
      const min = 60_000;
      useFixture([
        session("a", { title: "A short one", started_at: T, ended_at: T + 42_000 }),
        session("b", { title: "B mid", started_at: T - 1000, ended_at: T - 1000 + 48 * min }),
        session("c", { title: "C hour", started_at: T - 2000, ended_at: T - 2000 + 90 * min }),
        session("d", { title: "D two hours", started_at: T - 3000, ended_at: T - 3000 + 120 * min }),
        session("e", { title: "E live", status: "working", ended_at: null, started_at: T - 4000 }),
        session("f", { title: "F undated", started_at: null, ended_at: null }),
      ]);
      render(<AlmanacView />);
      await loaded();
      const duration = (title: string) =>
        within(screen.getAllByTestId("almanac-session-item").find((r) => r.textContent!.includes(title))!)
          .getByTestId("session-duration").textContent;
      expect(duration("A short one")).toBe("42s");
      expect(duration("B mid")).toBe("48m");
      expect(duration("C hour")).toBe("1h 30m");
      expect(duration("D two hours")).toBe("2h");
      expect(duration("E live")).toBe("in progress");
      expect(duration("F undated")).toBe("duration unknown");
    });

    it("lists up to three touched file basenames in mono, plus '+N more', with the full list in a title", async () => {
      const files = ["src/App.tsx", "src/api/archive.ts", "docs/README.md", "tests/a.test.ts", "tests/b.test.ts"];
      const s = { ...session("files"), touched_files: files } as Session;
      useFixture([s]);
      render(<AlmanacView />);
      await loaded();
      const box = document.querySelector(".almanac-row__files") as HTMLElement;
      expect(box).not.toBeNull();
      expect(box).toHaveAttribute("title", files.join("\n"));
      expect(box.textContent).toContain("App.tsx");
      expect(box.textContent).toContain("archive.ts");
      expect(box.textContent).toContain("README.md");
      expect(box.textContent).not.toContain("a.test.ts");
      expect(box.textContent).toContain("+2 more");
    });

    it("opens the session in the Folio with Enter and with Space, and with a click", async () => {
      useFixture();
      const onOpen = vi.fn();
      render(<AlmanacView onOpenSession={onOpen} />);
      await loaded();

      const rows = screen.getAllByTestId("almanac-session-item");
      rows[0].focus();
      await userEvent.keyboard("{Enter}");
      expect(onOpen).toHaveBeenLastCalledWith(rows[0].getAttribute("data-session-id"));

      rows[0].focus();
      await userEvent.keyboard(" ");
      expect(onOpen).toHaveBeenCalledTimes(2);

      await userEvent.click(rows[1]);
      expect(onOpen).toHaveBeenLastCalledWith(rows[1].getAttribute("data-session-id"));
    });

    it("moves between rows with the arrow keys and keeps one row in the tab order", async () => {
      useFixture();
      render(<AlmanacView />);
      await loaded();

      const rows = screen.getAllByTestId("almanac-session-item");
      expect(rows.filter((r) => r.tabIndex === 0)).toHaveLength(1);
      rows[0].focus();
      fireEvent.keyDown(rows[0], { key: "ArrowDown" });
      expect(document.activeElement).toBe(rows[1]);
      fireEvent.keyDown(rows[1], { key: "ArrowUp" });
      expect(document.activeElement).toBe(rows[0]);
    });
  });

  describe("motion", () => {
    it("staggers the first days by their index, capped at 8 steps", async () => {
      const many = Array.from({ length: 12 }, (_, i) =>
        session(`d${i}`, { title: `Day ${i}`, started_at: T - i * DAY, ended_at: T - i * DAY + 60_000 }),
      );
      useFixture(many);
      render(<AlmanacView />);
      await loaded();
      const days = screen.getAllByTestId("almanac-day");
      expect(days.map((d) => d.getAttribute("data-stagger-index"))).toEqual(
        ["0", "1", "2", "3", "4", "5", "6", "7", "8", "8", "8", "8"],
      );
      expect((days[3] as HTMLElement).style.getPropertyValue("--almanac-stagger")).toBe("3");
      expect((days[11] as HTMLElement).style.getPropertyValue("--almanac-stagger")).toBe("8");
    });

    it("re-staggers when a filter changes", async () => {
      useFixture();
      render(<AlmanacView />);
      await loaded();
      const before = screen.getAllByTestId("almanac-day")[0];

      await userEvent.click(within(screen.getByRole("radiogroup", { name: "Status" })).getByRole("radio", { name: "Idle" }));
      await waitFor(() => expect(screen.getAllByTestId("almanac-session-item")).toHaveLength(2));
      const after = screen.getAllByTestId("almanac-day");
      expect(after[0]).not.toBe(before);
      expect(after.map((d) => d.getAttribute("data-stagger-index"))).toEqual(["0", "1"]);
    });

    it("gives days that are mounted by scrolling no delay", async () => {
      setArchiveClient(createMockArchiveClient(generateSyntheticSessions(3000)));
      render(<AlmanacView virtualized />);
      await loaded();
      const first = screen.getAllByTestId("almanac-day");
      expect(first[0]).toHaveAttribute("data-stagger-index", "0");

      const container = screen.getByTestId("almanac-days-container");
      Object.defineProperty(container, "scrollTop", { value: 40_000, configurable: true, writable: true });
      fireEvent.scroll(container);

      await waitFor(() => {
        const now = screen.getAllByTestId("almanac-day");
        expect(now[0].getAttribute("data-day-key")).not.toBe(first[0].getAttribute("data-day-key"));
      });
      for (const d of screen.getAllByTestId("almanac-day")) {
        expect(d).not.toHaveAttribute("data-stagger-index");
        expect((d as HTMLElement).style.getPropertyValue("--almanac-stagger")).toBe("");
      }
    });
  });

  describe("date filter", () => {
    it("queries a picked day from local midnight to the next local midnight", async () => {
      (window as unknown as Record<string, unknown>).__ARMILLARY_NOW__ = T;
      const client = createMockArchiveClient(fixture());
      const spy = vi.spyOn(client, "sessions_query");
      setArchiveClient(client);
      render(<AlmanacView />);
      await loaded();

      await userEvent.click(screen.getByRole("button", { name: /Date range/i }));
      await userEvent.click(screen.getByRole("button", { name: "Today" }));
      await waitFor(() => expect(spy.mock.calls.some(([f]) => f?.from !== undefined)).toBe(true));
      const sent = spy.mock.calls.map(([f]) => f).filter((f) => f?.from !== undefined).at(-1);
      expect(sent?.from).toBe(new Date(2026, 9, 7).getTime());
      expect(sent?.to).toBe(new Date(2026, 9, 8).getTime() - 1);
    });
  });

  describe("empty and large", () => {
    it("says so in one italic line, with Clear filters, when nothing matches", async () => {
      (window as unknown as Record<string, unknown>).__ARMILLARY_NOW__ = new Date(2031, 2, 15, 12, 0).getTime();
      useFixture();
      render(<AlmanacView />);
      await loaded();

      await userEvent.click(screen.getByRole("button", { name: /Date range/i }));
      await userEvent.click(screen.getByRole("button", { name: "Today" }));

      const line = await screen.findByText("No sessions match these filters.");
      expect(line).toHaveClass("almanac-empty__line");
      expect(screen.queryByTestId("almanac-session-item")).not.toBeInTheDocument();
      const clear = screen.getByRole("button", { name: "Clear filters" });
      await userEvent.click(clear);
      await waitFor(() => expect(screen.getAllByTestId("almanac-session-item")).toHaveLength(5));
    });

    it("virtualizes a large dataset of 10,000 sessions", async () => {
      setArchiveClient(createMockArchiveClient(generateSyntheticSessions(10000)));
      render(<AlmanacView virtualized />);
      await loaded();

      const rendered = screen.getAllByTestId("almanac-session-item");
      expect(rendered.length).toBeLessThan(100);
      expect(rendered.length).toBeGreaterThan(0);
      const figures = screen.getByRole("group", { name: "Summary" });
      expect(within(figures).getByText("10,000")).toBeInTheDocument();
    });

    it("computes a variable-height window with spacers that sum to the total height", () => {
      const heights = [100, 200, 50, 400, 80, 120];
      const tops: number[] = [];
      let acc = 0;
      for (const h of heights) {
        tops.push(acc);
        acc += h;
      }
      const range = calculateVariableRange({ tops, heights, viewportHeight: 200, scrollTop: 320, overscanPx: 0 });
      expect(range.startIndex).toBe(2); // the window is 320 to 520: day 1 ends at 300, day 2 spans 300 to 350
      expect(range.endIndex).toBe(4); // day 3 spans 350 to 750 and touches 520; day 4 starts at 750
      expect(range.topSpacerHeight).toBe(tops[range.startIndex]);
      const rendered = heights.slice(range.startIndex, range.endIndex).reduce((a, b) => a + b, 0);
      expect(range.topSpacerHeight + rendered + range.bottomSpacerHeight).toBe(acc);

      const empty = calculateVariableRange({ tops: [], heights: [], viewportHeight: 200, scrollTop: 0, overscanPx: 0 });
      expect(empty).toMatchObject({ startIndex: 0, endIndex: 0, topSpacerHeight: 0, bottomSpacerHeight: 0 });
    });
  });

  describe("quality", () => {
    it("passes axe-core with 0 serious or critical violations, popover open", async () => {
      useFixture();
      const { container } = render(<AlmanacView />);
      await loaded();
      await userEvent.click(screen.getByRole("button", { name: /Date range/i }));
      const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
      const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    });

    it("contains no em or en dashes in rendered text in both themes", async () => {
      useFixture();
      const { container, rerender } = render(<AlmanacView />);
      await loaded();
      for (const theme of ["dark", "light"]) {
        document.documentElement.setAttribute("data-theme", theme);
        rerender(<AlmanacView />);
        const text = container.textContent || "";
        expect(text).not.toContain("—");
        expect(text).not.toContain("–");
      }
    });
  });
});

describe("status grouping (views/Almanac/status.ts)", () => {
  it.each<[string | null, string]>([
    ["completed", "finished"],
    ["complete", "finished"],
    ["done", "finished"],
    ["finished", "finished"],
    ["closed", "finished"],
    ["success", "finished"],
    ["succeeded", "finished"],
    ["ended", "finished"],
    ["active", "open"],
    ["working", "open"],
    ["open", "open"],
    ["running", "open"],
    ["in_progress", "open"],
    ["in progress", "open"],
    ["live", "open"],
    ["waiting", "needs"],
    ["failed", "failed"],
    ["failure", "failed"],
    ["error", "failed"],
    ["errored", "failed"],
    ["crashed", "failed"],
    ["aborted", "failed"],
    ["unknown", "unknown"],
    ["", "unknown"],
    ["   ", "unknown"],
    [null, "unknown"],
    // case and surrounding whitespace do not matter
    ["COMPLETED", "finished"],
    ["  Done  ", "finished"],
    ["\tWorking\n", "open"],
    [" WAITING ", "needs"],
    ["Failed", "failed"],
    ["UNKNOWN", "unknown"],
    // anything else is its own group
    ["idle", "other:idle"],
    ["Paused", "other:paused"],
    ["  NEEDS REVIEW ", "other:needs review"],
  ])("groups %j as %s", (raw, key) => {
    expect(statusGroupOf(raw).key).toBe(key);
  });

  it("labels the groups, and sentence-cases other statuses", () => {
    expect(statusGroupOf("active").label).toBe("Open");
    expect(statusGroupOf("waiting").label).toBe("Needs you");
    expect(statusGroupOf("done").label).toBe("Finished");
    expect(statusGroupOf("crashed").label).toBe("Failed");
    expect(statusGroupOf(null).label).toBe("Unknown");
    expect(statusGroupOf("idle").label).toBe("Idle");
    expect(statusGroupOf("  NEEDS REVIEW ").label).toBe("Needs review");
  });

  it("lists one group per key, in the order Open, Needs you, Finished, Failed, Unknown, then others A to Z", () => {
    const groups = groupStatuses(["zeta", "idle", "done", "failed", "unknown", "waiting", "active", "alpha", "", "completed"]);
    expect(groups.map((g) => g.key)).toEqual([
      "open",
      "needs",
      "finished",
      "failed",
      "unknown",
      "other:alpha",
      "other:idle",
      "other:zeta",
    ]);
  });

  it("returns the raw statuses of a group, and only those present", () => {
    expect(rawStatusesIn("finished", ["completed", "done", "idle", "Done "])).toEqual(["completed", "done", "Done "]);
    expect(rawStatusesIn("other:idle", ["completed", "idle"])).toEqual(["idle"]);
    expect(rawStatusesIn("failed", ["done"])).toEqual([]);
  });
});
