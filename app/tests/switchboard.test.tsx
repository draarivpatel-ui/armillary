import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { SwitchboardView } from "../src/views/SwitchboardView";
import { configList } from "../src/api/config";

describe("Switchboard Acceptance Tests", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  describe("Typed config client (app/src/api/config.ts)", () => {
    it("loads the normalized configuration snapshot with eight agents", async () => {
      const snapshot = await configList();
      expect(snapshot.agents).toHaveLength(8);
      expect(snapshot.agents.map((a) => a.agent)).toEqual([
        "claude-code",
        "codex-cli",
        "gemini-cli",
        "cursor",
        "opencode",
        "copilot-cli",
        "windsurf",
        "cline",
      ]);
      expect(snapshot.serverMatrix.length).toBeGreaterThan(0);
      expect(snapshot.maskedValueCount).toBe(10);
    });
  });

  describe("Switchboard View (app/src/views/Switchboard/)", () => {
    const AGENT_NAMES = [
      "Claude Code",
      "Codex CLI",
      "Gemini CLI",
      "Cursor",
      "OpenCode",
      "GitHub Copilot CLI",
      "Windsurf",
      "Cline",
    ];

    it("opens on the Matrix tab, with the three tabs and the controls the demo tour targets", () => {
      render(<SwitchboardView />);
      const tabs = screen.getAllByRole("tab");
      expect(tabs.map((t) => t.textContent)).toEqual(["Matrix", "Side by side", "Rules"]);
      expect(tabs.map((t) => t.getAttribute("data-tab"))).toEqual(["matrix", "side-by-side", "rules"]);
      expect(tabs[0]).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("table", { name: /servers by agent/i })).toBeInTheDocument();

      expect(screen.getByRole("textbox", { name: "Filter servers" })).toBeInTheDocument();
      const diffOnly = screen.getByRole("checkbox", { name: "Differences only" });
      expect(diffOnly).toHaveAttribute("data-switchboard-differences-only");
    });

    it("heads the view with a calm eyebrow, lede, plain figures and a read-only mark", () => {
      render(<SwitchboardView />);
      expect(screen.getByRole("heading", { name: "The Switchboard", level: 2 })).toBeInTheDocument();
      expect(screen.getByText("Configuration")).toHaveClass("view-eyebrow");
      expect(
        screen.getByText("MCP servers and rules files across your agents, side by side."),
      ).toBeInTheDocument();
      expect(screen.getByText("Read only")).toBeInTheDocument();
      expect(
        screen.getByText("Secret values are never shown: only the names of variables and headers."),
      ).toBeInTheDocument();

      const figures = screen.getByRole("group", { name: "Summary" });
      const value = (label: string) =>
        within(figures).getByText(label).parentElement!.querySelector(".obs-figure__value")!.textContent;
      expect(value("agents")).toBe("8");
      expect(value("servers")).toBe("20");
      // context7, github and linear are wired differently from agent to agent
      expect(value("differ")).toBe("3");
    });

    it("lists every server by agent, with a labelled cell for each pair", () => {
      render(<SwitchboardView />);
      const table = screen.getByRole("table", { name: /servers by agent/i });
      const rows = within(table).getAllByRole("row").filter((r) => r.closest("tbody"));
      expect(rows).toHaveLength(20);
      // 20 servers by 8 agents
      const cells = table.querySelectorAll("tbody td[data-agent]");
      expect(cells).toHaveLength(160);
      for (const cell of Array.from(cells)) {
        const mark = cell.querySelector('[role="img"]');
        expect(mark).not.toBeNull();
        expect(mark!.getAttribute("aria-label")).toMatch(
          new RegExp(`^(Present in|Disabled in|Not in) (${AGENT_NAMES.join("|")})$`),
        );
      }
      const claude = within(table).getByRole("row", { name: /^linear/ });
      expect(within(claude).getByRole("img", { name: "Present in Claude Code" })).toBeInTheDocument();
      expect(within(claude).getByRole("img", { name: "Not in Cursor" })).toBeInTheDocument();
      const legacy = within(table).getByRole("row", { name: /^disabled-legacy/ });
      expect(within(legacy).getByRole("img", { name: /^(Present|Disabled) in Claude Code$/ })).toBeInTheDocument();
    });

    it("names every agent in its column header", () => {
      render(<SwitchboardView />);
      const table = screen.getByRole("table", { name: /servers by agent/i });
      for (const name of AGENT_NAMES) {
        expect(within(table).getByRole("columnheader", { name })).toBeInTheDocument();
      }
    });

    it("says in plain words how many agents have a server, and where it differs", () => {
      render(<SwitchboardView />);
      const table = screen.getByRole("table", { name: /servers by agent/i });
      const chrome = within(table).getByRole("row", { name: /^chrome-devtools/ });
      expect(within(chrome).getByText("In 1 of 8 agents")).toBeInTheDocument();
      expect(chrome).toHaveAttribute("data-differs", "false");

      const linear = within(table).getByRole("row", { name: /^linear/ });
      expect(linear).toHaveAttribute("data-differs", "true");
      expect(within(linear).getByText(/^Differs in [1-9]\d*$/)).toBeInTheDocument();
    });

    it("keeps shouting pill copy out of every tab", async () => {
      const user = userEvent.setup();
      const { container } = render(<SwitchboardView />);
      for (const name of ["Matrix", "Side by side", "Rules"]) {
        await user.click(screen.getByRole("tab", { name }));
        const text = container.textContent ?? "";
        expect(text).not.toMatch(/MISSING IT|WIRINGS|DIFFERENCES|SECRETS MASKED|SAFE MODE|DEMO DATA/);
        expect(text).not.toMatch(/missing it|wirings|safe mode/i);
        expect(container.querySelector(".obs-badge")).toBeNull();
      }
    });

    it("fits the matrix inside the content width at 1280 and 1440 with no horizontal scroll", () => {
      render(<SwitchboardView />);
      const table = screen.getByRole("table", { name: /servers by agent/i });
      const cols = Array.from(table.querySelectorAll("colgroup col"));
      expect(cols).toHaveLength(10);
      const widths = cols.map((c) => parseFloat((c as HTMLElement).style.width || "0"));
      const [first, ...rest] = widths;
      const agentCols = rest.slice(0, 8);
      const summary = Math.max(rest[8] || 0, 136);
      for (const w of agentCols) {
        expect(w).toBeGreaterThanOrEqual(76);
        expect(w).toBeLessThanOrEqual(88);
      }
      // content width is the window minus the 232 px rail and 2 x 40 px padding
      const total = first + agentCols.reduce((a, b) => a + b, 0) + summary;
      expect(total).toBeLessThanOrEqual(1280 - 232 - 80);
      expect(total).toBeLessThanOrEqual(1440 - 232 - 80);
    });

    it("filters by name and by differences only", async () => {
      const user = userEvent.setup();
      render(<SwitchboardView />);
      const table = screen.getByRole("table", { name: /servers by agent/i });
      const bodyRows = () => Array.from(table.querySelectorAll("tbody tr[data-differs]"));

      await user.type(screen.getByRole("textbox", { name: "Filter servers" }), "lin");
      expect(bodyRows().map((r) => r.querySelector("th")!.textContent)).toEqual([expect.stringMatching(/^linear/)]);
      await user.clear(screen.getByRole("textbox", { name: "Filter servers" }));

      await user.click(screen.getByRole("checkbox", { name: "Differences only" }));
      expect(bodyRows()).toHaveLength(3);
      expect(bodyRows().every((r) => r.getAttribute("data-differs") === "true")).toBe(true);
    });

    it("lays the agents out side by side in a labelled, focusable region of their own", async () => {
      const user = userEvent.setup();
      render(<SwitchboardView />);
      await user.click(screen.getByRole("tab", { name: "Side by side" }));

      for (const name of AGENT_NAMES) {
        expect(screen.getByRole("heading", { name: new RegExp(`^${name}`, "i") })).toBeInTheDocument();
      }
      expect(screen.getAllByText(/playwright/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/linear/i).length).toBeGreaterThan(0);

      // any inner scroller is reachable by keyboard and named (axe: scrollable-region-focusable)
      const region = screen.getByRole("region", { name: /agents side by side/i });
      expect(region).toHaveAttribute("tabindex", "0");
    });

    it("collapses launch commands behind a disclosure and shows secrets as a quiet masked token", async () => {
      const user = userEvent.setup();
      render(<SwitchboardView />);
      await user.click(screen.getByRole("tab", { name: "Side by side" }));

      const toggles = screen.getAllByRole("button", { name: /^Details for / });
      expect(toggles.length).toBeGreaterThan(0);
      for (const t of toggles) expect(t).toHaveAttribute("aria-expanded", "false");

      // masked values from core stay exactly as [masked]
      expect(screen.getAllByText(/\[masked\]/).length).toBeGreaterThan(0);

      const first = toggles[0];
      await user.click(first);
      expect(first).toHaveAttribute("aria-expanded", "true");
      const panel = document.getElementById(first.getAttribute("aria-controls")!);
      expect(panel).not.toBeNull();
      await user.click(first);
      expect(first).toHaveAttribute("aria-expanded", "false");
    });

    it("notes credential files that were refused and never opened", async () => {
      const user = userEvent.setup();
      render(<SwitchboardView />);
      await user.click(screen.getByRole("tab", { name: "Side by side" }));
      expect(screen.getAllByText(/holds credentials, never opened/i).length).toBeGreaterThan(0);
    });

    it("lists rules files per agent as found or not found, with the path", async () => {
      const user = userEvent.setup();
      render(<SwitchboardView />);
      await user.click(screen.getByRole("tab", { name: "Rules" }));

      expect(screen.getAllByText("Found").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Not found").length).toBeGreaterThan(0);
      expect(screen.getAllByText(/CLAUDE\.md/).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/AGENTS\.md/).length).toBeGreaterThan(0);
      expect(screen.getAllByText("~/.codex/AGENTS.md").length).toBeGreaterThan(0);
    });

    it("is keyboard navigable across tabs and filters", async () => {
      const user = userEvent.setup();
      render(<SwitchboardView />);

      const tabs = screen.getAllByRole("tab");
      expect(tabs.length).toBe(3);

      // Focus first tab
      await user.tab();
      expect(document.activeElement).toBe(tabs[0]);

      // Arrow right to move to next tab
      await user.keyboard("{ArrowRight}");
      expect(document.activeElement).toBe(tabs[1]);

      // Enter to activate
      await user.keyboard("{Enter}");
      expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    });

    it("renders properly in both dark and day-almanac light themes", async () => {
      const { rerender } = render(<SwitchboardView />);

      document.documentElement.setAttribute("data-theme", "dark");
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
      expect(screen.getByRole("heading", { name: /The Switchboard/i, level: 2 })).toBeVisible();

      document.documentElement.setAttribute("data-theme", "light");
      rerender(<SwitchboardView />);
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
      expect(screen.getByRole("heading", { name: /The Switchboard/i, level: 2 })).toBeVisible();
    });

    it("passes axe-core accessibility audit on every tab with 0 serious or critical violations", async () => {
      const user = userEvent.setup();
      const { container } = render(<SwitchboardView />);

      for (const name of ["Matrix", "Side by side", "Rules"]) {
        await user.click(screen.getByRole("tab", { name }));
        const results = await axe.run(container, {
          rules: {
            // Color contrast is checked in both themes, but jsdom does not compute CSS variable colors
            "color-contrast": { enabled: false },
          },
        });
        const seriousOrCritical = results.violations.filter(
          (v) => v.impact === "serious" || v.impact === "critical",
        );
        expect(seriousOrCritical, name).toEqual([]);
      }
    });

    it("contains no em dashes or en dashes in any user-facing text", async () => {
      const user = userEvent.setup();
      const { container } = render(<SwitchboardView />);
      for (const name of ["Matrix", "Side by side", "Rules"]) {
        await user.click(screen.getByRole("tab", { name }));
        const textContent = container.textContent || "";
        // Unicode U+2014 is em dash, U+2013 is en dash
        expect(textContent).not.toContain("\u2014");
        expect(textContent).not.toContain("\u2013");
      }
    });
  });
});
