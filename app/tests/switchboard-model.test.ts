import { describe, it, expect } from "vitest";
import { MATRIX_COLUMNS, coverageLabel, differingAgentCount, matrixWidth } from "../src/views/Switchboard/model";
import type { AgentConfig, McpServer } from "../src/views/Switchboard/types";

function server(agent: string, name: string, over: Partial<McpServer> = {}): McpServer {
  return {
    agent,
    name,
    scope: "global",
    project: null,
    transport: "stdio",
    command: "npx",
    args: ["-y", name],
    url: null,
    envNames: [],
    headerNames: [],
    referencedEnvNames: [],
    enabled: true,
    maskedValues: 0,
    sourcePath: "~/x.json",
    ...over,
  };
}

function agent(id: string, servers: McpServer[]): AgentConfig {
  return { agent: id, displayName: id, vendor: "v", servers, rules: [], skipped: [], notes: [] };
}

describe("Switchboard model", () => {
  it("words coverage plainly", () => {
    expect(coverageLabel(1, 8)).toBe("In 1 of 8 agents");
    expect(coverageLabel(5, 8)).toBe("In 5 of 8 agents");
    expect(coverageLabel(8, 8)).toBe("In all 8");
    expect(coverageLabel(2, 2)).toBe("In all 2");
  });

  it("counts the agents whose wiring departs from the most common one", () => {
    const agents = [
      agent("a", [server("a", "ctx")]),
      agent("b", [server("b", "ctx")]),
      agent("c", [server("c", "ctx", { args: ["-y", "ctx", "--key", "[masked]"] })]),
      agent("d", [server("d", "ctx", { transport: "http", command: null, args: [], url: "https://x" })]),
      agent("e", []),
    ];
    expect(differingAgentCount(agents, "ctx")).toBe(2);
    expect(differingAgentCount(agents, "absent")).toBe(0);
    // a server wired identically everywhere does not differ
    expect(differingAgentCount([agent("a", [server("a", "z")]), agent("b", [server("b", "z")])], "z")).toBe(0);
  });

  it("budgets the matrix columns inside the 1280 px window", () => {
    expect(matrixWidth(8)).toBe(MATRIX_COLUMNS.server + 8 * MATRIX_COLUMNS.agent + MATRIX_COLUMNS.summary);
    expect(matrixWidth(8)).toBeLessThanOrEqual(1280 - 232 - 80);
    expect(MATRIX_COLUMNS.agent).toBeGreaterThanOrEqual(76);
    expect(MATRIX_COLUMNS.agent).toBeLessThanOrEqual(88);
  });
});
