import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { FieldGuideView, AgentModel } from "./index";

const MOCK_AGENTS: AgentModel[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    vendor: "Anthropic",
    family: "anthropic",
    kind: "cli",
    installed: true,
    version: "v1.0.12",
    data_paths: ["/Users/test/.claude/projects/"],
    default_data_paths: ["~/.claude/projects/"],
    coverage: ["detect", "history", "live", "config"],
    docs_url: "https://docs.anthropic.com/en/docs/agents-and-tools/claude-code",
  },
  {
    id: "codex-cli",
    name: "OpenAI Codex CLI",
    vendor: "OpenAI",
    family: "openai",
    kind: "cli",
    installed: false,
    version: null,
    data_paths: [],
    default_data_paths: ["~/.codex/sessions/"],
    coverage: ["detect", "history", "live", "config"],
    docs_url: "https://github.com/openai/codex",
  },
  {
    id: "cursor",
    name: "Cursor",
    vendor: "Anysphere",
    family: "cursor",
    kind: "ide",
    installed: true,
    version: "0.42.0",
    data_paths: ["/Users/test/Library/Application Support/Cursor/"],
    default_data_paths: ["~/Library/Application Support/Cursor/"],
    coverage: ["detect", "history", "config"],
    docs_url: "https://docs.cursor.com",
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    vendor: "Anthropic",
    family: "anthropic",
    kind: "desktop",
    installed: false,
    version: null,
    data_paths: [],
    default_data_paths: ["~/Library/Application Support/Claude/"],
    coverage: ["detect", "config"],
    docs_url: "https://claude.ai/download",
  },
  {
    id: "gemini-preview",
    name: "Google Antigravity Command Line Interface Preview Edition",
    vendor: "Google",
    family: "google",
    kind: "cli",
    installed: false,
    version: null,
    data_paths: [],
    default_data_paths: ["~/.gemini/antigravity/conversations"],
    coverage: ["detect"],
    docs_url: null,
    detection_note: "found on PATH but not counted: not a known install location",
  },
];

describe("Field Guide View (Acceptance Criteria)", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  it("renders illustrated entries with glyph, name, vendor, kind, coverage badges, install state, data locations, docs link", () => {
    render(<FieldGuideView initialAgents={MOCK_AGENTS} />);

    // Check title and description
    expect(screen.getByRole("heading", { name: /Field Guide/i, level: 2 })).toBeInTheDocument();

    // Check illustrated entries
    for (const agent of MOCK_AGENTS) {
      const card = screen.getByTestId(`agent-card-${agent.id}`);
      expect(card).toBeInTheDocument();

      // Name & Vendor
      expect(within(card).getByText(agent.name)).toBeInTheDocument();
      expect(within(card).getByText(agent.vendor)).toBeInTheDocument();

      // Family glyph
      expect(card.querySelector(`.obs-glyph--${agent.family}`)).toBeTruthy();

      // Coverage scale (four steps, one text equivalent)
      expect(within(card).getByTestId(`coverage-${agent.id}`)).toBeInTheDocument();

      // Installed state
      if (agent.installed) {
        expect(within(card).getByText(/Installed/i)).toBeInTheDocument();
        if (agent.version) {
          expect(within(card).getByText(agent.version)).toBeInTheDocument();
        }
      } else {
        expect(within(card).getByText("Not on this Mac")).toBeInTheDocument();
      }

      // Data location
      const expectedPath = agent.installed
        ? agent.data_paths?.[0]
        : agent.default_data_paths?.[0];
      if (expectedPath) {
        expect(within(card).getByText(new RegExp(expectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"))).toBeInTheDocument();
      }

      // Docs link
      if (agent.docs_url) {
        const link = within(card).getByRole("link", { name: /Docs/i });
        expect(link).toHaveAttribute("href", agent.docs_url);
        expect(link).toHaveTextContent(/^Docs$/);
      } else {
        expect(within(card).queryByRole("link")).not.toBeInTheDocument();
      }
    }
  });

  it("groups entries by kind with section headings and counts", () => {
    render(<FieldGuideView initialAgents={MOCK_AGENTS} />);

    // Expect groups for CLI, IDE, Desktop
    expect(screen.getByRole("heading", { name: /Terminal CLIs|CLI Agents|Command-Line/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /IDE Agents|Editor/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Desktop Apps|Desktop Agents/i })).toBeInTheDocument();
  });

  it("filters agents using search input by name, vendor, or path", async () => {
    render(<FieldGuideView initialAgents={MOCK_AGENTS} />);

    const searchInput = screen.getByRole("searchbox", { name: /Filter agents/i });
    expect(searchInput).toBeInTheDocument();

    // Type "Cursor"
    await userEvent.type(searchInput, "Cursor");

    expect(screen.getByTestId("agent-card-cursor")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-card-claude-code")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-card-codex-cli")).not.toBeInTheDocument();

    // Clear search
    await userEvent.clear(searchInput);
    expect(screen.getByTestId("agent-card-claude-code")).toBeInTheDocument();
  });

  it("filters agents using the Installed chip", async () => {
    render(<FieldGuideView initialAgents={MOCK_AGENTS} />);

    const installedFilter = screen.getByRole("button", { name: /^Installed/ });
    expect(installedFilter).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(installedFilter);
    expect(installedFilter).toHaveAttribute("aria-pressed", "true");

    // Only installed agents visible
    expect(screen.getByTestId("agent-card-claude-code")).toBeInTheDocument();
    expect(screen.getByTestId("agent-card-cursor")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-card-codex-cli")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-card-claude-desktop")).not.toBeInTheDocument();

    // Toggle off
    await userEvent.click(installedFilter);
    expect(screen.getByTestId("agent-card-codex-cli")).toBeInTheDocument();
  });

  it("filters agents by family filter", async () => {
    render(<FieldGuideView initialAgents={MOCK_AGENTS} />);

    const familySelect = screen.getByRole("combobox", { name: "Family" });
    await userEvent.selectOptions(familySelect, "openai");

    expect(screen.getByTestId("agent-card-codex-cli")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-card-claude-code")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-card-cursor")).not.toBeInTheDocument();
  });

  it("filters agents by kind with chips that carry real counts", async () => {
    render(<FieldGuideView initialAgents={MOCK_AGENTS} />);

    // Counts come from the data: 3 CLI, 1 desktop, 1 IDE
    const cli = screen.getByRole("button", { name: /^CLI/ });
    const ide = screen.getByRole("button", { name: /^IDE/ });
    const desktop = screen.getByRole("button", { name: /^Desktop/ });
    expect(cli).toHaveTextContent(/CLI\s*3/);
    expect(ide).toHaveTextContent(/IDE\s*1/);
    expect(desktop).toHaveTextContent(/Desktop\s*1/);
    // No kind exists in the data for these, so no chip is invented
    expect(screen.queryByRole("button", { name: /^Cloud/ })).not.toBeInTheDocument();

    await userEvent.click(ide);
    expect(ide).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("agent-card-cursor")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-card-claude-code")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-card-claude-desktop")).not.toBeInTheDocument();

    // Selecting another kind replaces the choice, selecting it again clears it
    await userEvent.click(desktop);
    expect(ide).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("agent-card-claude-desktop")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-card-cursor")).not.toBeInTheDocument();
    await userEvent.click(desktop);
    expect(screen.getByTestId("agent-card-claude-code")).toBeInTheDocument();
  });

  it("combines the kind and Installed chips, and chip counts follow the other filters", async () => {
    render(<FieldGuideView initialAgents={MOCK_AGENTS} />);

    await userEvent.click(screen.getByRole("button", { name: /^Installed/ }));
    // Installed agents: claude-code (cli), cursor (ide)
    expect(screen.getByRole("button", { name: /^CLI/ })).toHaveTextContent(/CLI\s*1/);
    expect(screen.getByRole("button", { name: /^IDE/ })).toHaveTextContent(/IDE\s*1/);

    await userEvent.click(screen.getByRole("button", { name: /^CLI/ }));
    expect(screen.getByTestId("agent-card-claude-code")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-card-cursor")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-card-codex-cli")).not.toBeInTheDocument();
  });

  it("the head shows the registry size and installed count from the data, with no pills", () => {
    render(<FieldGuideView initialAgents={MOCK_AGENTS} />);
    const figures = screen.getByRole("group", { name: "Registry summary" });
    expect(figures).toHaveTextContent(/5\s*agents/);
    expect(figures).toHaveTextContent(/2\s*installed/);
    expect(screen.getByText("Agents", { selector: ".view-eyebrow" })).toBeInTheDocument();
    expect(screen.queryByText(/Total Agents/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\(Demo\)/)).not.toBeInTheDocument();
  });

  it("section titles carry the real count of entries in that section", async () => {
    render(<FieldGuideView initialAgents={MOCK_AGENTS} />);

    expect(screen.getByRole("heading", { level: 3, name: /Terminal CLIs/ })).toHaveTextContent(/Terminal CLIs\s*3/);
    expect(screen.getByRole("heading", { level: 3, name: /IDE Agents/ })).toHaveTextContent(/IDE Agents\s*1/);
    expect(screen.getByRole("heading", { level: 3, name: /Desktop Apps/ })).toHaveTextContent(/Desktop Apps\s*1/);

    // The counts follow the filters, they are never a fixed number
    await userEvent.click(screen.getByRole("button", { name: /^Installed/ }));
    expect(screen.getByRole("heading", { level: 3, name: /Terminal CLIs/ })).toHaveTextContent(/Terminal CLIs\s*1/);
    expect(screen.queryByRole("heading", { level: 3, name: /Desktop Apps/ })).not.toBeInTheDocument();
  });

  it("never truncates a name: the full name is in the page and no name rule uses an ellipsis or nowrap", () => {
    render(<FieldGuideView initialAgents={MOCK_AGENTS} />);
    const longName = "Google Antigravity Command Line Interface Preview Edition";
    const card = screen.getByTestId("agent-card-gemini-preview");
    expect(within(card).getByRole("heading", { level: 4 })).toHaveTextContent(longName);

    const css = readFileSync(path.resolve(__dirname, "./FieldGuide.css"), "utf8");
    expect(css).not.toMatch(/text-overflow:\s*ellipsis/);
    const nameRule = css.match(/\.fg-entry__name\s*\{[^}]*\}/);
    expect(nameRule).not.toBeNull();
    expect(nameRule![0]).not.toMatch(/nowrap|overflow:\s*hidden/);
  });

  it("describes the coverage scale in words for screen readers", () => {
    render(<FieldGuideView initialAgents={MOCK_AGENTS} />);

    const partial = within(screen.getByTestId("agent-card-cursor")).getByTestId("coverage-cursor");
    expect(partial).toHaveTextContent("Coverage: detect, history, config; not live");
    const full = screen.getByTestId("coverage-claude-code");
    expect(full).toHaveTextContent("Coverage: detect, history, live, config");
    expect(full).not.toHaveTextContent(/not /);
    const minimal = screen.getByTestId("coverage-gemini-preview");
    expect(minimal).toHaveTextContent("Coverage: detect; not history, not live, not config");

    // The four labelled steps are present and hidden from assistive tech (the sentence replaces them)
    const steps = partial.querySelectorAll("[data-step]");
    expect(Array.from(steps).map((n) => n.getAttribute("data-step"))).toEqual(["detect", "history", "live", "config"]);
    expect(Array.from(steps).map((n) => n.getAttribute("data-supported"))).toEqual(["true", "true", "false", "true"]);
    expect(partial.querySelector("[aria-hidden='true'] [data-step]")).not.toBeNull();
  });

  it("shows detection_note in the entry when the core supplies one, and only then", () => {
    render(<FieldGuideView initialAgents={MOCK_AGENTS} />);
    const note = "found on PATH but not counted: not a known install location";
    const card = screen.getByTestId("agent-card-gemini-preview");
    expect(within(card).getByText(note)).toBeInTheDocument();
    expect(within(screen.getByTestId("agent-card-cursor")).queryByText(/not counted/)).not.toBeInTheDocument();
  });

  it("entries are plain list items: no invalid role on an article", () => {
    render(<FieldGuideView initialAgents={MOCK_AGENTS} />);
    const card = screen.getByTestId("agent-card-cursor");
    expect(card.tagName).toBe("LI");
    expect(card).not.toHaveAttribute("role");
    expect(document.querySelector("article[role]")).toBeNull();
    expect(card.parentElement?.tagName).toBe("UL");
  });

  it("button names contain their visible text (label-content-name-mismatch)", () => {
    delete (window as any).__TAURI_INTERNALS__;
    delete (window as any).__TAURI__;
    render(<FieldGuideView initialAgents={MOCK_AGENTS} />);
    for (const btn of screen.getAllByRole("button")) {
      const visible = (btn.textContent ?? "").trim().toLowerCase();
      const name = (btn.getAttribute("aria-label") ?? btn.textContent ?? "").trim().toLowerCase();
      if (btn.hasAttribute("aria-label")) expect(name).toContain(visible.replace(/\s*\d+$/, ""));
    }
    expect(screen.getByRole("button", { name: /Import now/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Scan now/i })).toBeInTheDocument();
  });

  it("the quick filter shows the / shortcut and '/' focuses it", async () => {
    const { container } = render(<FieldGuideView initialAgents={MOCK_AGENTS} />);
    const input = screen.getByRole("searchbox", { name: /Filter agents/i });
    expect(container.querySelector("kbd")).toHaveTextContent("/");
    expect(document.activeElement).not.toBe(input);
    await userEvent.keyboard("/");
    expect(document.activeElement).toBe(input);
    // typing a slash while in the field is just text
    await userEvent.keyboard("/");
    expect(input).toHaveValue("/");
  });

  it("an entry's docs link opens once on Enter from the link (the card handler ignores bubbled keys)", async () => {
    const opened: string[] = [];
    const real = window.open;
    window.open = ((url: string) => {
      opened.push(url);
      return null;
    }) as typeof window.open;
    try {
      render(<FieldGuideView initialAgents={MOCK_AGENTS} />);
      const card = screen.getByTestId("agent-card-cursor");
      card.focus();
      await userEvent.keyboard("{Enter}");
      expect(opened).toEqual(["https://docs.cursor.com"]);
      opened.length = 0;
      within(card).getByRole("link", { name: /Docs/ }).focus();
      await userEvent.keyboard("{Enter}");
      expect(opened).toEqual([]);
    } finally {
      window.open = real;
    }
  });

  it("supports keyboard navigation between agent cards", async () => {
    render(<FieldGuideView initialAgents={MOCK_AGENTS} />);

    const firstCard = screen.getByTestId("agent-card-claude-code");
    firstCard.focus();
    expect(document.activeElement).toBe(firstCard);

    // Arrow down moves focus to next card
    await userEvent.keyboard("{ArrowDown}");
    const secondCard = screen.getByTestId("agent-card-codex-cli");
    expect(document.activeElement).toBe(secondCard);

    // Arrow up moves focus back
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(firstCard);
  });

  it("renders correctly in both dark and light themes", () => {
    const { container, rerender } = render(<FieldGuideView initialAgents={MOCK_AGENTS} />);
    document.documentElement.setAttribute("data-theme", "dark");
    expect(container.querySelector(".field-guide")).toBeInTheDocument();

    document.documentElement.setAttribute("data-theme", "light");
    rerender(<FieldGuideView initialAgents={MOCK_AGENTS} />);
    expect(container.querySelector(".field-guide")).toBeInTheDocument();
  });

  it("passes axe-core audit with 0 serious or critical accessibility issues", async () => {
    const { container } = render(<FieldGuideView initialAgents={MOCK_AGENTS} />);

    // Run axe-core
    const results = await axe.run(container, {
      rules: {
        // In jsdom without real canvas layout, color-contrast can't be computed accurately
        "color-contrast": { enabled: false },
      },
    });

    const seriousOrCritical = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical"
    );

    if (seriousOrCritical.length > 0) {
      console.error("Accessibility violations:", seriousOrCritical);
    }
    expect(seriousOrCritical.length).toBe(0);
  });

  it("contains no em or en dashes in user-facing text", () => {
    const { container } = render(<FieldGuideView initialAgents={MOCK_AGENTS} />);
    const textContent = container.textContent || "";

    expect(textContent.includes("\u2014")).toBe(false);
    expect(textContent.includes("\u2013")).toBe(false);
  });

  it("renders all registry entries from agents.ts when no initialAgents are provided", async () => {
    delete (window as any).__TAURI_INTERNALS__;
    delete (window as any).__TAURI__;

    render(<FieldGuideView />);

    // Should fetch and render all 21 registry entries from agents.ts
    const cards = await screen.findAllByTestId(/^agent-card-/);
    expect(cards.length).toBe(21);
  });

  it("shows one neutral Demo data mark in the header only when running without the core", async () => {
    delete (window as any).__TAURI_INTERNALS__;
    delete (window as any).__TAURI__;

    const { unmount } = render(<FieldGuideView />);

    // Without core: exactly one Demo data mark in the header
    expect(screen.getAllByText("Demo data")).toHaveLength(1);
    unmount();

    // With core: Demo data badge must NOT be present
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async () => [
        {
          id: "claude-code",
          name: "Claude Code",
          vendor: "Anthropic",
          family: "anthropic",
          kind: "cli",
          installed: true,
          data_paths: [],
          coverage: ["detect"],
        },
      ],
    };

    render(<FieldGuideView />);
    await screen.findByText("Claude Code");
    expect(screen.queryByText("Demo data")).not.toBeInTheDocument();

    delete (window as any).__TAURI_INTERNALS__;
  });

  it("renders Import now button and triggers import_now invoke when core is available", async () => {
    let invokedCommand: string | null = null;
    let invokedPayload: any = null;

    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: any) => {
        if (cmd === "agents_list") {
          return [
            {
              id: "claude-code",
              name: "Claude Code",
              vendor: "Anthropic",
              family: "anthropic",
              kind: "cli",
              installed: true,
              data_paths: ["/mock/path"],
              coverage: ["detect", "history"],
            },
          ];
        }
        if (cmd === "import_now") {
          invokedCommand = cmd;
          invokedPayload = args;
          return {
            imported_count: 5,
            message_count: 50,
            failures: [],
          };
        }
        return null;
      },
    };

    render(<FieldGuideView />);

    const importBtn = await screen.findByTestId("import-now-button");
    expect(importBtn).toBeInTheDocument();
    expect(importBtn).not.toBeDisabled();
    expect(importBtn).toHaveTextContent("Import now");

    await userEvent.click(importBtn);

    expect(invokedCommand).toBe("import_now");
    expect(invokedPayload).toEqual({ agentId: null });

    delete (window as any).__TAURI_INTERNALS__;
  });

  it("disables Import now button when core is not available", () => {
    delete (window as any).__TAURI_INTERNALS__;
    delete (window as any).__TAURI__;

    render(<FieldGuideView initialAgents={MOCK_AGENTS} />);

    const importBtn = screen.getByTestId("import-now-button");
    expect(importBtn).toBeInTheDocument();
    expect(importBtn).toBeDisabled();
    expect(importBtn).toHaveAttribute(
      "title",
      "Import unavailable without core backend"
    );
  });
});

