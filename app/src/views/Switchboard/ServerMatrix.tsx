import React from "react";
import { AgentGlyph, Tooltip } from "@orrery/design";
import { AGENT_FAMILY_BY_ID } from "./types";
import { useScrollEdges } from "./useScrollEdges";
import type { AgentConfig, ConfigSnapshot } from "./types";
import {
  MATRIX_COLUMNS,
  cellState,
  coverageLabel,
  differingAgentCount,
  differs,
  matrixWidth,
  shortAgentName,
  transportsOf,
} from "./model";
import type { CellState } from "./model";

interface ServerMatrixProps {
  snapshot: ConfigSnapshot;
  agents: AgentConfig[];
  query: string;
  diffOnly?: boolean;
}

const CELL_PHRASE: Record<CellState, string> = {
  present: "Present in",
  off: "Disabled in",
  absent: "Not in",
};

const CellMark: React.FC<{ state: CellState; label: string }> = ({ state, label }) => {
  if (state === "off") {
    return (
      <span role="img" aria-label={label} className="sb-mx__mark sb-mx__mark--off">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" focusable="false">
          <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.25" />
          <path d="M3.6 10.4L10.4 3.6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return <span role="img" aria-label={label} className={`sb-mx__mark sb-mx__mark--${state}`} />;
};

export const ServerMatrix: React.FC<ServerMatrixProps> = ({ snapshot, agents, query, diffOnly = false }) => {
  const needle = query.trim().toLowerCase();
  const rows = snapshot.serverMatrix.filter((row) => {
    const matchesQuery = needle.length === 0 || row.name.toLowerCase().includes(needle);
    return matchesQuery && (!diffOnly || differs(row));
  });

  // At 1280 px and wider the matrix fits. Narrower windows scroll it sideways inside this box only,
  // and then the box takes focus and a name so the keyboard can scroll it.
  const { ref, edges } = useScrollEdges<HTMLDivElement>();

  return (
    <div
      className="sb-mx"
      ref={ref}
      {...(edges.scrollable ? { role: "region", "aria-label": "Server matrix", tabIndex: 0 } : {})}
    >
      <table className="sb-mx__table" aria-label="MCP servers by agent" style={{ minWidth: matrixWidth(agents.length) }}>
        <colgroup>
          <col style={{ width: MATRIX_COLUMNS.server }} />
          {agents.map((agent) => (
            <col key={agent.agent} style={{ width: MATRIX_COLUMNS.agent }} />
          ))}
          <col />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="sb-mx__server-head">
              Server
            </th>
            {agents.map((agent) => (
              <th key={agent.agent} scope="col" className="sb-mx__agent-head">
                <Tooltip content={agent.displayName}>
                  <span className="sb-mx__agent">
                    <span
                      className="sb-mx__glyph"
                      style={{ color: `var(--family-${AGENT_FAMILY_BY_ID[agent.agent] ?? "other"})` }}
                    >
                      <AgentGlyph family={AGENT_FAMILY_BY_ID[agent.agent] ?? "other"} size={16} />
                    </span>
                    <span className="sb-mx__agent-name" aria-hidden="true">
                      {shortAgentName(agent)}
                    </span>
                    <span className="sb-sr">{agent.displayName}</span>
                  </span>
                </Tooltip>
              </th>
            ))}
            <th scope="col" className="sb-mx__summary-head">
              Coverage
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={agents.length + 2} className="sb-mx__empty">
                {needle.length > 0
                  ? "No server matches that name."
                  : "No server is wired differently between agents."}
              </td>
            </tr>
          )}
          {rows.map((row) => {
            const rowDiffers = differs(row);
            const transports = transportsOf(agents, row.name);
            const differing = rowDiffers ? Math.max(1, differingAgentCount(agents, row.name)) : 0;
            return (
              <tr key={row.name} className="sb-mx__row" data-differs={rowDiffers ? "true" : "false"}>
                <th scope="row" className="sb-mx__server">
                  <span className="sb-mx__name" title={row.name}>
                    {row.name}
                  </span>
                  {transports.length > 0 && <span className="sb-mx__transport">{transports.join(", ")}</span>}
                </th>
                {agents.map((agent) => {
                  const state = cellState(agent, row.name);
                  return (
                    <td key={agent.agent} className="sb-mx__cell" data-agent={agent.agent} data-state={state}>
                      <CellMark state={state} label={`${CELL_PHRASE[state]} ${agent.displayName}`} />
                    </td>
                  );
                })}
                <td className="sb-mx__summary">
                  {rowDiffers ? (
                    <>
                      <span className="sb-mx__differs">Differs in {differing}</span>
                      <span className="sb-mx__coverage">{coverageLabel(row.presentIn.length, agents.length)}</span>
                    </>
                  ) : (
                    <span className="sb-mx__coverage sb-mx__coverage--plain">
                      {coverageLabel(row.presentIn.length, agents.length)}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
