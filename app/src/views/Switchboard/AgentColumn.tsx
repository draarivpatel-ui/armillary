import React, { useId, useState } from "react";
import { AgentGlyph, ChevronDownIcon, Mark } from "@orrery/design";
import { AGENT_FAMILY_BY_ID } from "./types";
import type { AgentConfig, McpServer, ServerPresence } from "./types";
import { differs } from "./model";
import { useDisplayPath } from "../../api/paths";

interface AgentColumnProps {
  agent: AgentConfig;
  presenceByName?: Record<string, ServerPresence>;
  diffOnly?: boolean;
}

/** Formats launch command or url with [masked] tokens visually distinguished. */
function renderLaunchLine(server: McpServer): React.ReactNode {
  const line = server.command ? [server.command, ...server.args].join(" ") : (server.url ?? "");

  if (!line.includes("[masked]")) {
    return <span className="sb-mono">{line}</span>;
  }

  const parts = line.split("[masked]");
  return (
    <span className="sb-mono">
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {part}
          {i < parts.length - 1 && <span className="sb-masked">[masked]</span>}
        </React.Fragment>
      ))}
    </span>
  );
}

const NameList: React.FC<{ label: string; names: string[] }> = ({ label, names }) =>
  names.length === 0 ? null : (
    <div className="sb-detail__row">
      <dt>{label}</dt>
      <dd className="sb-mono">{names.join(", ")}</dd>
    </div>
  );

const ServerEntry: React.FC<{ server: McpServer; agentName: string; presence?: ServerPresence }> = ({
  server,
  agentName,
  presence,
}) => {
  const [open, setOpen] = useState(false);
  const displayPath = useDisplayPath();
  const detailId = useId();
  const rowDiffers = presence ? differs(presence) : false;
  const launch = server.command ?? server.url ?? "";

  return (
    <li
      className="sb-entry"
      data-scope={server.scope}
      data-enabled={server.enabled ? "true" : "false"}
      data-differs={rowDiffers ? "true" : "false"}
    >
      <h4 className="sb-entry__name sb-mono" title={server.name}>
        {server.name}
      </h4>
      <p className="sb-entry__meta">
        <span>{server.transport}</span>
        <span>{server.scope}</span>
        {!server.enabled && (
          <Mark tone="neutral" shape="ring">
            Disabled
          </Mark>
        )}
        {rowDiffers && (
          <Mark tone="gilt" shape="diamond" emphasis title="This server is wired differently in different agents">
            Differs
          </Mark>
        )}
      </p>
      {server.maskedValues > 0 && (
        <p className="sb-entry__secrets">
          <span className="sb-masked">[masked]</span>
          <span>
            {server.maskedValues} secret value{server.maskedValues === 1 ? "" : "s"} hidden
          </span>
        </p>
      )}
      {launch.length > 0 || server.envNames.length > 0 || server.headerNames.length > 0 ? (
        <>
          <button
            type="button"
            className="sb-disclosure"
            aria-expanded={open}
            aria-controls={detailId}
            aria-label={`Details for ${server.name} in ${agentName}`}
            onClick={() => setOpen((v) => !v)}
          >
            <span>Details</span>
            <ChevronDownIcon size={14} className="sb-disclosure__chevron" />
          </button>
          <div id={detailId} className="sb-detail" hidden={!open}>
            {open && (
              <>
                <p className="sb-detail__launch">{renderLaunchLine(server)}</p>
                <dl className="sb-detail__list">
                  <NameList label="Variables" names={server.envNames} />
                  <NameList label="Headers" names={server.headerNames} />
                  <NameList label="Refers to" names={server.referencedEnvNames} />
                </dl>
                <p className="sb-detail__source sb-mono">
                  {displayPath(server.sourcePath)}
                  {server.project ? ` (project ${server.project})` : ""}
                </p>
              </>
            )}
          </div>
        </>
      ) : null}
    </li>
  );
};

export const AgentColumn: React.FC<AgentColumnProps> = ({ agent, presenceByName, diffOnly = false }) => {
  const family = AGENT_FAMILY_BY_ID[agent.agent] ?? "other";
  const displayPath = useDisplayPath();

  const displayedServers = diffOnly
    ? agent.servers.filter((server) => {
        const p = presenceByName?.[server.name];
        return p ? differs(p) : false;
      })
    : agent.servers;

  return (
    <section className="sb-col">
      <header className="sb-col__head">
        <span className="sb-col__glyph" style={{ color: `var(--family-${family})` }}>
          <AgentGlyph family={family} size={16} />
        </span>
        <h3 className="sb-col__name">{agent.displayName}</h3>
        <p className="sb-col__count">
          {agent.servers.length} server{agent.servers.length === 1 ? "" : "s"}
        </p>
      </header>

      {displayedServers.length === 0 ? (
        <p className="sb-empty">
          {diffOnly ? "Nothing here is wired differently." : "No servers in the files Armillary can read."}
        </p>
      ) : (
        <ul className="sb-col__list">
          {displayedServers.map((server, index) => (
            <ServerEntry
              key={`${server.sourcePath}:${server.name}:${index}`}
              server={server}
              agentName={agent.displayName}
              presence={presenceByName?.[server.name]}
            />
          ))}
        </ul>
      )}

      {(agent.skipped.length > 0 || agent.notes.length > 0) && (
        <div className="sb-col__notes">
          {agent.skipped.map((item) => (
            <p key={item.path} className="sb-note">
              <span className="sb-mono">{displayPath(item.path)}</span>{" "}
              {item.reason === "linkOutsideFolder"
                ? "is a link that leads outside its folder, not opened."
                : "holds credentials, never opened."}
            </p>
          ))}
          {agent.notes.map((note) => (
            <p key={note} className="sb-note">
              {note}
            </p>
          ))}
        </div>
      )}
    </section>
  );
};
