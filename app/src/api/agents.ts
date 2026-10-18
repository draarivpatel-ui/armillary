/**
 * Agents API Client for Armillary / Orrery
 *
 * Single source of truth typed client for the agents_list command.
 * Used everywhere an agent list is needed (Field Guide, Launchpad, Almanac, Search).
 *
 * Provides a canonical mock of all 21 builtin adapters for tests and browser previews
 * when the Tauri core is absent.
 *
 * Note: No em or en dashes in any user-facing text.
 */

import type { Agent, Install } from "@armillary/model";
import { call, isCoreAvailable as coreAvailable } from "./client";

export type { Agent, Install };

export type AgentFamily =
  | "anthropic"
  | "openai"
  | "google"
  | "github-microsoft"
  | "cursor"
  | "open-source-clis"
  | "chinese-labs"
  | "other"
  | string;

export type AgentWithInstall = Agent & {
  installed?: boolean;
  version?: string | null;
  data_paths?: string[];
  default_data_paths?: string[];
  coverage?: string[];
  docs_url?: string | null;
  homepage?: string | null;
  /** Why a generic PATH hit was not counted as an install (set by the core when it applies). */
  detection_note?: string | null;
};

/** True when a core answers commands (see ./client). */
export { isCoreAvailable } from "./client";

/**
 * Single canonical mock agent catalogue for tests and browser previews.
 * Contains all 21 builtins matching the crates/adapters builtins specifications.
 */
export const MOCK_AGENTS: AgentWithInstall[] = [
  {
    id: "aider",
    name: "Aider",
    vendor: "Paul Gauthier",
    family: "open-source-clis",
    kind: "cli",
    installed: true,
    version: "v0.86.2",
    data_paths: ["~/.aider.chat.history.md"],
    default_data_paths: ["~/.aider.chat.history.md"],
    coverage: ["detect", "history"],
    docs_url: "https://aider.chat/docs/",
    homepage: "https://aider.chat",
  },
  {
    id: "amp",
    name: "Amp",
    vendor: "Amp Inc.",
    family: "open-source-clis",
    kind: "cli",
    installed: false,
    version: null,
    data_paths: [],
    default_data_paths: ["~/.amp/threads"],
    coverage: ["detect"],
    docs_url: "https://ampcode.com/manual",
    homepage: "https://ampcode.com",
  },
  {
    id: "antigravity-cli",
    name: "Google Antigravity CLI",
    vendor: "Google",
    family: "google",
    kind: "cli",
    installed: true,
    version: "v1.2.0",
    data_paths: ["~/.gemini/antigravity/conversations"],
    default_data_paths: ["~/.gemini/antigravity/conversations"],
    coverage: ["detect", "history", "live", "config"],
    docs_url: "https://antigravity.google/docs/home/",
    homepage: "https://antigravity.google/",
  },
  {
    id: "augment-auggie-cli",
    name: "Augment Auggie CLI",
    vendor: "Augment Code",
    family: "other",
    kind: "cli",
    installed: false,
    version: null,
    data_paths: [],
    default_data_paths: ["~/.augment/chats"],
    coverage: ["detect", "history"],
    docs_url: "https://docs.augmentcode.com",
    homepage: "https://www.augmentcode.com",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    vendor: "Anthropic",
    family: "anthropic",
    kind: "cli",
    installed: true,
    version: "v1.0.12",
    data_paths: ["~/.claude/projects/"],
    default_data_paths: ["~/.claude/projects/"],
    coverage: ["detect", "history", "live", "config"],
    docs_url: "https://docs.anthropic.com/en/docs/agents-and-tools/claude-code",
    homepage: "https://code.claude.com",
  },
  {
    id: "cline",
    name: "Cline",
    vendor: "Cline Bot Inc.",
    family: "other",
    kind: "ide",
    installed: true,
    version: "v3.2.0",
    data_paths: ["~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev"],
    default_data_paths: ["~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev"],
    coverage: ["detect", "history"],
    docs_url: "https://docs.cline.bot",
    homepage: "https://cline.bot",
  },
  {
    id: "codex-cli",
    name: "OpenAI Codex CLI",
    vendor: "OpenAI",
    family: "openai",
    kind: "cli",
    installed: true,
    version: "v0.9.4",
    data_paths: ["~/.codex/sessions/"],
    default_data_paths: ["~/.codex/sessions/"],
    coverage: ["detect", "history", "live", "config"],
    docs_url: "https://github.com/openai/codex",
    homepage: "https://chatgpt.com/codex",
  },
  {
    id: "continue",
    name: "Continue",
    vendor: "Continue Dev, Inc.",
    family: "other",
    kind: "ide",
    installed: false,
    version: null,
    data_paths: [],
    default_data_paths: ["~/.continue/sessions"],
    coverage: ["detect", "history", "config"],
    docs_url: "https://docs.continue.dev",
    homepage: "https://continue.dev",
  },
  {
    id: "crush",
    name: "Crush",
    vendor: "Charm",
    family: "open-source-clis",
    kind: "cli",
    installed: false,
    version: null,
    data_paths: [],
    default_data_paths: [".crush/crush.db"],
    coverage: ["detect"],
    docs_url: "https://github.com/charmbracelet/crush",
    homepage: "https://charm.land/crush",
  },
  {
    id: "cursor-cli",
    name: "Cursor CLI",
    vendor: "Anysphere",
    family: "cursor",
    kind: "cli",
    installed: true,
    version: "0.42.0",
    data_paths: ["~/.cursor/chats/"],
    default_data_paths: ["~/.cursor/chats/"],
    coverage: ["detect", "history", "config"],
    docs_url: "https://cursor.com/docs/cli/overview",
    homepage: "https://cursor.com",
  },
  {
    id: "factory-droid",
    name: "Factory Droid",
    vendor: "Factory AI",
    family: "other",
    kind: "cli",
    installed: false,
    version: null,
    data_paths: [],
    default_data_paths: ["~/.factory/sessions/"],
    coverage: ["detect", "history"],
    docs_url: "https://docs.factory.com",
    homepage: "https://factory.com",
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    vendor: "Google",
    family: "google",
    kind: "cli",
    installed: false,
    version: null,
    data_paths: [],
    default_data_paths: ["~/.gemini/sessions/"],
    coverage: ["detect", "history", "live"],
    docs_url: "https://geminicli.com/docs/",
    homepage: "https://geminicli.com",
  },
  {
    id: "github-copilot-cli",
    name: "GitHub Copilot CLI",
    vendor: "GitHub",
    family: "github-microsoft",
    kind: "cli",
    installed: false,
    version: null,
    data_paths: [],
    default_data_paths: ["~/.copilot/session-state/"],
    coverage: ["detect", "history"],
    docs_url: "https://docs.github.com/en/copilot",
    homepage: "https://github.com/features/copilot",
  },
  {
    id: "goose",
    name: "Goose",
    vendor: "Block",
    family: "open-source-clis",
    kind: "cli",
    installed: false,
    version: null,
    data_paths: [],
    default_data_paths: ["~/.local/share/goose/sessions"],
    coverage: ["detect", "history"],
    docs_url: "https://goose-docs.ai/",
    homepage: "https://goose-docs.ai/",
  },
  {
    id: "hermes-agent-cli",
    name: "Hermes Agent CLI",
    vendor: "Nous Research",
    family: "other",
    kind: "cli",
    installed: false,
    version: null,
    data_paths: [],
    default_data_paths: ["~/.hermes/state.db"],
    coverage: ["detect", "history"],
    docs_url: "https://hermes-agent.nousresearch.com/docs/user-guide/cli",
    homepage: "https://hermes-agent.nousresearch.com",
  },
  {
    id: "kilo-code",
    name: "Kilo Code",
    vendor: "Kilo AI",
    family: "open-source-clis",
    kind: "ide",
    installed: false,
    version: null,
    data_paths: [],
    default_data_paths: ["~/.kilo"],
    coverage: ["detect"],
    docs_url: "https://github.com/Kilo-Org/kilocode",
    homepage: "https://kilo.ai",
  },
  {
    id: "kimi-code-cli",
    name: "Kimi Code CLI",
    vendor: "Moonshot AI",
    family: "chinese-labs",
    kind: "cli",
    installed: false,
    version: null,
    data_paths: [],
    default_data_paths: ["~/.kimi-code/sessions/"],
    coverage: ["detect"],
    docs_url: "https://github.com/MoonshotAI/kimi-code",
    homepage: "https://kimi.moonshot.cn/code",
  },
  {
    id: "opencode",
    name: "OpenCode",
    vendor: "Anomaly",
    family: "other",
    kind: "cli",
    installed: false,
    version: null,
    data_paths: [],
    default_data_paths: ["~/Library/Application Support/ai.opencode.desktop/dev/drafts.sqlite"],
    coverage: ["detect"],
    docs_url: "https://github.com/anomalyco/opencode",
    homepage: "https://opencode.ai",
  },
  {
    id: "qoder-cli",
    name: "Qoder CLI",
    vendor: "Qoder AI",
    family: "other",
    kind: "cli",
    installed: false,
    version: null,
    data_paths: [],
    default_data_paths: ["~/.qoder/projects/"],
    coverage: ["detect", "history"],
    docs_url: "https://docs.qoder.com",
    homepage: "https://qoder.com/cli",
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    vendor: "Alibaba",
    family: "chinese-labs",
    kind: "cli",
    installed: false,
    version: null,
    data_paths: [],
    default_data_paths: ["~/.qwen/sessions/"],
    coverage: ["detect", "history"],
    docs_url: "https://qwenlm.github.io/qwen-code-docs/",
    homepage: "https://qwenlm.github.io/qwen-code-docs/",
  },
  {
    id: "roo-code",
    name: "Roo Code",
    vendor: "Roo Code Inc.",
    family: "other",
    kind: "ide",
    installed: false,
    version: null,
    data_paths: [],
    default_data_paths: ["~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/"],
    coverage: ["detect", "history"],
    docs_url: "https://github.com/RooCodeInc/Roo-Code",
    homepage: "https://roocodeinc.github.io/Roo-Code/",
  },
];

export interface AgentsClient {
  agents_list(): Promise<AgentWithInstall[]>;
}

export class MockAgentsClient implements AgentsClient {
  private agents: AgentWithInstall[];

  constructor(agents?: AgentWithInstall[]) {
    this.agents = agents ? [...agents] : [...MOCK_AGENTS];
  }

  async agents_list(): Promise<AgentWithInstall[]> {
    return [...this.agents];
  }
}

/** The real registry from the core: every builtin agent with what was found on this machine. */
export class CoreAgentsClient implements AgentsClient {
  async agents_list(): Promise<AgentWithInstall[]> {
    return call<AgentWithInstall[]>("agents_list");
  }
}

/** Kept for older imports. */
export const TauriAgentsClient = CoreAgentsClient;

let overrideClient: AgentsClient | null = null;
const mockClient = new MockAgentsClient();
const coreClient = new CoreAgentsClient();

/** The core's registry when a core is available (errors are not hidden), the mock catalogue otherwise. */
export function getAgentsClient(): AgentsClient {
  if (overrideClient) return overrideClient;
  return coreAvailable() ? coreClient : mockClient;
}

export function setAgentsClient(client: AgentsClient): void {
  overrideClient = client;
}

export function resetAgentsClient(): void {
  overrideClient = null;
}

export async function agentsList(): Promise<AgentWithInstall[]> {
  return getAgentsClient().agents_list();
}

export const agents_list = agentsList;
