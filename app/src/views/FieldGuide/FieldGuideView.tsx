import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  AgentGlyph,
  Button,
  FilterChip,
  Figure,
  FigureGroup,
  Kbd,
  Mark,
  SearchIcon,
  Select,
  TextField,
  type AgentFamily as DesignAgentFamily,
} from "@orrery/design";
import { AgentWithInstall, agentsList, isCoreAvailable } from "../../api/agents";
import { importDiagnostics, importNow, onImportProgress } from "../../api/archive";
import { useDisplayPath } from "../../api/paths";
import "./FieldGuide.css";
import { NO_ACCESS, NoAccessNotice, isConsentRequired } from "../../access";

export type AgentFamily = DesignAgentFamily;
export type AgentModel = AgentWithInstall;

export interface FieldGuideViewProps {
  initialAgents?: AgentModel[];
}

/** Section order; kinds the data brings that are not listed here follow alphabetically. */
const KIND_ORDER = ["cli", "desktop", "ide", "ide_extension", "cloud", "tui", "terminal", "server", "mobile"];

/** Plural section title for a kind. */
function getKindLabel(kind: string): string {
  switch (kind.toLowerCase()) {
    case "cli":
      return "Terminal CLIs";
    case "desktop":
      return "Desktop Apps";
    case "ide":
      return "IDE Agents";
    case "cloud":
      return "Cloud Agents";
    case "ide_extension":
      return "IDE Extensions";
    case "tui":
      return "Terminal UIs";
    case "terminal":
      return "Terminals";
    case "server":
      return "Servers and Orchestrators";
    case "mobile":
      return "Mobile Apps";
    default:
      return `${kind.charAt(0).toUpperCase()}${kind.slice(1)} Agents`;
  }
}

/** Short singular label for a kind chip. */
function getKindChipLabel(kind: string): string {
  switch (kind.toLowerCase()) {
    case "cli":
      return "CLI";
    case "ide":
      return "IDE";
    case "ide_extension":
      return "IDE extension";
    case "tui":
      return "TUI";
    default: {
      const spaced = kind.replace(/_/g, " ");
      return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
    }
  }
}

function getFamilyLabel(family: string): string {
  switch (family) {
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "google":
      return "Google";
    case "github-microsoft":
      return "GitHub and Microsoft";
    case "cursor":
      return "Cursor";
    case "open-source-clis":
      return "Open-source CLIs";
    case "chinese-labs":
      return "Chinese labs";
    case "other":
      return "Other";
    default:
      return family;
  }
}

function kindRank(kind: string): number {
  const i = KIND_ORDER.indexOf(kind);
  return i === -1 ? KIND_ORDER.length : i;
}

const COVERAGE_STEPS = [
  { key: "detect", label: "Detect" },
  { key: "history", label: "History" },
  { key: "live", label: "Live" },
  { key: "config", label: "Config" },
] as const;

/** "Coverage: detect, history; not live, not config", the words behind the engraved scale. */
function coverageSentence(coverage: string[] | undefined): string {
  const have = COVERAGE_STEPS.filter((s) => (coverage ?? []).includes(s.key)).map((s) => s.key);
  const lack = COVERAGE_STEPS.filter((s) => !(coverage ?? []).includes(s.key)).map((s) => `not ${s.key}`);
  if (lack.length === 0) return `Coverage: ${have.join(", ")}`;
  if (have.length === 0) return `Coverage: ${lack.join(", ")}`;
  return `Coverage: ${have.join(", ")}; ${lack.join(", ")}`;
}

/** The medallion's rim: 24 ticks, a longer one at each quarter. Static, so computed once. */
const MEDALLION_TICKS = Array.from({ length: 24 }, (_, i) => {
  const angle = (i / 24) * Math.PI * 2;
  const outer = 21;
  const inner = i % 6 === 0 ? 17 : 19;
  const c = 22;
  return {
    x1: +(c + Math.sin(angle) * outer).toFixed(2),
    y1: +(c - Math.cos(angle) * outer).toFixed(2),
    x2: +(c + Math.sin(angle) * inner).toFixed(2),
    y2: +(c - Math.cos(angle) * inner).toFixed(2),
    major: i % 6 === 0,
  };
});

/** A thin gilt ring with tick marks, the family glyph at its centre in the family colour. */
const Medallion: React.FC<{ family: string }> = ({ family }) => (
  <div
    className="fg-medallion"
    style={{ color: `var(--family-${family}, var(--family-other))` }}
    aria-hidden="true"
  >
    <svg className="fg-medallion__rim" width="44" height="44" viewBox="0 0 44 44" focusable="false">
      <circle cx="22" cy="22" r="21.25" fill="none" stroke="var(--color-gilt)" strokeWidth="0.75" />
      <circle cx="22" cy="22" r="15" fill="none" stroke="var(--color-gilt-hairline)" strokeWidth="0.75" />
      {MEDALLION_TICKS.map((t, i) => (
        <line
          key={i}
          x1={t.x1}
          y1={t.y1}
          x2={t.x2}
          y2={t.y2}
          stroke="var(--color-gilt)"
          strokeWidth={t.major ? 1 : 0.75}
        />
      ))}
    </svg>
    <span className="fg-medallion__glyph">
      <AgentGlyph family={family as AgentFamily} size={24} />
    </span>
  </div>
);

/** A hairline with four nodes: filled gilt diamond where supported, hollow ring where not. */
const CoverageScale: React.FC<{ id: string; coverage?: string[] }> = ({ id, coverage }) => (
  <div className="fg-coverage" data-testid={`coverage-${id}`}>
    <span className="obs-visually-hidden">{coverageSentence(coverage)}</span>
    <ol className="fg-scale" aria-hidden="true">
      {COVERAGE_STEPS.map((step) => {
        const supported = (coverage ?? []).includes(step.key);
        return (
          <li key={step.key} className="fg-scale__step" data-step={step.key} data-supported={supported}>
            <svg className="fg-scale__node" width="12" height="12" viewBox="0 0 12 12" focusable="false">
              {supported ? (
                <path d="M6 0.5 11.5 6 6 11.5 0.5 6Z" fill="var(--color-gilt)" />
              ) : (
                <circle cx="6" cy="6" r="3.75" fill="var(--color-ink-0)" stroke="var(--color-dust)" strokeWidth="1" />
              )}
            </svg>
            <span className="fg-scale__label">{step.label}</span>
          </li>
        );
      })}
    </ol>
  </div>
);

/** A path that may wrap after any slash. */
const WrappingPath: React.FC<{ path: string }> = ({ path }) => {
  const parts = path.split("/");
  return (
    <>
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {part}
          {i < parts.length - 1 && (
            <>
              /<wbr />
            </>
          )}
        </React.Fragment>
      ))}
    </>
  );
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const FieldGuideView: React.FC<FieldGuideViewProps> = ({ initialAgents }) => {
  const displayPath = useDisplayPath();
  const [agents, setAgents] = useState<AgentModel[]>(initialAgents || []);
  const [loaded, setLoaded] = useState<boolean>(initialAgents !== undefined);
  const [hasCore, setHasCore] = useState<boolean>(() => isCoreAvailable());
  const [searchQuery, setSearchQuery] = useState("");
  const [installedOnly, setInstalledOnly] = useState(false);
  const [selectedFamily, setSelectedFamily] = useState<string>("all");
  const [selectedKind, setSelectedKind] = useState<string>("all");
  const [isScanning, setIsScanning] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<string | null>(null);
  const [importFraction, setImportFraction] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  // Files the importer refused for size (R2-RC-3), newest last, at most five.
  const [skippedTooLarge, setSkippedTooLarge] = useState<string[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());

  // Load from agents.ts client if not overridden by props
  useEffect(() => {
    if (initialAgents) {
      setAgents(initialAgents);
      setLoaded(true);
      return;
    }

    let isMounted = true;
    const fetchAgents = async () => {
      try {
        setIsScanning(true);
        setHasCore(isCoreAvailable());
        const data = await agentsList();
        if (isMounted && Array.isArray(data)) {
          setAgents(data);
          setHasCore(isCoreAvailable());
          setLoadError(null);
          setLoaded(true);
        }
      } catch (err) {
        if (isMounted) setLoadError(isConsentRequired(err) ? NO_ACCESS : errorText(err));
      } finally {
        if (isMounted) {
          setIsScanning(false);
        }
      }
    };

    fetchAgents();
    return () => {
      isMounted = false;
    };
  }, [initialAgents]);

  // Listen to import:progress events from the background importer or watcher
  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    onImportProgress((p) => {
      const skipped = p.error;
      if (skipped && skipped.startsWith("Skipped, too large")) {
        setSkippedTooLarge((prev) => (prev.includes(skipped) ? prev : [...prev, skipped].slice(-5)));
      }
      if (p.agentId === "") {
        // Run-level events: the run starts and ends here.
        if (p.phase === "started") {
          setIsImporting(true);
          setImportProgress("Starting import...");
          setImportFraction(null);
        } else if (p.phase === "finished") {
          setIsImporting(false);
          setImportProgress(null);
          setImportFraction(null);
        }
        return;
      }
      if (p.phase === "error") {
        if (p.error) setImportError(p.error);
        return;
      }
      setIsImporting(true);
      setImportProgress(`Importing ${p.agentId} (${p.sessionsImported} of ${p.sessionsKnown} sessions)`);
      setImportFraction(p.sessionsKnown > 0 ? Math.min(1, p.sessionsImported / p.sessionsKnown) : null);
    }).then(
      (off) => {
        if (mounted) unlisten = off;
        else off();
      },
      () => {},
    );
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  // P2-2: the launch import and the first-run import run while this view is closed, so read the
  // skips the archive kept (newest first) once when it opens.
  useEffect(() => {
    if (!isCoreAvailable()) return;
    let mounted = true;
    importDiagnostics(null).then(
      (items) => {
        if (!mounted || !Array.isArray(items)) return;
        const kept: string[] = [];
        for (const d of items) {
          const text = d && d.code === "limit" ? d.message : null;
          if (text && text.startsWith("Skipped, too large") && !kept.includes(text)) kept.push(text);
        }
        if (kept.length === 0) return;
        setSkippedTooLarge((prev) => {
          const merged = [...kept.slice(0, 5).reverse(), ...prev.filter((n) => !kept.includes(n))];
          return merged.slice(-5);
        });
      },
      () => {},
    );
    return () => {
      mounted = false;
    };
  }, []);

  // Global keyboard shortcut '/' to focus the quick filter
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      searchInputRef.current?.focus();
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  const handleRefresh = async () => {
    setIsScanning(true);
    try {
      setHasCore(isCoreAvailable());
      const data = await agentsList();
      if (Array.isArray(data)) {
        setAgents(data);
        setHasCore(isCoreAvailable());
        setLoadError(null);
        setLoaded(true);
      }
    } catch (err) {
      setLoadError(isConsentRequired(err) ? NO_ACCESS : errorText(err));
    } finally {
      setIsScanning(false);
    }
  };

  const handleImportNow = async () => {
    setIsImporting(true);
    setImportError(null);
    try {
      await importNow(null);
    } catch (err) {
      if (isConsentRequired(err)) setLoadError(NO_ACCESS);
      else setImportError(errorText(err));
    } finally {
      setIsImporting(false);
      setImportProgress(null);
      setImportFraction(null);
    }
  };

  // Does an agent pass every filter except the ones named in `skip`? (chip counts follow the other filters)
  const matches = (agent: AgentModel, skip: "kind" | "installed" | null): boolean => {
    const query = searchQuery.trim().toLowerCase();
    if (skip !== "installed" && installedOnly && !agent.installed) return false;
    if (selectedFamily !== "all" && agent.family !== selectedFamily) return false;
    if (skip !== "kind" && selectedKind !== "all" && agent.kind.toLowerCase() !== selectedKind) return false;
    if (query) {
      const matchesName = agent.name.toLowerCase().includes(query);
      const matchesVendor = agent.vendor.toLowerCase().includes(query);
      const matchesDataPaths = (agent.data_paths || []).some((p) => p.toLowerCase().includes(query));
      const matchesDefaultPaths = (agent.default_data_paths || []).some((p) => p.toLowerCase().includes(query));
      if (!matchesName && !matchesVendor && !matchesDataPaths && !matchesDefaultPaths) return false;
    }
    return true;
  };

  const filteredAgents = useMemo(
    () => agents.filter((agent) => matches(agent, null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents, searchQuery, installedOnly, selectedFamily, selectedKind],
  );

  // Every kind present in the data, in reading order
  const kinds = useMemo(() => {
    const present = Array.from(new Set(agents.map((a) => a.kind.toLowerCase())));
    return present.sort((a, b) => kindRank(a) - kindRank(b) || a.localeCompare(b));
  }, [agents]);

  const families = useMemo(
    () => Array.from(new Set(agents.map((a) => a.family))).sort((a, b) => getFamilyLabel(a).localeCompare(getFamilyLabel(b))),
    [agents],
  );

  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const agent of agents) {
      if (matches(agent, "kind")) {
        const k = agent.kind.toLowerCase();
        counts[k] = (counts[k] ?? 0) + 1;
      }
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, searchQuery, installedOnly, selectedFamily]);

  const installedChipCount = useMemo(
    () => agents.filter((a) => a.installed && matches(a, "installed")).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents, searchQuery, selectedFamily, selectedKind],
  );

  // Group by kind, in reading order
  const groupedAgents = useMemo(() => {
    const groups = new Map<string, AgentModel[]>();
    for (const kind of kinds) groups.set(kind, []);
    for (const agent of filteredAgents) groups.get(agent.kind.toLowerCase())?.push(agent);
    return Array.from(groups.entries()).filter(([, list]) => list.length > 0);
  }, [filteredAgents, kinds]);

  // Ordered list of visible agent IDs for sequential keyboard navigation
  const visibleAgentIds = useMemo(
    () => groupedAgents.flatMap(([, list]) => list.map((agent) => agent.id)),
    [groupedAgents],
  );
  // Roving tab stop: one entry is in the tab order, the arrow keys move between entries
  const tabStopId = focusedId && visibleAgentIds.includes(focusedId) ? focusedId : visibleAgentIds[0];

  const handleCardKeyDown = (
    e: React.KeyboardEvent<HTMLElement>,
    agentId: string,
    docsUrl?: string | null
  ) => {
    // Keys pressed on the docs link inside the entry belong to the link
    if (e.target !== e.currentTarget) return;
    const currentIndex = visibleAgentIds.indexOf(agentId);
    if (currentIndex === -1) return;

    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      const nextId = visibleAgentIds[(currentIndex + 1) % visibleAgentIds.length];
      cardRefs.current.get(nextId)?.focus();
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      const prevId = visibleAgentIds[(currentIndex - 1 + visibleAgentIds.length) % visibleAgentIds.length];
      cardRefs.current.get(prevId)?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      if (e.key === " ") e.preventDefault();
      if (docsUrl) {
        window.open(docsUrl, "_blank", "noopener,noreferrer");
      }
    }
  };

  const installedCount = useMemo(() => agents.filter((a) => a.installed).length, [agents]);
  const anyFilter = Boolean(searchQuery) || installedOnly || selectedFamily !== "all" || selectedKind !== "all";
  const resetFilters = () => {
    setSearchQuery("");
    setInstalledOnly(false);
    setSelectedFamily("all");
    setSelectedKind("all");
  };
  if (loadError === NO_ACCESS) return <NoAccessNotice what="the Field Guide" />;


  return (
    <section className="view field-guide" aria-labelledby="field-guide-title">
      <header className="view-head">
        <div>
          <p className="view-eyebrow">Agents</p>
          <h2 id="field-guide-title" className="view-title">
            The Field Guide
          </h2>
          <p className="view-lede">
            Every agent Armillary knows, whether it is on this machine, and what Armillary can read from it.
          </p>
        </div>
        <div className="fg-head-side">
          {loaded && (
            <FigureGroup className="view-figures" aria-label="Registry summary">
              <Figure value={agents.length} label="agents" />
              <Figure value={installedCount} label="installed" tone="success" />
            </FigureGroup>
          )}
          <div className="fg-actions">
            {!hasCore && <Mark tone="neutral" shape="ring">Demo data</Mark>}
            <Button
              size="sm"
              variant="ghost"
              onClick={handleRefresh}
              disabled={isScanning || !hasCore}
              title={!hasCore ? "Scan unavailable without core backend" : undefined}
            >
              {isScanning ? "Scanning..." : "Scan now"}
            </Button>
            <Button
              variant="default"
              onClick={handleImportNow}
              disabled={isImporting || !hasCore}
              title={!hasCore ? "Import unavailable without core backend" : undefined}
              data-testid="import-now-button"
            >
              {isImporting ? (importProgress || "Importing...") : "Import now"}
            </Button>
          </div>
          {isImporting && importFraction !== null && (
            <div className="fg-progress" aria-hidden="true">
              <span className="fg-progress__bar" style={{ width: `${Math.round(importFraction * 100)}%` }} />
            </div>
          )}
          <span className="obs-visually-hidden" role="status">
            {importProgress ?? ""}
          </span>
        </div>
      </header>

      {loadError && (
        <p role="alert" className="fg-notice">
          <Mark tone="alert" shape="diamond" emphasis>
            Could not load agents: {loadError}
          </Mark>
        </p>
      )}
      {importError && (
        <p role="alert" className="fg-notice">
          <Mark tone="alert" shape="diamond" emphasis>
            Import failed: {importError}
          </Mark>
        </p>
      )}
      {skippedTooLarge.map((note) => (
        <p key={note} role="status" className="fg-notice">
          <Mark tone="gilt" shape="diamond">
            {note}
          </Mark>
        </p>
      ))}

      {/* Quick filter, kind and installed chips, family */}
      <div className="fg-toolbar" role="group" aria-label="Filters">
        <div className="fg-filter">
          <span className="fg-filter__lens" aria-hidden="true">
            <SearchIcon size={16} />
          </span>
          <TextField
            ref={searchInputRef}
            type="search"
            className="fg-filter__input"
            placeholder="Filter agents"
            aria-label="Filter agents by name, vendor, or path"
            aria-keyshortcuts="/"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <Kbd className="fg-filter__kbd" aria-hidden="true">
            /
          </Kbd>
        </div>

        <div className="fg-chips" role="group" aria-label="Kind">
          {kinds.map((kind) => (
            <FilterChip
              key={kind}
              label={getKindChipLabel(kind)}
              count={kindCounts[kind] ?? 0}
              selected={selectedKind === kind}
              onToggle={(next) => setSelectedKind(next ? kind : "all")}
            />
          ))}
          <FilterChip
            label="Installed"
            count={installedChipCount}
            selected={installedOnly}
            onToggle={setInstalledOnly}
          />
        </div>

        <Select
          label="Family"
          hideLabel
          size="sm"
          value={selectedFamily}
          onChange={setSelectedFamily}
          options={[
            { value: "all", label: "All families" },
            ...families.map((f) => ({ value: f, label: getFamilyLabel(f) })),
          ]}
        />

        {anyFilter && (
          <Button size="sm" variant="ghost" onClick={resetFilters}>
            Reset filters
          </Button>
        )}
      </div>

      {/* Entries grouped by kind */}
      {!loaded && !loadError ? (
        <p className="fg-quiet" role="status">
          Reading the registry...
        </p>
      ) : loaded && filteredAgents.length === 0 ? (
        <div className="fg-empty">
          <p className="fg-empty__title">No matching agents</p>
          <p className="fg-quiet">Try a different word, or clear a filter.</p>
        </div>
      ) : (
        groupedAgents.map(([kindKey, groupList]) => (
          <section key={kindKey} className="fg-section" aria-labelledby={`heading-kind-${kindKey}`}>
            <h3 id={`heading-kind-${kindKey}`} className="fg-section__head">
              <span className="fg-section__title">{getKindLabel(kindKey)}</span>
              <span className="fg-section__count">{groupList.length}</span>
            </h3>

            <ul className="fg-grid">
              {groupList.map((agent) => {
                const location = agent.installed
                  ? agent.data_paths?.[0] || agent.default_data_paths?.[0]
                  : agent.default_data_paths?.[0];

                return (
                  <li
                    key={agent.id}
                    ref={(el) => {
                      if (el) cardRefs.current.set(agent.id, el);
                      else cardRefs.current.delete(agent.id);
                    }}
                    tabIndex={agent.id === tabStopId ? 0 : -1}
                    data-testid={`agent-card-${agent.id}`}
                    data-installed={agent.installed ? "true" : "false"}
                    title={agent.detection_note ?? undefined}
                    className="fg-entry"
                    onFocus={(e) => {
                      if (e.target === e.currentTarget) setFocusedId(agent.id);
                    }}
                    onKeyDown={(e) => handleCardKeyDown(e, agent.id, agent.docs_url)}
                    aria-label={`${agent.name} by ${agent.vendor}, ${agent.installed ? "installed" : "not installed"}`}
                  >
                    <div className="fg-entry__row">
                      <Medallion family={agent.family} />
                      <div className="fg-entry__main">
                        <div className="fg-entry__identity">
                          <h4 className="fg-entry__name">{agent.name}</h4>
                          <p className="fg-entry__vendor">{agent.vendor}</p>
                        </div>

                        <div className="fg-entry__status">
                          {agent.installed ? (
                            <>
                              <Mark tone="success" shape="dot">Installed</Mark>
                              {agent.version && <span className="fg-entry__version">{agent.version}</span>}
                            </>
                          ) : (
                            <Mark tone="neutral" shape="ring">Not on this Mac</Mark>
                          )}
                          {agent.docs_url && (
                            <a
                              href={agent.docs_url}
                              target="_blank"
                              rel="noreferrer"
                              className="fg-entry__docs"
                              aria-label={`Docs for ${agent.name}`}
                            >
                              Docs
                            </a>
                          )}
                        </div>

                        {agent.detection_note && <p className="fg-entry__note">{agent.detection_note}</p>}

                        <CoverageScale id={agent.id} coverage={agent.coverage} />

                        {location && (
                          <p className="fg-entry__where">
                            <span className="obs-visually-hidden">
                              {agent.installed ? "Where its data lives: " : "Where its data would live: "}
                            </span>
                            <span className="fg-entry__path">
                              <WrappingPath path={displayPath(location)} />
                            </span>
                          </p>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </section>
  );
};
