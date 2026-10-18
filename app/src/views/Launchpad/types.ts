export type AgentFamily =
  | "anthropic"
  | "openai"
  | "google"
  | "github-microsoft"
  | "cursor"
  | "open-source-clis"
  | "chinese-labs"
  | "other";

export interface CliAgentInfo {
  id: string;
  name: string;
  installed: boolean;
  family: AgentFamily;
  binary?: string;
  description?: string;
}

export interface TerminalSession {
  id: string;
  title: string;
  agentId: string;
  agentName: string;
  family: AgentFamily;
  cwd: string;
  status: "connected" | "connecting" | "disconnected" | "error";
  error?: string;
}

export interface PtyDataEvent {
  id: string;
  data: string;
}

export interface RecentLaunch {
  id: string;
  agentId: string;
  agentName: string;
  family: AgentFamily;
  projectFolder: string;
  timestamp: number;
}
