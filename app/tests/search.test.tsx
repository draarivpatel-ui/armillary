import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SearchView } from "../src/views/Search";
import {
  resetArchiveClient,
  setArchiveClient,
  createMockArchiveClient,
  type ArchiveClient,
  type SearchFilter,
  type SearchHit,
} from "../src/api/archive";

const CSS = readFileSync(path.resolve(__dirname, "../src/views/Search/Search.css"), "utf8");

function hit(n: number, over: Partial<SearchHit> = {}): SearchHit {
  return {
    session_id: `sess-${over.session_id ?? (n < 6 ? "a" : "b")}`,
    message_id: `m-${n}`,
    seq: n,
    block_index: 0,
    kind: n % 3 === 0 ? "tool" : "message",
    at: 1_700_000_000_000 + n * 60_000,
    score: 1,
    text: `Row ${n} about the lantern fixture`,
    highlights: [[`Row ${n} about the `.length, `Row ${n} about the lantern`.length]],
    agent_id: "claude-code",
    project_root: "/work/alpha",
    session_title: n < 6 ? "Lantern session" : "Second session",
    session_started_at: 1_700_000_000_000,
    ...over,
  };
}

/** A deterministic client that records every filter it is asked for. */
function fakeClient(count = 12) {
  const base = createMockArchiveClient();
  const calls: Array<{ query: string; filter?: SearchFilter }> = [];
  const client: ArchiveClient = {
    ...base,
    sessions_query: (f) => base.sessions_query(f),
    session_get: (id) => base.session_get(id),
    messages_page: (id, l, o) => base.messages_page(id, l, o),
    async search(query, filter) {
      calls.push({ query, filter });
      const items = query.includes("zzz") ? [] : Array.from({ length: count }, (_, i) => hit(i + 1));
      return { items, limit: filter?.limit ?? 20, offset: 0, has_more: false };
    },
  };
  return { client, calls };
}

const NOW = new Date(2031, 2, 15, 12, 0, 0).getTime();

describe("Search View (SPEC 2.7)", () => {
  beforeEach(() => {
    resetArchiveClient();
    document.documentElement.setAttribute("data-theme", "dark");
  });
  afterEach(() => {
    delete (window as unknown as { __ARMILLARY_NOW__?: number }).__ARMILLARY_NOW__;
    resetArchiveClient();
  });

  it("has the head, one box and quiet filters, with no unverified claims", async () => {
    render(<SearchView initialQuery="design" />);

    expect(screen.getByRole("heading", { level: 2, name: "Search" })).toBeInTheDocument();
    expect(screen.getByText("Archive")).toBeInTheDocument();
    expect(
      screen.getByText("One box over every prompt, reply, tool call and file path you have archived."),
    ).toBeInTheDocument();

    const box = screen.getByRole("searchbox", { name: /Search/i });
    expect(box).toHaveValue("design");

    expect(screen.getByRole("combobox", { name: "Agent" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Project" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Date" })).toBeInTheDocument();
    // the native date inputs are gone
    expect(document.querySelectorAll("input[type='date']")).toHaveLength(0);

    await waitFor(() => expect(screen.getAllByTestId("search-hit-item").length).toBeGreaterThan(0));
    // the chrome around the results (mock hit text may mention anything)
    const results = document.querySelector(".search-results") as HTMLElement;
    const text = (document.body.textContent ?? "").replace(results.textContent ?? "", "");
    expect(text).not.toMatch(/FTS5|SQLite|Indexed locally|100k|200 ms|BM25|relevance/i);
    expect(screen.queryByTestId("hit-relevance")).toBeNull();
  });

  it("offers the key hints when empty and a clear button when there is text", async () => {
    render(<SearchView />);
    const hints = document.querySelector(".search-hint") as HTMLElement;
    expect(within(hints).getByText("/")).toBeInTheDocument();
    expect(within(hints).getByText("Esc")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Clear search/i })).toBeNull();

    const box = screen.getByRole("searchbox");
    await userEvent.type(box, "contrast");
    await userEvent.click(screen.getByRole("button", { name: /Clear search/i }));
    expect(box).toHaveValue("");
  });

  it("shows the initial and the no-results states", async () => {
    const { client } = fakeClient();
    setArchiveClient(client);
    render(<SearchView />);
    expect(screen.getByText("Search every session you have archived.")).toBeInTheDocument();
    expect(screen.getByText("Try a file name, an error message or a tool name.")).toBeInTheDocument();

    await userEvent.type(screen.getByRole("searchbox"), "zzzq");
    await waitFor(() => expect(screen.getByText("Nothing matches")).toBeInTheDocument());
    const quoted = document.querySelector(".search-empty__query") as HTMLElement;
    expect(quoted.textContent).toBe("zzzq");
  });

  it("groups hits under a header per session with agent, title, project, date and count", async () => {
    const { client } = fakeClient(8);
    setArchiveClient(client);
    render(<SearchView initialQuery="lantern" />);

    await waitFor(() => expect(screen.getAllByTestId("search-hit-item")).toHaveLength(8));
    const groups = screen.getAllByTestId("search-group");
    expect(groups).toHaveLength(2);

    const first = groups[0];
    expect(within(first).getByRole("heading", { level: 3, name: /Lantern session/ })).toBeInTheDocument();
    expect(within(first).getByTestId("group-count").textContent).toMatch(/5 hits/);
    expect(first.textContent).toContain("alpha");
    expect(first.querySelector("[data-testid='group-glyph']")).not.toBeNull();
    expect(within(groups[1]).getByTestId("group-count").textContent).toMatch(/3 hits/);
    for (const h of within(first).getAllByTestId("search-hit-item")) {
      expect(h).toHaveAttribute("data-session-id", "sess-a");
    }
  });

  it("labels each hit by kind and renders the snippet only through highlight ranges", async () => {
    const { client } = fakeClient(4);
    setArchiveClient(client);
    render(<SearchView initialQuery="lantern" />);
    await waitFor(() => expect(screen.getAllByTestId("search-hit-item")).toHaveLength(4));

    const hits = screen.getAllByTestId("search-hit-item");
    expect(within(hits[0]).getByTestId("hit-kind").textContent).toBe("Message");
    expect(within(hits[2]).getByTestId("hit-kind").textContent).toBe("Tool call");
    const snippet = within(hits[0]).getByTestId("hit-snippet");
    expect(snippet.querySelector("mark")?.textContent).toBe("lantern");
    expect(snippet.querySelector("mark")?.children).toHaveLength(0);
  });

  it("shows a literal markup string as text, never as elements", async () => {
    const base = fakeClient(1);
    const evil: ArchiveClient = {
      ...base.client,
      search: async () => ({
        items: [hit(1, { text: "<img src=x onerror=alert(1)> done", highlights: [[0, 5]] })],
        limit: 50,
        offset: 0,
        has_more: false,
      }),
    };
    setArchiveClient(evil);
    render(<SearchView initialQuery="img" />);
    await waitFor(() => expect(screen.getAllByTestId("search-hit-item")).toHaveLength(1));
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByTestId("hit-snippet").textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("maps the date presets to from and to through appNow()", async () => {
    (window as unknown as { __ARMILLARY_NOW__: number }).__ARMILLARY_NOW__ = NOW;
    const { client, calls } = fakeClient(2);
    setArchiveClient(client);
    render(<SearchView initialQuery="lantern" />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[calls.length - 1].filter?.from).toBeUndefined();
    expect(calls[calls.length - 1].filter?.to).toBeUndefined();

    const date = screen.getByRole("combobox", { name: "Date" });
    expect(within(date).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Any time",
      "Today",
      "Last 7 days",
      "Last 30 days",
      "Last 365 days",
    ]);

    const startOfDay = (daysBack: number) => {
      const d = new Date(NOW);
      d.setDate(d.getDate() - daysBack);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    };
    const endOfToday = new Date(NOW).setHours(23, 59, 59, 999);

    await userEvent.selectOptions(date, "Today");
    await waitFor(() => expect(calls[calls.length - 1].filter?.from).toBe(startOfDay(0)));
    expect(calls[calls.length - 1].filter?.to).toBe(endOfToday);

    await userEvent.selectOptions(date, "Last 7 days");
    await waitFor(() => expect(calls[calls.length - 1].filter?.from).toBe(startOfDay(6)));

    await userEvent.selectOptions(date, "Last 30 days");
    await waitFor(() => expect(calls[calls.length - 1].filter?.from).toBe(startOfDay(29)));

    await userEvent.selectOptions(date, "Last 365 days");
    await waitFor(() => expect(calls[calls.length - 1].filter?.from).toBe(startOfDay(364)));

    await userEvent.selectOptions(date, "Any time");
    await waitFor(() => expect(calls[calls.length - 1].filter?.from).toBeUndefined());
  });

  it("filters by agent and project", async () => {
    render(<SearchView initialQuery="code" />);
    await waitFor(() => expect(screen.getAllByTestId("search-hit-item").length).toBeGreaterThan(0));

    const agentSelect = screen.getByRole("combobox", { name: "Agent" });
    await waitFor(() => expect(within(agentSelect).getAllByRole("option").length).toBeGreaterThan(1));
    await userEvent.selectOptions(agentSelect, "claude-code");

    await waitFor(() => {
      const hits = screen.getAllByTestId("search-hit-item");
      hits.forEach((h) => expect(h).toHaveAttribute("data-agent", "claude-code"));
    });
  });

  it("opens the Folio at the hit when clicking or pressing Enter", async () => {
    const { client } = fakeClient(4);
    setArchiveClient(client);
    const onOpenFolio = vi.fn();
    render(<SearchView initialQuery="lantern" onOpenFolio={onOpenFolio} />);
    await waitFor(() => expect(screen.getAllByTestId("search-hit-item")).toHaveLength(4));

    const hits = screen.getAllByTestId("search-hit-item");
    expect(hits[0].tagName).toBe("BUTTON");
    await userEvent.click(hits[0]);
    expect(onOpenFolio).toHaveBeenLastCalledWith("sess-a", 1);

    hits[1].focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpenFolio).toHaveBeenLastCalledWith("sess-a", 2);
  });

  it("supports arrow-key navigation across hits, including across groups", async () => {
    const { client } = fakeClient(8);
    setArchiveClient(client);
    render(<SearchView initialQuery="lantern" />);
    await waitFor(() => expect(screen.getAllByTestId("search-hit-item")).toHaveLength(8));

    const hits = screen.getAllByTestId("search-hit-item");
    hits[0].focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(hits[1]);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(hits[0]);
    hits[4].focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(hits[5]);
  });

  it("twinkles each hit once, staggered and capped, and not at all under reduced motion", async () => {
    const { client } = fakeClient(14);
    setArchiveClient(client);
    render(<SearchView initialQuery="lantern" />);
    await waitFor(() => expect(screen.getAllByTestId("search-hit-item")).toHaveLength(14));

    const glints = Array.from(document.querySelectorAll<HTMLElement>(".search-hit__glint"));
    expect(glints).toHaveLength(14);
    expect(glints[0].style.animationDelay).toBe("0ms");
    expect(glints[3].style.animationDelay).toBe("90ms");
    expect(glints[10].style.animationDelay).toBe("300ms");
    expect(glints[13].style.animationDelay).toBe("300ms");

    const rule = CSS.match(/\.search-hit__glint\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/animation-iteration-count:\s*1\s*;/);
    expect(rule).toMatch(/animation-duration:\s*var\(--motion-twinkle\)/);
    expect(rule).not.toMatch(/infinite/);
    expect(CSS).toMatch(/@keyframes\s+search-twinkle/);

    const reduced = CSS.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(reduced).toMatch(/\.search-hit__glint[\s\S]*display:\s*none/);
  });

  it("restarts the glint only when a new result set arrives", async () => {
    const { client } = fakeClient(3);
    setArchiveClient(client);
    render(<SearchView initialQuery="lantern" />);
    await waitFor(() => expect(document.querySelectorAll(".search-hit__glint")).toHaveLength(3));
    const before = document.querySelector(".search-hit__glint");

    // moving selection around does not replace the glint node
    const hits = screen.getAllByTestId("search-hit-item");
    hits[0].focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.querySelector(".search-hit__glint")).toBe(before);

    await userEvent.type(screen.getByRole("searchbox"), "s");
    await waitFor(() => expect(document.querySelector(".search-hit__glint")).not.toBe(before));
  });

  it("passes axe-core with 0 serious or critical violations", async () => {
    const { client } = fakeClient(6);
    setArchiveClient(client);
    const { container } = render(<SearchView initialQuery="lantern" />);
    await waitFor(() => expect(screen.getAllByTestId("search-hit-item").length).toBeGreaterThan(0));

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious).toHaveLength(0);
  });

  it("contains no em or en dashes in rendered text in both themes", async () => {
    const { container, rerender } = render(<SearchView initialQuery="design" />);
    await waitFor(() => expect(screen.getAllByTestId("search-hit-item").length).toBeGreaterThan(0));

    const textDark = container.textContent || "";
    expect(textDark).not.toContain("—");
    expect(textDark).not.toContain("–");

    document.documentElement.setAttribute("data-theme", "light");
    rerender(<SearchView initialQuery="design" />);
    const textLight = container.textContent || "";
    expect(textLight).not.toContain("—");
    expect(textLight).not.toContain("–");
    expect(CSS).not.toMatch(/[–—]/);
  });
});
