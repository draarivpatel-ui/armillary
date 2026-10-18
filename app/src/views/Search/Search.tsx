import React, { useState, useEffect, useRef, useMemo, useId } from "react";
import {
  AgentGlyph,
  AGENT_FAMILIES,
  CloseIcon,
  IconButton,
  Kbd,
  SearchIcon,
  Select,
  type AgentFamily,
} from "@orrery/design";
import {
  search,
  getProjectBasename,
  type SearchResult,
  type SearchFilter,
} from "../../api/archive";
import { agents_list, type Agent } from "../../api/agents";
import { useAccess } from "../../access";
import { appNow } from "../../api/client";
import { Snippet } from "./snippet";
import { useProjectRoots } from "../../api/hooks";
import "./Search.css";

export interface SearchProps {
  initialQuery?: string;
  onOpenFolio?: (sessionId: string, hitSeq: number) => void;
}

/** The most hits one search asks for. */
const HIT_LIMIT = 50;

type DatePreset = "any" | "today" | "7" | "30" | "365";

const DATE_OPTIONS: Array<{ value: DatePreset; label: string }> = [
  { value: "any", label: "Any time" },
  { value: "today", label: "Today" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "365", label: "Last 365 days" },
];

/** Presets become the same from/to millisecond values the data hook takes, anchored on appNow(). */
export function dateRangeFor(preset: DatePreset, now: number): { from?: number; to?: number } {
  if (preset === "any") return {};
  const days = preset === "today" ? 1 : Number(preset);
  const start = new Date(now);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { from: start.getTime(), to: end.getTime() };
}

const KIND_LABEL: Record<SearchResult["kind"], string> = {
  message: "Message",
  tool: "Tool call",
};

function formatSessionDate(timestamp?: number | null): string | null {
  if (!timestamp) return null;
  return new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

interface Group {
  sessionId: string;
  agentId: string;
  title: string;
  projectRoot: string | null;
  startedAt: number | null;
  hits: Array<{ hit: SearchResult; index: number }>;
}

/** Group hits by session, in the order each session's best hit arrived; each hit keeps its overall index. */
function groupHits(hits: SearchResult[]): Group[] {
  const order: Group[] = [];
  const byId = new Map<string, Group>();
  hits.forEach((hit, index) => {
    let group = byId.get(hit.session_id);
    if (!group) {
      group = {
        sessionId: hit.session_id,
        agentId: hit.agent_id,
        title: hit.session_title || hit.session_display_title || "Untitled session",
        projectRoot: hit.project_root,
        startedAt: hit.session_started_at ?? hit.at,
        hits: [],
      };
      byId.set(hit.session_id, group);
      order.push(group);
    }
    group.hits.push({ hit, index });
  });
  return order;
}

export const Search: React.FC<SearchProps> = ({ initialQuery = "", onOpenFolio }) => {
  const titleId = useId();
  const [query, setQuery] = useState<string>(initialQuery);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [hits, setHits] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [settledQuery, setSettledQuery] = useState<string>("");
  const [resultSet, setResultSet] = useState<number>(0);
  const [selectedHitIndex, setSelectedHitIndex] = useState<number>(0);
  const [focused, setFocused] = useState<boolean>(false);

  const [selectedAgent, setSelectedAgent] = useState<string>("");
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [datePreset, setDatePreset] = useState<DatePreset>("any");

  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // The agent filter needs the agent list, which reads agent folders: skipped without access.
  const { granted } = useAccess();
  useEffect(() => {
    if (!granted) return;
    let active = true;
    agents_list()
      .then((list) => {
        if (active) setAgents(list);
      })
      .catch(() => {
        // consent_required or a core error: the filter simply lists no agents
      });
    return () => {
      active = false;
    };
  }, [granted]);

  // "/" focuses the box; Escape clears it while it is focused.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement !== searchInputRef.current) {
        const t = e.target;
        const editable =
          t instanceof HTMLInputElement ||
          t instanceof HTMLTextAreaElement ||
          t instanceof HTMLSelectElement ||
          (t instanceof HTMLElement && t.isContentEditable);
        if (!editable) {
          e.preventDefault();
          searchInputRef.current?.focus();
        }
      } else if (e.key === "Escape" && document.activeElement === searchInputRef.current) {
        setQuery("");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Run the search whenever the query or a filter changes.
  useEffect(() => {
    let active = true;

    if (!query.trim()) {
      setHits([]);
      setSettledQuery("");
      setLoading(false);
      return;
    }

    setLoading(true);

    const filter: SearchFilter = { limit: HIT_LIMIT };
    if (selectedAgent) filter.agent = selectedAgent;
    if (selectedProject) filter.project = selectedProject;
    const range = dateRangeFor(datePreset, appNow());
    if (range.from !== undefined) filter.from = range.from;
    if (range.to !== undefined) filter.to = range.to;

    search(query, filter)
      .then((results) => {
        if (!active) return;
        setHits(results);
        setSettledQuery(query);
        setResultSet((n) => n + 1);
        setSelectedHitIndex(0);
        setLoading(false);
      })
      .catch(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [query, selectedAgent, selectedProject, datePreset]);

  const projectOptions = useProjectRoots();
  const groups = useMemo(() => groupHits(hits), [hits]);

  const familyOf = (agentId?: string): AgentFamily => {
    const family = agents.find((ag) => ag.id === agentId)?.family as AgentFamily | undefined;
    if (family && AGENT_FAMILIES.includes(family)) return family;
    if (!agentId) return "other";
    if (agentId.includes("claude")) return "anthropic";
    if (agentId.includes("codex")) return "openai";
    if (agentId.includes("gemini")) return "google";
    if (agentId.includes("cursor")) return "cursor";
    return "other";
  };

  const focusHit = (index: number) => {
    setSelectedHitIndex(index);
    listRef.current?.querySelector<HTMLElement>(`[data-hit-index="${index}"]`)?.focus();
  };

  const onHitKeyDown = (e: React.KeyboardEvent<HTMLElement>, index: number) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusHit(Math.min(hits.length - 1, index + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusHit(Math.max(0, index - 1));
    }
  };

  const open = (hit: SearchResult, index: number) => {
    setSelectedHitIndex(index);
    onOpenFolio?.(hit.session_id, hit.seq);
  };

  const hasQuery = query.trim().length > 0;
  const showHints = !query || !focused;
  const agentOptions = [
    { value: "", label: "All agents" },
    ...agents.map((a) => ({ value: a.id, label: a.name })),
  ];
  const projectSelectOptions = [
    { value: "", label: "All projects" },
    ...projectOptions.map((p) => ({ value: p.root, label: p.name })),
  ];

  return (
    <section className="view search-view" aria-labelledby={titleId}>
      <header className="view-head">
        <div>
          <p className="view-eyebrow">Archive</p>
          <h2 id={titleId} className="view-title">
            Search
          </h2>
          <p className="view-lede">One box over every prompt, reply, tool call and file path you have archived.</p>
        </div>
      </header>

      <div className="search-box-area">
        <div className={`search-box${showHints ? " search-box--hinted" : ""}`}>
          <span className="search-box__icon" aria-hidden="true">
            <SearchIcon size={22} />
          </span>
          <input
            ref={searchInputRef}
            type="search"
            role="searchbox"
            aria-label="Search the archive"
            className="search-box__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Prompts, replies, tool names, file paths"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="search-box__trailing">
            {query && (
              <IconButton
                aria-label="Clear search"
                className="search-box__clear"
                onClick={() => {
                  setQuery("");
                  searchInputRef.current?.focus();
                }}
              >
                <CloseIcon size={16} />
              </IconButton>
            )}
            {showHints && (
              <span className="search-hint" aria-hidden="true">
                <Kbd>/</Kbd> <span>to focus</span> <Kbd>Esc</Kbd> <span>to clear</span>
              </span>
            )}
          </span>
        </div>

        <div className="search-filters" role="group" aria-label="Narrow the search">
          <Select size="sm" hideLabel label="Agent" value={selectedAgent} onChange={setSelectedAgent} options={agentOptions} />
          <Select
            size="sm"
            hideLabel
            label="Project"
            value={selectedProject}
            onChange={setSelectedProject}
            options={projectSelectOptions}
          />
          <Select
            size="sm"
            hideLabel
            label="Date"
            value={datePreset}
            onChange={(v) => setDatePreset(v as DatePreset)}
            options={DATE_OPTIONS}
          />
        </div>
      </div>

      <div className="search-results" aria-busy={loading} ref={listRef}>
        <p className="search-status" role="status" aria-live="polite">
          {loading
            ? "Searching"
            : hasQuery && hits.length > 0
              ? `${plural(hits.length, "hit", "hits")} in ${plural(groups.length, "session", "sessions")}${
                  hits.length >= HIT_LIMIT ? `. Showing the first ${HIT_LIMIT}` : ""
                }`
              : ""}
        </p>

        {!hasQuery && (
          <div className="search-empty search-empty--initial">
            <span className="search-empty__icon" aria-hidden="true">
              <SearchIcon size={40} />
            </span>
            <p className="search-empty__line">Search every session you have archived.</p>
            <p className="search-empty__tips">Try a file name, an error message or a tool name.</p>
          </div>
        )}

        {hasQuery && !loading && hits.length === 0 && settledQuery === query && (
          <div className="search-empty">
            <p className="search-empty__line">Nothing matches</p>
            <p className="search-empty__tips">
              <code className="search-empty__query">{query}</code>
            </p>
          </div>
        )}

        {hasQuery && hits.length > 0 &&
          groups.map((group) => {
            const project = group.projectRoot ? getProjectBasename(group.projectRoot) : null;
            const date = formatSessionDate(group.startedAt);
            return (
              <section key={group.sessionId} className="search-group" data-testid="search-group">
                <header className="search-group__head">
                  <span
                    className="search-group__glyph"
                    data-testid="group-glyph"
                    style={{ color: `var(--family-${familyOf(group.agentId)})` }}
                  >
                    <AgentGlyph family={familyOf(group.agentId)} size={16} />
                  </span>
                  <h3 className="search-group__title">{group.title}</h3>
                  {project && <span className="search-group__meta">{project}</span>}
                  {date && <span className="search-group__meta">{date}</span>}
                  <span className="search-group__count" data-testid="group-count">
                    {plural(group.hits.length, "hit", "hits")}
                  </span>
                </header>
                <ul className="search-hits">
                  {group.hits.map(({ hit, index }) => (
                    <li key={`${hit.message_id}-${hit.block_index}-${index}`} className="search-hits__row">
                      <button
                        type="button"
                        className="search-hit"
                        data-testid="search-hit-item"
                        data-hit-index={index}
                        data-session-id={hit.session_id}
                        data-seq={hit.seq}
                        data-agent={hit.agent_id}
                        tabIndex={selectedHitIndex === index ? 0 : -1}
                        onClick={() => open(hit, index)}
                        onFocus={() => setSelectedHitIndex(index)}
                        onKeyDown={(e) => onHitKeyDown(e, index)}
                      >
                        <span
                          key={resultSet}
                          className="search-hit__glint"
                          aria-hidden="true"
                          style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}
                        />
                        <span className="search-hit__kind" data-testid="hit-kind">
                          {KIND_LABEL[hit.kind] ?? "Message"}
                        </span>
                        <span className="search-hit__snippet" data-testid="hit-snippet">
                          <Snippet text={hit.text} highlights={hit.highlights} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
      </div>
    </section>
  );
};
