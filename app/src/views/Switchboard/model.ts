import type { AgentConfig, McpServer, ServerPresence } from "./types";

/**
 * Column budget for the Matrix, in px. The view is about 968 px wide in a 1280 px window
 * (232 px rail, 2 x 40 px padding): the first column and eight agent columns are fixed, the
 * summary column takes what is left (never less than `summary`).
 */
export const MATRIX_COLUMNS = { server: 208, agent: 78, summary: 136 } as const;

export function matrixWidth(agentCount: number): number {
  return MATRIX_COLUMNS.server + agentCount * MATRIX_COLUMNS.agent + MATRIX_COLUMNS.summary;
}

/** Shorter names for the narrow matrix headers; the full name stays in the tooltip and accessible name. */
const SHORT_NAMES: Record<string, string> = {
  "copilot-cli": "Copilot CLI",
};

export function shortAgentName(agent: AgentConfig): string {
  return SHORT_NAMES[agent.agent] ?? agent.displayName;
}

/** "In 1 of 8 agents", "In all 8". */
export function coverageLabel(present: number, total: number): string {
  return present >= total ? `In all ${total}` : `In ${present} of ${total} agents`;
}

/** Same notion of "wiring" as the core: transport, command, arguments and url. */
function signature(server: McpServer): string {
  return [server.transport, server.command ?? "", server.args.join(" "), server.url ?? ""].join("|");
}

/** A server differs when the agents that have it do not all wire it the same way. */
export function differs(presence: ServerPresence): boolean {
  return presence.definitions > 1;
}

/**
 * How many agents wire the server differently from the most common wiring. Zero when every
 * agent that has it wires it the same way.
 */
export function differingAgentCount(agents: AgentConfig[], serverName: string): number {
  const perAgent: Set<string>[] = [];
  for (const agent of agents) {
    const sigs = new Set(agent.servers.filter((s) => s.name === serverName).map(signature));
    if (sigs.size > 0) perAgent.push(sigs);
  }
  const tally = new Map<string, number>();
  for (const sigs of perAgent) for (const sig of sigs) tally.set(sig, (tally.get(sig) ?? 0) + 1);
  if (tally.size < 2) return 0;
  let top = "";
  let topCount = 0;
  for (const [sig, count] of tally) {
    if (count > topCount) {
      top = sig;
      topCount = count;
    }
  }
  return perAgent.filter((sigs) => Array.from(sigs).some((sig) => sig !== top)).length;
}

export type CellState = "present" | "off" | "absent";

export function cellState(agent: AgentConfig, serverName: string): CellState {
  const entries = agent.servers.filter((server) => server.name === serverName);
  if (entries.length === 0) return "absent";
  return entries.every((entry) => !entry.enabled) ? "off" : "present";
}

/** The distinct transports a server is wired with, in order of first appearance. */
export function transportsOf(agents: AgentConfig[], serverName: string): string[] {
  const seen: string[] = [];
  for (const agent of agents) {
    for (const server of agent.servers) {
      if (server.name === serverName && !seen.includes(server.transport)) seen.push(server.transport);
    }
  }
  return seen;
}

/** Last path segment, for showing a rules file name apart from its folder. */
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
