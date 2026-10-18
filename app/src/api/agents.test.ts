import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  agents_list,
  MOCK_AGENTS,
  isCoreAvailable,
  type AgentWithInstall,
} from "./agents";

describe("agents.ts client", () => {
  beforeEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
    delete (window as any).__TAURI__;
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
    delete (window as any).__TAURI__;
  });

  it("contains registry entries for all 21 builtins in MOCK_AGENTS", () => {
    expect(MOCK_AGENTS.length).toBe(21);

    const ids = MOCK_AGENTS.map((a) => a.id);
    const expected = [
      "aider",
      "amp",
      "antigravity-cli",
      "augment-auggie-cli",
      "claude-code",
      "cline",
      "codex-cli",
      "continue",
      "crush",
      "cursor-cli",
      "factory-droid",
      "gemini-cli",
      "github-copilot-cli",
      "goose",
      "hermes-agent-cli",
      "kilo-code",
      "kimi-code-cli",
      "opencode",
      "qoder-cli",
      "qwen-code",
      "roo-code",
    ];

    for (const exp of expected) {
      expect(ids).toContain(exp);
      const agent = MOCK_AGENTS.find((a) => a.id === exp)!;
      expect(agent.name).toBeTruthy();
      expect(agent.vendor).toBeTruthy();
      expect(agent.family).toBeTruthy();
      expect(agent.kind).toBeTruthy();
      expect(Array.isArray(agent.coverage)).toBe(true);
      expect(agent.docs_url).toMatch(/^https?:\/\//);
      expect(agent.homepage).toMatch(/^https?:\/\//);
    }
  });

  it("returns mock registry entries when core is absent (browser preview)", async () => {
    const list = await agents_list();
    expect(list.length).toBe(21);
    expect(list.map((a) => a.id)).toEqual(MOCK_AGENTS.map((a) => a.id));
  });

  it("detects when core is available vs absent", () => {
    expect(isCoreAvailable()).toBe(false);

    (window as any).__TAURI_INTERNALS__ = { invoke: vi.fn() };
    expect(isCoreAvailable()).toBe(true);
  });

  it("invokes Tauri agents_list command when core is present", async () => {
    const mockTauriAgents: AgentWithInstall[] = [
      {
        id: "claude-code",
        name: "Claude Code",
        vendor: "Anthropic",
        family: "anthropic",
        kind: "cli",
        installed: true,
        data_paths: ["/test/path"],
        coverage: ["detect", "history"],
        docs_url: "https://docs.anthropic.com",
      },
    ];

    const invokeMock = vi.fn().mockResolvedValue(mockTauriAgents);
    (window as any).__TAURI_INTERNALS__ = { invoke: invokeMock };

    const list = await agents_list();
    expect(invokeMock).toHaveBeenCalledWith("agents_list", {}, undefined);
    expect(list).toEqual(mockTauriAgents);
  });

  it("contains no em or en dashes in any mock agent data", () => {
    for (const a of MOCK_AGENTS) {
      expect(a.name).not.toMatch(/[\u2014\u2013]/);
      expect(a.vendor).not.toMatch(/[\u2014\u2013]/);
      expect(a.kind).not.toMatch(/[\u2014\u2013]/);
      if (a.version) expect(a.version).not.toMatch(/[\u2014\u2013]/);
      if (a.coverage) {
        for (const cov of a.coverage) {
          expect(cov).not.toMatch(/[\u2014\u2013]/);
        }
      }
    }
  });
});
