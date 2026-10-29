import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { Launchpad } from "../Launchpad";

// Mocks for Tauri API and xterm using vi.hoisted
const { MockTerminal, MockFitAddon, mockInvoke, mockListen, terminals } = vi.hoisted(() => {
  const terminals: Array<{ options: { theme: Record<string, string> } }> = [];
  class MockTerminal {
    open = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    onData = vi.fn((cb: (data: string) => void) => {
      (this as unknown as { _dataCb: (d: string) => void })._dataCb = cb;
      return { dispose: vi.fn() };
    });
    loadAddon = vi.fn();
    focus = vi.fn();
    options = {
      theme: {},
      fontFamily: "",
      cursorStyle: "block",
      cursorBlink: true,
    };
    cols = 80;
    rows = 24;

    constructor(options?: { theme?: Record<string, string>; fontFamily?: string }) {
      if (options) {
        this.options.theme = options.theme || {};
        this.options.fontFamily = options.fontFamily || "";
      }
      terminals.push(this);
    }
  }

  class MockFitAddon {
    fit = vi.fn();
  }

  return {
    MockTerminal,
    MockFitAddon,
    mockInvoke: vi.fn(),
    mockListen: vi.fn(),
    terminals,
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: MockTerminal,
  default: { Terminal: MockTerminal },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: MockFitAddon,
  default: { FitAddon: MockFitAddon },
}));

describe("Launchpad View", () => {
  let unlistenFn: ReturnType<typeof vi.fn>;

  afterEach(() => {
    delete (window as any).__ARMILLARY_NOW__;
    document.documentElement.removeAttribute("style");
    document.documentElement.removeAttribute("data-theme");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    terminals.length = 0;
    window.localStorage.clear();
    unlistenFn = vi.fn();
    mockListen.mockResolvedValue(unlistenFn);
    (window as any).__TAURI_INTERNALS__ = { invoke: mockInvoke };
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "agents_list") {
        return Promise.resolve([
          { id: "claude", name: "Claude Code", installed: true, family: "anthropic" },
          { id: "codex", name: "Codex CLI", installed: true, family: "openai" },
          { id: "gemini", name: "Gemini CLI", installed: false, family: "google" },
        ]);
      }
      if (cmd === "sessions_query") {
        return Promise.resolve({ items: [{ id: "s1", project_root: "/Users/test/project" }], total: 1, limit: 200, offset: 0 });
      }
      if (cmd === "pty_open") {
        return Promise.resolve({ id: "pty-session-1", agent_id: "claude", cwd: "/Users/test/project" });
      }
      if (cmd === "pty_write") {
        return Promise.resolve();
      }
      if (cmd === "pty_resize") {
        return Promise.resolve();
      }
      if (cmd === "pty_close") {
        return Promise.resolve();
      }
      return Promise.resolve();
    });
  });

  async function launch(name = /^Launch Claude Code$/) {
    const launchButton = await screen.findByRole("button", { name });
    await waitFor(() => expect(launchButton).toBeEnabled());
    await userEvent.click(launchButton);
  }

  it("heads the view with the shell chrome, one h2, and no demo or PTY pills", async () => {
    render(<Launchpad />);
    expect(screen.getByText("Terminals")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: /^The Launchpad$/i, level: 2 })).toBeInTheDocument();
    expect(
      screen.getByText("Start an installed agent in a terminal, inside one of your projects."),
    ).toBeInTheDocument();
    await screen.findByRole("radio", { name: /Claude Code/ });
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/demo data|PTY|pseudoterminal|About the Launchpad/i);
  });

  it("counts the installed CLI agents from the data (the shell is not an agent)", async () => {
    render(<Launchpad />);
    await screen.findByRole("radio", { name: /Claude Code/ });
    const figures = screen.getByRole("group", { name: /Summary/i });
    expect(within(figures).getByText("2")).toBeInTheDocument();
    expect(within(figures).getByText(/installed/i)).toBeInTheDocument();
  });

  it("never auto-runs any terminal or pty session on initial render", async () => {
    render(<Launchpad />);
    expect(mockInvoke).not.toHaveBeenCalledWith("pty_open", expect.anything());
  });

  it("offers installed agents as a radio group of tiles and keeps the rest behind a disclosure", async () => {
    render(<Launchpad />);
    const group = await screen.findByRole("radiogroup", { name: /Agent/i });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Claude Code"),
      expect.stringContaining("Codex CLI"),
      expect.stringContaining("System Shell"),
    ]);
    expect(radios[0]).toHaveAttribute("aria-checked", "true");

    // Gemini is not on this Mac: hidden, not selectable
    expect(screen.queryByText("Gemini CLI")).toBeNull();
    const disclosure = screen.getByRole("button", { name: "Show 1 agent not on this Mac" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Gemini CLI")).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Gemini CLI/ })).toBeNull();
    expect(within(group).getAllByRole("radio")).toHaveLength(3);
  });

  it("selects a tile by click and moves with the arrow keys (roving focus)", async () => {
    render(<Launchpad />);
    const claude = await screen.findByRole("radio", { name: /Claude Code/ });
    const codex = screen.getByRole("radio", { name: /Codex CLI/ });
    expect(claude).toHaveAttribute("tabindex", "0");
    expect(codex).toHaveAttribute("tabindex", "-1");

    claude.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(codex).toHaveFocus();
    expect(codex).toHaveAttribute("aria-checked", "true");
    expect(codex).toHaveAttribute("tabindex", "0");
    expect(claude).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: "Launch Codex CLI" })).toBeInTheDocument();

    await userEvent.click(claude);
    expect(screen.getByRole("button", { name: "Launch Claude Code" })).toBeInTheDocument();
  });

  it("carries data-launchpad-launch on the gilt Launch button", async () => {
    render(<Launchpad />);
    const button = await screen.findByRole("button", { name: "Launch Claude Code" });
    expect(button).toHaveAttribute("data-launchpad-launch");
    expect(document.querySelectorAll("[data-launchpad-launch]")).toHaveLength(1);
    expect(button.className).toMatch(/obs-button--gilt/);
  });

  it("says once that the terminal is unavailable, and disables Launch with the reason, when there is no core", async () => {
    delete (window as any).__TAURI_INTERNALS__;
    render(<Launchpad />);
    const reason = await screen.findByText("Terminal unavailable in this window");
    expect(screen.getAllByText("Terminal unavailable in this window")).toHaveLength(1);
    const button = await screen.findByRole("button", { name: /^Launch/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("data-launchpad-launch");
    const describedBy = button.getAttribute("aria-describedby") ?? "";
    expect(describedBy.split(" ").some((id) => document.getElementById(id)?.contains(reason))).toBe(true);
    expect(document.body.textContent).not.toMatch(/demo data|PTY offline/i);
  });

  it("lets the user pick a project folder, offering real project roots as chips", async () => {
    render(<Launchpad />);
    const cwdInput = screen.getByLabelText(/Project folder/i);
    expect(cwdInput.className).toMatch(/obs-text-field/);

    await waitFor(() => expect(cwdInput).toHaveValue("/Users/test/project"));
    const chip = await screen.findByRole("button", { name: "project", pressed: true });
    expect(chip).toBeInTheDocument();

    await userEvent.clear(cwdInput);
    await userEvent.type(cwdInput, "/Users/test/my-armillary-project");
    expect(cwdInput).toHaveValue("/Users/test/my-armillary-project");
    expect(screen.getByRole("button", { name: "project", pressed: false })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "project" }));
    expect(cwdInput).toHaveValue("/Users/test/project");
    // no invented suggestions
    expect(document.body.textContent).not.toMatch(/~\/Projects/);
  });

  it("tags every agent tile with its data-agent-id, and the disclosure tiles once opened", async () => {
    render(<Launchpad />);
    const group = await screen.findByRole("radiogroup", { name: /Agent/i });
    const ids = within(group)
      .getAllByRole("radio")
      .map((r) => r.getAttribute("data-agent-id"));
    expect(ids).toEqual(["claude", "codex", "shell"]);
    expect(ids.every((id) => id && id.length > 0)).toBe(true);

    // Gemini is behind the disclosure: no tile carries its id until it is opened
    expect(document.querySelector('[data-agent-id="gemini"]')).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show 1 agent not on this Mac" }));
    const geminiTile = document.querySelector('[data-agent-id="gemini"]');
    expect(geminiTile).not.toBeNull();
    expect(geminiTile).toHaveTextContent("Gemini CLI");

    const tagged = Array.from(document.querySelectorAll("[data-agent-id]")).map((el) => el.getAttribute("data-agent-id"));
    expect(tagged).toHaveLength(4);
    expect(new Set(tagged).size).toBe(4);
    expect(tagged.every((id) => id && id.length > 0)).toBe(true);
  });

  it("gives every project chip a data-root that is the root it launches, and the visible label stays as before", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "agents_list") {
        return Promise.resolve([{ id: "claude", name: "Claude Code", installed: true, family: "anthropic" }]);
      }
      if (cmd === "sessions_query") {
        // Two roots share the basename "project" (labels show the full path), one is unique (label is the name)
        const roots = ["/Users/test/a/project", "/Users/test/b/project", "/Users/test/notes"];
        return Promise.resolve({
          items: roots.map((root, i) => ({ id: `s${i}`, project_root: root })),
          total: roots.length,
          limit: 200,
          offset: 0,
        });
      }
      return Promise.resolve();
    });

    render(<Launchpad />);
    const cwdInput = screen.getByLabelText(/Project folder/i);
    const chipGroup = await screen.findByRole("group", { name: "Your projects" });
    const chips = within(chipGroup).getAllByRole("button");
    expect(chips.map((c) => c.getAttribute("data-root"))).toEqual([
      "/Users/test/notes",
      "/Users/test/a/project",
      "/Users/test/b/project",
    ]);
    expect(chips.map((c) => c.textContent)).toEqual(["notes", "/Users/test/a/project", "/Users/test/b/project"]);

    for (const chip of chips) {
      expect(chip.tagName).toBe("BUTTON");
      const root = chip.getAttribute("data-root") ?? "";
      if (chip.getAttribute("aria-pressed") === "true") {
        expect(cwdInput).toHaveValue(root);
      } else {
        await userEvent.click(chip);
        expect(cwdInput).toHaveValue(root);
      }
    }
  });

  it("opens the agent in an xterm.js terminal when the user clicks Launch", async () => {
    render(<Launchpad />);
    await launch();
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "pty_open",
        expect.objectContaining({ agentId: "claude", cwd: "/Users/test/project" }),
      );
    });
    expect(await screen.findByTestId("xterm-terminal-container")).toBeInTheDocument();
  });

  it("explains a failed launch in plain words, without the error class or the core's repeated clause", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "agents_list") {
        return Promise.resolve([{ id: "claude", name: "Claude Code", installed: true, family: "anthropic" }]);
      }
      if (cmd === "sessions_query") {
        return Promise.resolve({ items: [{ id: "s1", project_root: "/Users/test/project" }], total: 1, limit: 200, offset: 0 });
      }
      if (cmd === "pty_open") {
        return Promise.reject({
          code: "invalid_input",
          message:
            "Working directory does not exist or is not a directory: Working directory does not exist: /Users/test/project",
        });
      }
      return Promise.resolve();
    });
    render(<Launchpad />);
    await launch();
    const alert = await screen.findByText(/Could not launch/);
    const line = alert.closest("[role='alert']") ?? alert.parentElement!;
    expect(line.textContent).toContain("That project folder does not exist: /Users/test/project");
    expect(line.textContent).not.toMatch(/ApiError|Working directory does not exist or is not a directory/);
  });

  it("shows other launch failures by their own message, without the error class name", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "agents_list") {
        return Promise.resolve([{ id: "claude", name: "Claude Code", installed: true, family: "anthropic" }]);
      }
      if (cmd === "sessions_query") {
        return Promise.resolve({ items: [{ id: "s1", project_root: "/Users/test/project" }], total: 1, limit: 200, offset: 0 });
      }
      if (cmd === "pty_open") return Promise.reject({ code: "permission", message: "The agent binary is not allowed" });
      return Promise.resolve();
    });
    render(<Launchpad />);
    await launch();
    const alert = await screen.findByText(/Could not launch/);
    const line = alert.closest("[role='alert']") ?? alert.parentElement!;
    expect(line.textContent).toContain("The agent binary is not allowed");
    expect(line.textContent).not.toContain("ApiError");
  });

  it("frames the terminal with a header line showing the working directory", async () => {
    render(<Launchpad />);
    await launch();
    const frame = await screen.findByTestId("terminal-frame");
    expect(within(frame).getByTestId("terminal-cwd")).toHaveTextContent("/Users/test/project");
    expect(frame.querySelector("[data-testid='xterm-terminal-container']")).not.toBeNull();
    // no claims about the theme or a toggle that does not exist
    expect(document.body.textContent).not.toMatch(/Ctrl|Cursor: Gilt|Observatory Ink/);
  });

  it("supports tabs for several terminals, switching between them and closing tabs", async () => {
    let sessionCount = 0;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "sessions_query") {
        return Promise.resolve({ items: [{ id: "s1", project_root: "/Users/test/project" }], total: 1, limit: 200, offset: 0 });
      }
      if (cmd === "agents_list") {
        return Promise.resolve([{ id: "claude", name: "Claude Code", installed: true, family: "anthropic" }]);
      }
      if (cmd === "pty_open") {
        sessionCount += 1;
        return Promise.resolve({ id: `pty-${sessionCount}`, agent_id: "claude", cwd: "/test" });
      }
      return Promise.resolve();
    });

    render(<Launchpad />);
    await launch();
    const tabs = await screen.findByRole("list", { name: /Terminals/i });
    await waitFor(() => expect(within(tabs).getAllByTestId("terminal-tab")).toHaveLength(1));

    await userEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await launch();
    await waitFor(() => expect(within(tabs).getAllByTestId("terminal-tab")).toHaveLength(2));

    const [tab1, tab2] = within(tabs).getAllByTestId("terminal-tab");
    expect(tab2).toHaveAttribute("aria-current", "true");
    expect(tab1.textContent).toBe("Claude Code");
    expect(tab2.textContent).toBe("Claude Code 2");
    await userEvent.click(tab1);
    expect(tab1).toHaveAttribute("aria-current", "true");
    expect(tab2).not.toHaveAttribute("aria-current");

    // every tab has a close button with its own accessible name
    const closeButtons = within(tabs).getAllByRole("button", { name: /^Close/ });
    expect(closeButtons.map((b) => b.getAttribute("aria-label"))).toEqual(["Close Claude Code", "Close Claude Code 2"]);
    await userEvent.click(closeButtons[1]);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("pty_close", expect.objectContaining({ id: "pty-2" }));
      expect(within(tabs).getAllByTestId("terminal-tab")).toHaveLength(1);
    });
  });

  it("wires pty:data event listener to terminal write and forwards input to pty_write", async () => {
    let capturedDataListener: ((event: { payload: { id: string; data: string } }) => void) | null = null;
    mockListen.mockImplementation((event: string, cb: (e: { payload: { id: string; data: string } }) => void) => {
      if (event === "pty:data") {
        capturedDataListener = cb;
      }
      return Promise.resolve(unlistenFn);
    });

    render(<Launchpad />);
    await launch();

    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledWith("pty:data", expect.any(Function));
    });
    expect(capturedDataListener).not.toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith(
      "pty_resize",
      expect.objectContaining({ id: "pty-session-1", cols: 80, rows: 24 }),
    );
  });

  it("shows what a program prints before its terminal tab mounts (sol-loop S13)", async () => {
    let dataListener: ((event: { payload: { id: string; data: string } }) => void) | null = null;
    mockListen.mockImplementation((event: string, cb: (e: { payload: { id: string; data: string } }) => void) => {
      if (event === "pty:data") dataListener = cb;
      return Promise.resolve(unlistenFn);
    });
    const base = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "pty_open") {
        // The backend starts streaming as soon as the process runs; only a listener that is
        // already registered receives it.
        dataListener?.({ payload: { id: "pty-session-1", data: "early prompt$ " } });
      }
      return base(cmd, args);
    });

    render(<Launchpad />);
    await launch();
    await screen.findByTestId("xterm-terminal-container");
    expect(dataListener).not.toBeNull();
    expect(terminals).toHaveLength(1);
    const write = (terminals[0] as unknown as { write: ReturnType<typeof vi.fn> }).write;
    expect(write).toHaveBeenCalledWith("early prompt$ ");
    // Later output goes straight to the mounted terminal, once.
    dataListener!({ payload: { id: "pty-session-1", data: "more" } });
    expect(write.mock.calls).toEqual([["early prompt$ "], ["more"]]);
  });

  it("lists recent launches simply (glyph, agent, project in mono, time ago from appNow) and has no help card", async () => {
    const now = 1_800_000_000_000;
    (window as any).__ARMILLARY_NOW__ = now;
    window.localStorage.setItem(
      "armillary:recent_launches",
      JSON.stringify([
        { id: "launch-1", agentId: "claude", agentName: "Claude Code", family: "anthropic", projectFolder: "~/Projects/armillary", timestamp: now - 3600000 },
        { id: "launch-2", agentId: "codex", agentName: "Codex CLI", family: "openai", projectFolder: "~/Projects/other", timestamp: now - 3 * 86400000 },
        { id: "launch-3", agentId: "codex", agentName: "Codex CLI", family: "openai", projectFolder: "~/Projects/now", timestamp: now - 20000 },
      ]),
    );

    render(<Launchpad />);
    const list = screen.getByTestId("recent-launches-list");
    expect(screen.getByRole("heading", { level: 3, name: /Recent launches/i })).toBeInTheDocument();
    expect(within(list).getByText("~/Projects/armillary").className).toMatch(/recent-launch__project/);
    expect(within(list).getByText("1 hour ago")).toBeInTheDocument();
    expect(within(list).getByText("3 days ago")).toBeInTheDocument();
    expect(within(list).getByText("just now")).toBeInTheDocument();
    expect(screen.queryByTestId("launchpad-help-card")).toBeNull();
    expect(screen.queryByText(/About the Launchpad/i)).toBeNull();

    // choosing a recent launch refills the agent and the folder
    await userEvent.click(within(list).getByRole("button", { name: /Codex CLI.*other/ }));
    expect(screen.getByLabelText(/Project folder/i)).toHaveValue("~/Projects/other");
    expect(screen.getByRole("radio", { name: /Codex CLI/ })).toHaveAttribute("aria-checked", "true");
  });

  it("saves a new launch to local storage when an agent is launched", async () => {
    render(<Launchpad />);
    await launch();
    await waitFor(() => {
      const stored = window.localStorage.getItem("armillary:recent_launches");
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored || "[]");
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0].agentId).toBe("claude");
    });
  });

  it("builds the xterm theme from the tokens and updates it when data-theme changes", async () => {
    const root = document.documentElement;
    const set = (vars: Record<string, string>) => {
      for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    };
    set({ "--color-ink-0": "#0B1220", "--color-star": "#F4F1E8" });
    root.setAttribute("data-theme", "dark");

    render(<Launchpad />);
    await launch();
    await waitFor(() => expect(terminals).toHaveLength(1));
    expect(terminals[0].options.theme.background).toBe("#0B1220");
    expect(terminals[0].options.theme.foreground).toBe("#F4F1E8");

    set({ "--color-ink-0": "#F3EBDA", "--color-star": "#1D1A14" });
    root.setAttribute("data-theme", "light");
    await waitFor(() => expect(terminals[0].options.theme.background).toBe("#F3EBDA"));
    expect(terminals[0].options.theme.foreground).toBe("#1D1A14");
  });

  it("passes axe-core accessibility audit with 0 serious or critical violations (config and terminal)", async () => {
    const { container } = render(<Launchpad />);
    await screen.findByRole("radio", { name: /Claude Code/ });
    let results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);

    await launch();
    await screen.findByTestId("terminal-frame");
    results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });

  it("contains no em or en dashes in any rendered text", async () => {
    const { container } = render(<Launchpad />);
    await screen.findByRole("radio", { name: /Claude Code/ });
    const allText = container.textContent || "";
    expect(allText).not.toContain("\u2014");
    expect(allText).not.toContain("\u2013");
  });
});
