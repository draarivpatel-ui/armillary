import React, { useState, useEffect, useMemo } from "react";
import { Checkbox, Figure, FigureGroup, Mark, SearchIcon, Tab, TabList, TabPanel, Tabs, TextField } from "@orrery/design";
import { AgentColumn } from "./AgentColumn";
import { ServerMatrix } from "./ServerMatrix";
import { RulesMatrix } from "./RulesMatrix";
import { useScrollEdges } from "./useScrollEdges";
import { differs } from "./model";
import { configList, isUsingFixtureData } from "../../api/config";
import { sessionsQueryAll } from "../../api/archive";
import { projectRootsOf } from "../../api/hooks";
import goldenSnapshot from "../../../../fixtures/switchboard/expected/snapshot.json";
import type { ConfigSnapshot, ServerPresence } from "./types";
import "./Switchboard.css";
import { NO_ACCESS, NoAccessNotice, isConsentRequired } from "../../access";

export interface SwitchboardProps {
  initialSnapshot?: ConfigSnapshot;
}

type TabKey = "matrix" | "side-by-side" | "rules";

const TABS: { key: TabKey; label: string }[] = [
  { key: "matrix", label: "Matrix" },
  { key: "side-by-side", label: "Side by side" },
  { key: "rules", label: "Rules" },
];

const SideBySide: React.FC<{
  snapshot: ConfigSnapshot;
  presenceByName: Record<string, ServerPresence>;
  diffOnly: boolean;
  query: string;
}> = ({ snapshot, presenceByName, diffOnly, query }) => {
  // Eight agents do not fit in one window width. The columns scroll sideways inside this region only,
  // never the page, with a fade at each edge that still hides columns.
  const { ref, edges } = useScrollEdges<HTMLDivElement>();
  const needle = query.trim().toLowerCase();
  const agents = needle
    ? snapshot.agents.map((agent) => ({
        ...agent,
        servers: agent.servers.filter((s) => s.name.toLowerCase().includes(needle)),
      }))
    : snapshot.agents;

  return (
    <div className="sb-sbs" data-edge-start={edges.atStart ? "true" : "false"} data-edge-end={edges.atEnd ? "true" : "false"}>
      <div className="sb-sbs__scroll" ref={ref} role="region" aria-label="Agents side by side" tabIndex={0}>
        {agents.map((agent) => (
          <AgentColumn key={agent.agent} agent={agent} presenceByName={presenceByName} diffOnly={diffOnly} />
        ))}
      </div>
    </div>
  );
};

export const Switchboard: React.FC<SwitchboardProps> = ({ initialSnapshot }) => {
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(() => {
    if (initialSnapshot) return initialSnapshot;
    if (isUsingFixtureData()) {
      return structuredClone(goldenSnapshot as unknown as ConfigSnapshot);
    }
    return null;
  });

  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [diffOnly, setDiffOnly] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("matrix");

  useEffect(() => {
    if (initialSnapshot || isUsingFixtureData()) return;
    let active = true;
    // Project folders come from the archive; the scan waits for them. If the archive cannot list them,
    // the global configuration still loads (the core then trusts only folders under the home folder).
    sessionsQueryAll({}, 5000)
      .then((page) => projectRootsOf(page.items).map((r) => r.root))
      .catch(() => [] as string[])
      .then((projectRoots) => configList({ projectRoots }))
      .then((data) => {
        if (active) setSnapshot(data);
      })
      .catch((err) => {
        console.error("Failed to load config snapshot:", err);
        if (active) setLoadError(isConsentRequired(err) ? NO_ACCESS : err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [initialSnapshot]);

  const presenceByName = useMemo<Record<string, ServerPresence>>(() => {
    if (!snapshot) return {};
    const map: Record<string, ServerPresence> = {};
    for (const item of snapshot.serverMatrix) {
      map[item.name] = item;
    }
    return map;
  }, [snapshot]);

  if (loadError === NO_ACCESS) return <NoAccessNotice what="the Switchboard" />;

  if (!snapshot) {
    return (
      <section className="view sb" aria-labelledby="sb-title">
        <header className="view-head">
          <div>
            <p className="view-eyebrow">Configuration</p>
            <h2 id="sb-title" className="view-title">
              The Switchboard
            </h2>
            <p className="view-lede" role="status">
              {loadError ? `Could not load agent configuration: ${loadError}` : "Loading agent configuration..."}
            </p>
          </div>
        </header>
      </section>
    );
  }

  const differing = snapshot.serverMatrix.filter(differs).length;
  const showFilters = activeTab !== "rules";
  return (
    <section className="view sb" aria-labelledby="sb-title" data-view="switchboard">
      <header className="view-head">
        <div>
          <p className="view-eyebrow">Configuration</p>
          <h2 id="sb-title" className="view-title">
            The Switchboard
          </h2>
          <p className="view-lede">MCP servers and rules files across your agents, side by side.</p>
          <p className="sb-assurance">
            <Mark tone="neutral" shape="ring">
              Read only
            </Mark>
            {isUsingFixtureData() && (
              <Mark tone="neutral" shape="diamond">
                Demo data
              </Mark>
            )}
            <span>Secret values are never shown: only the names of variables and headers.</span>
          </p>
        </div>
        <FigureGroup className="view-figures" aria-label="Summary">
          <Figure value={snapshot.agents.length} label="agents" />
          <Figure value={snapshot.serverMatrix.length} label="servers" />
          <Figure
            value={differing}
            label="differ"
            tone={differing > 0 ? "gilt" : "default"}
            title="Servers whose configuration differs across agents"
          />
        </FigureGroup>
      </header>

      <Tabs value={activeTab} onChange={(v) => setActiveTab(v as TabKey)}>
        <div className="sb-controls">
          <TabList aria-label="Switchboard views" className="sb-tabs">
            {TABS.map(({ key, label }) => (
              <Tab key={key} value={key} data-tab={key}>
                {label}
              </Tab>
            ))}
          </TabList>

          {showFilters && (
            <div className="sb-filters">
              <div className="sb-filter">
                <span className="sb-filter__lens" aria-hidden="true">
                  <SearchIcon size={16} />
                </span>
                <TextField
                  className="sb-filter__input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter servers"
                  aria-label="Filter servers"
                />
              </div>
              <Checkbox
                label="Differences only"
                checked={diffOnly}
                onChange={setDiffOnly}
                data-switchboard-differences-only=""
              />
            </div>
          )}
        </div>

        <TabPanel value="matrix" className="sb-panel">
          <ServerMatrix snapshot={snapshot} agents={snapshot.agents} query={query} diffOnly={diffOnly} />
        </TabPanel>

        <TabPanel value="side-by-side" className="sb-panel">
          <SideBySide snapshot={snapshot} presenceByName={presenceByName} diffOnly={diffOnly} query={query} />
        </TabPanel>

        <TabPanel value="rules" className="sb-panel">
          <RulesMatrix agents={snapshot.agents} />
        </TabPanel>
      </Tabs>
    </section>
  );
};
