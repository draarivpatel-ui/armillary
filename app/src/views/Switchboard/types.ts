// Mirrors app/src-tauri/src/config_scan.rs (serde renames everything to camelCase).

export type Scope = "global" | "project";

export type Transport = "stdio" | "http" | "sse" | "unknown";

export type RulesFormat = "markdown" | "mdc" | "text";

export interface McpServer {
  agent: string;
  name: string;
  scope: Scope;
  project: string | null;
  transport: Transport;
  command: string | null;
  args: string[];
  url: string | null;
  envNames: string[];
  headerNames: string[];
  referencedEnvNames: string[];
  enabled: boolean;
  maskedValues: number;
  sourcePath: string;
}

export interface RulesFile {
  agent: string;
  scope: Scope;
  project: string | null;
  path: string;
  format: RulesFormat;
  exists: boolean;
  preview: string | null;
  truncated: boolean;
  lineCount: number;
  maskedValues: number;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface AgentConfig {
  agent: string;
  displayName: string;
  vendor: string;
  servers: McpServer[];
  rules: RulesFile[];
  skipped: SkippedFile[];
  notes: string[];
}

export interface ServerPresence {
  name: string;
  presentIn: string[];
  missingFrom: string[];
  definitions: number;
  sharedByAll: boolean;
}

export interface ConfigSnapshot {
  agents: AgentConfig[];
  serverMatrix: ServerPresence[];
  projects: string[];
  serverCount: number;
  maskedValueCount: number;
}

export type AgentFamily =
  | "anthropic"
  | "openai"
  | "google"
  | "github-microsoft"
  | "cursor"
  | "open-source-clis"
  | "other";

/** Display order and colour family, matching SPEC 3.2. */
export const AGENT_FAMILY_BY_ID: Record<string, AgentFamily> = {
  "claude-code": "anthropic",
  "codex-cli": "openai",
  "gemini-cli": "google",
  "copilot-cli": "github-microsoft",
  cursor: "cursor",
  opencode: "open-source-clis",
  windsurf: "other",
  cline: "open-source-clis",
};
