import React, { useId, useState } from "react";
import { AgentGlyph, ChevronDownIcon, Mark } from "@orrery/design";
import { AGENT_FAMILY_BY_ID } from "./types";
import type { AgentConfig, RulesFile } from "./types";
import { fileName } from "./model";
import { useDisplayPath } from "../../api/paths";

interface RulesMatrixProps {
  agents: AgentConfig[];
}

const RuleRow: React.FC<{ rule: RulesFile }> = ({ rule }) => {
  const [open, setOpen] = useState(false);
  const displayPath = useDisplayPath();
  const previewId = useId();
  const hasPreview = rule.exists && rule.preview !== null && rule.preview.length > 0;

  return (
    <li className="sb-rule" data-exists={rule.exists ? "true" : "false"}>
      <div className="sb-rule__line">
        <span className="sb-rule__file sb-mono">{fileName(rule.path)}</span>
        {rule.exists ? (
          <Mark tone="success" shape="dot">
            Found
          </Mark>
        ) : (
          <Mark tone="neutral" shape="ring">
            Not found
          </Mark>
        )}
      </div>
      <p className="sb-rule__path sb-mono">{displayPath(rule.path)}</p>
      {rule.exists && (
        <p className="sb-rule__meta">
          {rule.scope} scope, {rule.lineCount} lines
          {rule.truncated ? ", preview shortened" : ""}
          {rule.maskedValues > 0 ? `, ${rule.maskedValues} secret value${rule.maskedValues === 1 ? "" : "s"} hidden` : ""}
        </p>
      )}
      {hasPreview && (
        <>
          <button
            type="button"
            className="sb-disclosure"
            aria-expanded={open}
            aria-controls={previewId}
            aria-label={`Preview of ${displayPath(rule.path)}`}
            onClick={() => setOpen((v) => !v)}
          >
            <span>Preview</span>
            <ChevronDownIcon size={14} className="sb-disclosure__chevron" />
          </button>
          <div id={previewId} hidden={!open}>
            {open && (
              <pre className="sb-rule__preview sb-mono" tabIndex={0} aria-label={`Contents of ${displayPath(rule.path)}`}>
                {rule.preview}
              </pre>
            )}
          </div>
        </>
      )}
    </li>
  );
};

export const RulesMatrix: React.FC<RulesMatrixProps> = ({ agents }) => (
  <div className="sb-rules">
    {agents.map((agent) => {
      const family = AGENT_FAMILY_BY_ID[agent.agent] ?? "other";
      return (
        <section key={agent.agent} className="sb-rules__agent">
          <header className="sb-rules__head">
            <span className="sb-col__glyph" style={{ color: `var(--family-${family})` }}>
              <AgentGlyph family={family} size={16} />
            </span>
            <h3 className="sb-rules__name">{agent.displayName}</h3>
          </header>
          {agent.rules.length === 0 ? (
            <p className="sb-empty">No rules file location is known for this agent.</p>
          ) : (
            <ul className="sb-rules__list">
              {agent.rules.map((rule, index) => (
                <RuleRow key={`${rule.path}:${index}`} rule={rule} />
              ))}
            </ul>
          )}
        </section>
      );
    })}
  </div>
);
