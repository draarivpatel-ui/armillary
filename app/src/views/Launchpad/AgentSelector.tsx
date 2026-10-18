import React, { useId, useRef, useState } from "react";
import { AgentGlyph, Button, CheckIcon, ChevronDownIcon, FilterChip, Mark, TextField } from "@orrery/design";
import { CliAgentInfo, RecentLaunch } from "./types";
import { RecentLaunches } from "./RecentLaunches";
import { useDisplayPath } from "../../api/paths";

interface ProjectRootOption {
  root: string;
  name: string;
}

interface AgentSelectorProps {
  agents: CliAgentInfo[];
  selectedAgentId: string;
  onSelectAgent: (agentId: string) => void;
  projectFolder: string;
  onChangeProjectFolder: (folder: string) => void;
  projectRoots?: ProjectRootOption[];
  onLaunch: () => void;
  isLaunching: boolean;
  hasCore?: boolean;
  recentLaunches?: RecentLaunch[];
  onSelectRecentLaunch?: (launch: RecentLaunch) => void;
  onClearRecentLaunches?: () => void;
}

/** The most project chips offered under the folder field. */
const MAX_ROOT_CHIPS = 8;

export const AgentSelector: React.FC<AgentSelectorProps> = ({
  agents,
  selectedAgentId,
  onSelectAgent,
  projectFolder,
  onChangeProjectFolder,
  projectRoots = [],
  onLaunch,
  isLaunching,
  hasCore,
  recentLaunches = [],
  onSelectRecentLaunch,
  onClearRecentLaunches,
}) => {
  const ids = useId();
  const agentTitleId = `${ids}-agent`;
  const reasonId = `${ids}-reason`;
  const absentId = `${ids}-absent`;
  const tileRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [showAbsent, setShowAbsent] = useState<boolean>(false);

  const installed = agents.filter((a) => a.installed);
  const absent = agents.filter((a) => !a.installed);
  const selected = installed.find((a) => a.id === selectedAgentId);

  const move = (from: number, delta: number) => {
    if (installed.length === 0) return;
    const next = installed[(from + delta + installed.length) % installed.length];
    onSelectAgent(next.id);
    tileRefs.current[next.id]?.focus();
  };

  const onTileKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      move(index, 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      move(index, -1);
    }
  };

  // Why Launch is off, if it is: said once, in words, beside the button.
  const unavailable = hasCore === false;
  const displayPath = useDisplayPath();
  const folderEmpty = !projectFolder.trim();
  let reason: React.ReactNode = null;
  if (unavailable) reason = <Mark tone="neutral">Terminal unavailable in this window</Mark>;
  else if (!selected) reason = <span className="launchpad-launch__hint">Choose an installed agent to launch.</span>;
  else if (folderEmpty) reason = <span className="launchpad-launch__hint">Choose a project folder to launch in.</span>;

  const rootLabel = (r: ProjectRootOption) =>
    projectRoots.filter((other) => other.name === r.name).length > 1 ? displayPath(r.root) : r.name;
  const chips = projectRoots.slice(0, MAX_ROOT_CHIPS);
  const disabled = isLaunching || unavailable || !selected || folderEmpty;

  return (
    <div className="launchpad-config">
      <section className="launchpad-section" aria-labelledby={agentTitleId}>
        <h3 id={agentTitleId} className="launchpad-section-title">
          Choose an agent
        </h3>
        <div className="agent-grid" role="radiogroup" aria-labelledby={agentTitleId}>
          {installed.map((agent, index) => {
            const isSelected = agent.id === selectedAgentId;
            return (
              <button
                key={agent.id}
                ref={(el) => {
                  tileRefs.current[agent.id] = el;
                }}
                type="button"
                role="radio"
                data-agent-id={agent.id}
                aria-checked={isSelected}
                tabIndex={isSelected || (!selected && index === 0) ? 0 : -1}
                className={`agent-tile${isSelected ? " agent-tile--selected" : ""}`}
                onClick={() => onSelectAgent(agent.id)}
                onKeyDown={(e) => onTileKeyDown(e, index)}
              >
                <span className="agent-tile__glyph" style={{ color: `var(--family-${agent.family})` }}>
                  <AgentGlyph family={agent.family} size={24} />
                </span>
                <span className="agent-tile__text">
                  <span className="agent-tile__name">{agent.name}</span>
                  <span className="agent-tile__cmd">{agent.binary || agent.id}</span>
                </span>
                {isSelected && (
                  <span className="agent-tile__check" aria-hidden="true">
                    <CheckIcon size={14} />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {absent.length > 0 && (
          <div className="agent-absent">
            <button
              type="button"
              className="agent-absent__toggle"
              aria-expanded={showAbsent}
              aria-controls={absentId}
              onClick={() => setShowAbsent((v) => !v)}
            >
              <ChevronDownIcon size={14} className="agent-absent__chevron" />
              {showAbsent ? "Hide" : "Show"} {absent.length} {absent.length === 1 ? "agent" : "agents"} not on this Mac
            </button>
            {showAbsent && (
              <ul id={absentId} className="agent-absent__list">
                {absent.map((agent) => (
                  <li key={agent.id} className="agent-absent__item" data-agent-id={agent.id}>
                    <span className="agent-absent__glyph" style={{ color: `var(--family-${agent.family})` }}>
                      <AgentGlyph family={agent.family} size={16} />
                    </span>
                    <span>{agent.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="launchpad-section" aria-labelledby={`${ids}-project`}>
        <h3 id={`${ids}-project`} className="launchpad-section-title">
          Choose a project
        </h3>
        <TextField
          label="Project folder"
          className="obs-text-field--mono"
          value={projectFolder}
          onChange={(e) => onChangeProjectFolder(e.target.value)}
          placeholder="/path/to/your/project"
          spellCheck={false}
          autoComplete="off"
        />
        {chips.length > 0 && (
          <div className="launchpad-roots" role="group" aria-label="Your projects">
            {chips.map((r) => (
              <FilterChip
                key={r.root}
                label={rootLabel(r)}
                selected={projectFolder === r.root}
                onToggle={(next) => onChangeProjectFolder(next ? r.root : "")}
                data-root={r.root}
              />
            ))}
          </div>
        )}
      </section>

      <div className="launchpad-launch">
        <Button
          variant="gilt"
          data-launchpad-launch
          onClick={onLaunch}
          disabled={disabled}
          aria-describedby={reason ? reasonId : undefined}
        >
          {isLaunching ? "Launching" : selected ? `Launch ${selected.name}` : "Launch"}
        </Button>
        {reason && (
          <span id={reasonId} className="launchpad-launch__reason">
            {reason}
          </span>
        )}
      </div>

      <RecentLaunches
        launches={recentLaunches}
        onSelectLaunch={(item) => onSelectRecentLaunch?.(item)}
        onClearLaunches={onClearRecentLaunches}
      />
    </div>
  );
};
