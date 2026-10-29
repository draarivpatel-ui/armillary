import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App";

// sol-loop S12: leaving the Launchpad for another view must not tear down its terminals. The
// running agent keeps its PTY either way; the screen it drew (xterm) has to survive too.
const { MockTerminal, MockFitAddon, mockInvoke, mockListen, terminals } = vi.hoisted(() => {
  const terminals: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
  class MockTerminal {
    open = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    loadAddon = vi.fn();
    focus = vi.fn();
    options = { theme: {}, fontFamily: "", cursorStyle: "block", cursorBlink: true };
    cols = 80;
    rows = 24;
    constructor() {
      terminals.push(this);
    }
  }
  class MockFitAddon {
    fit = vi.fn();
  }
  return { MockTerminal, MockFitAddon, mockInvoke: vi.fn(), mockListen: vi.fn(), terminals };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...args: unknown[]) => mockListen(...args) }));
vi.mock("@xterm/xterm", () => ({ Terminal: MockTerminal, default: { Terminal: MockTerminal } }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: MockFitAddon, default: { FitAddon: MockFitAddon } }));

describe("Launchpad terminals across navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminals.length = 0;
    window.localStorage.clear();
    mockListen.mockResolvedValue(vi.fn());
    (window as any).__TAURI_INTERNALS__ = { invoke: mockInvoke };
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "agents_list") {
        return Promise.resolve([{ id: "claude", name: "Claude Code", installed: true, family: "anthropic" }]);
      }
      if (cmd === "sessions_query") return Promise.resolve({ items: [{ id: "s1", project_root: "/Users/test/project" }], total: 1, limit: 200, offset: 0 });
      if (cmd === "pty_open") return Promise.resolve({ id: "pty-session-1", agent_id: "claude", cwd: "/p" });
      return Promise.resolve();
    });
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it("keeps a running terminal mounted, hidden, while another view is open", async () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Observatory Views" });
    await userEvent.click(within(nav).getByRole("button", { name: /Launchpad/ }));
    const launch = await screen.findByRole("button", { name: /^Launch Claude Code$/ });
    await waitFor(() => expect(launch).toBeEnabled());
    await userEvent.click(launch);
    const terminal = await screen.findByTestId("xterm-terminal-container");
    expect(terminals).toHaveLength(1);

    await userEvent.click(within(nav).getByRole("button", { name: /Search/ }));
    await waitFor(() => expect(document.querySelectorAll('[data-view="launchpad"]')).toHaveLength(1));
    const kept = document.querySelector<HTMLElement>('[data-view="launchpad"]')!;
    expect(kept.style.display).toBe("none");
    expect(kept).toHaveAttribute("aria-hidden", "true");
    expect(kept.contains(terminal)).toBe(true);
    expect(terminals[0].dispose).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalledWith("pty_close", expect.anything());

    await userEvent.click(within(nav).getByRole("button", { name: /Launchpad/ }));
    expect(screen.getByTestId("xterm-terminal-container")).toBe(terminal);
    expect(terminals).toHaveLength(1);
    expect(document.querySelectorAll('[data-view="launchpad"]')).toHaveLength(1);
  });
});
