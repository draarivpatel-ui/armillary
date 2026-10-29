import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AgentGlyph,
  Button,
  Figure,
  FigureGroup,
  FilterChip,
  Mark,
  SegmentedControl,
  Select,
  type AgentFamily as GlyphFamily,
} from "@orrery/design";
import {
  sessionsQueryAll,
  formatTime,
  activitySpanLabel,
  sessionLabel,
  type Session,
  type SessionFilter,
} from "../../api/archive";
import { agents_list, type Agent } from "../../api/agents";
import { useProjectRoots } from "../../api/hooks";
import { useDisplayPath } from "../../api/paths";
import { calculateVariableRange, useScrollWindow } from "./useVirtualList";
import { DateRangePicker } from "./DateRangePicker";
import {
  buildDayLayout,
  fileBasename,
  formatSessionDuration,
  middleTruncate,
  rowHeight,
  touchedFilesOf,
  MAX_FILES,
  type DayGroup,
} from "./layout";
import { groupStatuses, rawStatusesIn, statusGroupOf, type StatusGroup } from "./status";
import "./Almanac.css";

/** Most sessions the Almanac loads in one go (the core pages by 200). */
const ALMANAC_MAX_SESSIONS = 20000;
/** Days staggered by index, at most this many steps. */
const MAX_STAGGER_STEPS = 8;
/** Pixels rendered above and below the viewport in the virtual list. */
const OVERSCAN_PX = 400;
/** More statuses than this become chips; this many or fewer become a segmented control. */
const SEGMENTED_MAX = 4;

export interface AlmanacProps {
  onOpenSession?: (sessionId: string) => void;
  virtualized?: boolean;
}

function familyOf(agentId: string, agents: Agent[]): GlyphFamily {
  const known = agents.find((a) => a.id === agentId)?.family;
  if (known) return known as GlyphFamily;
  if (agentId.includes("claude")) return "anthropic";
  if (agentId.includes("codex")) return "openai";
  if (agentId.includes("gemini")) return "google";
  if (agentId.includes("cursor")) return "cursor";
  return "other";
}

interface StatusMark {
  tone: "neutral" | "gilt" | "success" | "alert";
  shape: "dot" | "ring";
  text: string;
  emphasis: boolean;
}

function markForGroup(group: StatusGroup): StatusMark {
  switch (group.key) {
    case "open":
      return { tone: "gilt", shape: "dot", text: group.label, emphasis: true };
    case "needs":
      return { tone: "alert", shape: "dot", text: group.label, emphasis: true };
    case "finished":
      return { tone: "success", shape: "dot", text: group.label, emphasis: false };
    case "failed":
      return { tone: "alert", shape: "ring", text: group.label, emphasis: false };
    default:
      // Unknown and any other raw status: a neutral ring labelled with the group
      return { tone: "neutral", shape: "ring", text: group.label, emphasis: false };
  }
}

function durationText(session: Session): string {
  if (session.ended_at == null || !session.started_at || session.ended_at < session.started_at) {
    // No recorded end: say how long the recorded activity spans, never claim the session ended.
    const span = activitySpanLabel(session as Session & { first_activity_at?: number | null; last_activity_at?: number | null });
    if (span) return span;
    if (!session.started_at) return "duration unknown";
    return statusGroupOf(session.status).key === "open" ? "in progress" : "duration unknown";
  }
  return formatSessionDuration(session.ended_at - session.started_at);
}

function startText(session: Session): string {
  return session.started_at ? formatTime(session.started_at) : "time unknown";
}

interface SessionRowProps {
  session: Session;
  family: GlyphFamily;
  tabbable: boolean;
  onOpen: (id: string) => void;
  onMove: (id: string, key: string) => void;
}

const SessionRow = memo(function SessionRow({ session, family, tabbable, onOpen, onMove }: SessionRowProps) {
  const group = statusGroupOf(session.status);
  const mark = markForGroup(group);
  const files = touchedFilesOf(session);
  const shown = files.slice(0, MAX_FILES);
  const more = files.length - shown.length;
  const turns = session.turns === 1 ? "1 turn" : `${session.turns} turns`;

  return (
    <li className="almanac-row-item" style={{ height: rowHeight(session) }}>
      <button
        type="button"
        className="almanac-row"
        data-testid="almanac-session-item"
        data-session-id={session.id}
        data-agent={session.agent_id}
        data-status={session.status}
        data-status-group={group.key}
        tabIndex={tabbable ? 0 : -1}
        onClick={() => onOpen(session.id)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
            e.preventDefault();
            onMove(session.id, e.key);
          }
        }}
      >
        <span className="almanac-row__glyph" data-testid="agent-glyph" style={{ color: `var(--family-${family})` }}>
          <AgentGlyph family={family} size={16} />
        </span>
        <span className="almanac-row__main">
          <span className="almanac-row__title">{sessionLabel(session as Session & { display_title?: string | null })}</span>
          <span className="almanac-row__meta">
            <span>{startText(session)}</span>
            <span className="almanac-row__sep" aria-hidden="true">
              ·
            </span>
            <span data-testid="session-duration">{durationText(session)}</span>
            <span className="almanac-row__sep" aria-hidden="true">
              ·
            </span>
            <span>{turns}</span>
            <span className="almanac-row__sep" aria-hidden="true">
              ·
            </span>
            <span className="almanac-row__model">{session.model || "model unknown"}</span>
          </span>
          {files.length > 0 && (
            <span className="almanac-row__files" title={files.join("\n")}>
              {shown.map((f) => (
                <span key={f} className="almanac-row__file">
                  {fileBasename(f)}
                </span>
              ))}
              {more > 0 && <span className="almanac-row__more">+{more} more</span>}
            </span>
          )}
        </span>
        <span className="almanac-row__status">
          <Mark tone={mark.tone} shape={mark.shape} emphasis={mark.emphasis}>
            {mark.text}
          </Mark>
        </span>
      </button>
    </li>
  );
});

interface DaySectionProps {
  day: DayGroup;
  /** Position in the list, or null when the day was mounted by scrolling (no delay). */
  staggerIndex: number | null;
  agents: Agent[];
  tabbableId: string | null;
  onOpen: (id: string) => void;
  onMove: (id: string, key: string) => void;
}

function dayHeading(day: DayGroup) {
  if (!day.dated) {
    return { label: "Undated", numeral: "Undated", weekday: null, month: "no start time recorded" };
  }
  const d = new Date(day.dayStartMs);
  return {
    label: d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
    numeral: String(d.getDate()),
    weekday: d.toLocaleDateString("en-US", { weekday: "long" }),
    month: d.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
  };
}

const DaySection = memo(function DaySection({
  day,
  staggerIndex,
  agents,
  tabbableId,
  onOpen,
  onMove,
}: DaySectionProps) {
  const displayPath = useDisplayPath();
  // The delay is fixed when the section mounts: a day that scrolls into view later must not wait.
  const [stagger] = useState(staggerIndex);
  const heading = dayHeading(day);
  const style = {
    height: day.height,
    ...(stagger !== null ? { "--almanac-stagger": stagger } : {}),
  } as React.CSSProperties;

  return (
    <div
      className="almanac-day"
      data-testid="almanac-day"
      data-day-key={day.key}
      data-stagger-index={stagger !== null ? stagger : undefined}
      style={style}
    >
      <h3 className="almanac-day__date" aria-label={heading.label}>
        <span className={day.dated ? "almanac-day__numeral" : "almanac-day__numeral almanac-day__numeral--undated"}>
          {heading.numeral}
        </span>
        {heading.weekday && <span className="almanac-day__weekday">{heading.weekday}</span>}
        <span className="almanac-day__month">{heading.month}</span>
      </h3>

      <div className="almanac-day__sessions">
        {day.projects.map((project) => (
          <section
            key={project.key}
            className="almanac-project"
            data-testid="almanac-project-group"
            style={{ height: project.height }}
          >
            <div className="almanac-project__head">
              <h4 className="almanac-project__name">{project.name}</h4>
              {project.root && (
                <span className="almanac-project__path" title={displayPath(project.root)}>
                  {middleTruncate(displayPath(project.root))}
                </span>
              )}
            </div>
            <ul className="almanac-rows">
              {project.sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  family={familyOf(session.agent_id, agents)}
                  tabbable={session.id === tabbableId}
                  onOpen={onOpen}
                  onMove={onMove}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
});

export const Almanac: React.FC<AlmanacProps> = ({ onOpenSession, virtualized = false }) => {
  /** What the server returned for the server-side filters (before the status group is applied). */
  const [fetched, setFetched] = useState<Session[]>([]);
  /** How many sessions the archive matches for the server-side filters, loaded or not. */
  const [archiveTotal, setArchiveTotal] = useState<number>(0);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [loaded, setLoaded] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [knownStatuses, setKnownStatuses] = useState<string[]>([]);
  const [knownModels, setKnownModels] = useState<string[]>([]);
  /** Bumped when a load lands, so the days mount afresh and stagger in. */
  const [epoch, setEpoch] = useState(0);
  const projectRoots = useProjectRoots();

  // Filter state
  const [selectedAgent, setSelectedAgent] = useState<string>("");
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [selectedStatus, setSelectedStatus] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");

  const [activeId, setActiveId] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const scrolledRef = useRef(false);
  const pendingFocusRef = useRef<string | null>(null);

  const { scrollTop, viewportHeight, onScroll, syncFromElement } = useScrollWindow({
    containerRef,
    initialViewportHeight: 600,
  });

  // Load agents list once for the dropdown
  useEffect(() => {
    let active = true;
    agents_list().then((list) => {
      if (active) setAgents(list);
    });
    return () => {
      active = false;
    };
  }, []);

  // The status group becomes a server filter only when it is exactly one raw status in the data.
  // Several raw statuses are queried unfiltered and matched by group on the client.
  const serverStatus = useMemo(() => {
    if (!selectedStatus) return "";
    const raws = rawStatusesIn(selectedStatus, knownStatuses);
    return raws.length === 1 ? raws[0] : "";
  }, [selectedStatus, knownStatuses]);

  // Fetch sessions based on filters. selectedStatus is a dependency too, so every status change reloads
  // and resets the scroll like the other filters, even when the group needs no server filter.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);

    const filter: SessionFilter = {};

    if (selectedAgent) filter.agent = selectedAgent;
    if (selectedProject) filter.project = selectedProject;
    if (serverStatus) filter.status = serverStatus;
    if (selectedModel) filter.model = selectedModel;
    // The picker's YYYY-MM-DD days are local calendar days, like the day groups: local midnight
    // to the next local midnight (`new Date("YYYY-MM-DD")` would be UTC midnight).
    const localMidnight = (iso: string, addDays = 0) => {
      const [y, m, d] = iso.split("-").map(Number);
      return new Date(y, m - 1, d + addDays).getTime();
    };
    if (fromDate) {
      filter.from = localMidnight(fromDate);
    }
    if (toDate) {
      filter.to = localMidnight(toDate, 1) - 1;
    }

    sessionsQueryAll(filter, ALMANAC_MAX_SESSIONS)
      .then((res) => {
        if (!active) return;
        setFetched(res.items);
        // Known statuses come from the unfiltered page, so a group keeps its raw members while a filter is on.
        setKnownStatuses((prev) => {
          const next = new Set(prev);
          res.items.forEach((s) => next.add(s.status ?? ""));
          return next.size === prev.length ? prev : Array.from(next).sort();
        });
        setKnownModels((prev) => {
          const next = new Set(prev);
          res.items.forEach((s) => {
            if (s.model) next.add(s.model);
          });
          return next.size === prev.length ? prev : Array.from(next).sort();
        });
        setArchiveTotal(res.total);
        setLoading(false);
        setLoaded(true);
        // A fresh result starts at the top, and its first days stagger in.
        scrolledRef.current = false;
        const el = containerRef.current;
        if (el) {
          el.scrollTop = 0;
          syncFromElement();
        }
        setEpoch((e) => e + 1);
      })
      .catch((err: unknown) => {
        if (active) {
          setFetched([]);
          setArchiveTotal(0);
          setLoadError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [selectedAgent, selectedProject, selectedStatus, serverStatus, selectedModel, fromDate, toDate, syncFromElement]);

  // The sessions the view shows: the fetched ones in the selected status group
  const sessions = useMemo(
    () => (selectedStatus ? fetched.filter((s) => statusGroupOf(s.status).key === selectedStatus) : fetched),
    [fetched, selectedStatus],
  );
  // The archive holds more than was loaded (the view loads at most ALMANAC_MAX_SESSIONS)
  const truncated = archiveTotal > fetched.length;

  const statusGroupList = useMemo(() => groupStatuses(knownStatuses), [knownStatuses]);

  const modelOptions = useMemo(() => {
    const set = new Set(knownModels);
    if (selectedModel) set.add(selectedModel);
    return Array.from(set).sort();
  }, [knownModels, selectedModel]);

  // Counts per status group, summing the raw statuses in each. With a status filter on, only that group is counted.
  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (selectedStatus) {
      counts.set(selectedStatus, sessions.length);
      return counts;
    }
    fetched.forEach((s) => {
      const key = statusGroupOf(s.status).key;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return counts;
  }, [fetched, sessions.length, selectedStatus]);

  const layout = useMemo(() => buildDayLayout(sessions), [sessions]);

  // Virtual window over the day pages (their heights are exact, see layout.ts)
  const isVirtualMode = virtualized || sessions.length > 100;
  const range = useMemo(() => {
    if (!isVirtualMode) return null;
    return calculateVariableRange({
      tops: layout.days.map((d) => d.top),
      heights: layout.days.map((d) => d.height),
      viewportHeight,
      scrollTop,
      overscanPx: OVERSCAN_PX,
    });
  }, [isVirtualMode, layout, viewportHeight, scrollTop]);

  const startIndex = range ? range.startIndex : 0;
  const endIndex = range ? range.endIndex : layout.days.length;
  const visibleDays = useMemo(() => layout.days.slice(startIndex, endIndex), [layout, startIndex, endIndex]);

  // One row is in the tab order: the active one while it is on screen, else the first rendered
  const tabbableId = useMemo(() => {
    let first: string | null = null;
    for (const day of visibleDays) {
      for (const project of day.projects) {
        for (const s of project.sessions) {
          if (first === null) first = s.id;
          if (s.id === activeId) return s.id;
        }
      }
    }
    return first;
  }, [visibleDays, activeId]);

  const filtersActive = Boolean(
    selectedAgent || selectedProject || selectedStatus || selectedModel || fromDate || toDate,
  );

  // When nothing matches, the empty state carries the Clear filters button instead of the bar.
  const showEmpty = !loading && !loadError && sessions.length === 0;

  const handleResetFilters = () => {
    setSelectedAgent("");
    setSelectedProject("");
    setSelectedStatus("");
    setSelectedModel("");
    setFromDate("");
    setToDate("");
  };

  const handleOpen = useCallback(
    (id: string) => {
      setActiveId(id);
      if (onOpenSession) onOpenSession(id);
    },
    [onOpenSession],
  );

  const findRow = useCallback((id: string): HTMLElement | null => {
    const root = containerRef.current;
    if (!root) return null;
    const rows = root.querySelectorAll<HTMLElement>("[data-session-id]");
    for (const row of Array.from(rows)) {
      if (row.dataset.sessionId === id) return row;
    }
    return null;
  }, []);

  const handleMove = useCallback(
    (fromId: string, key: string) => {
      const order = layout.order;
      const index = order.indexOf(fromId);
      if (index === -1) return;
      let next = index;
      if (key === "ArrowDown") next = Math.min(order.length - 1, index + 1);
      else if (key === "ArrowUp") next = Math.max(0, index - 1);
      else if (key === "Home") next = 0;
      else if (key === "End") next = order.length - 1;
      const nextId = order[next];
      setActiveId(nextId);
      const el = findRow(nextId);
      if (el) {
        el.focus();
        return;
      }
      // The row is outside the rendered window: scroll to it, then focus it once it is drawn.
      pendingFocusRef.current = nextId;
      const container = containerRef.current;
      if (container) {
        container.scrollTop = Math.max(0, (layout.sessionTop.get(nextId) ?? 0) - 96);
        syncFromElement();
      }
    },
    [layout, findRow, syncFromElement],
  );

  useLayoutEffect(() => {
    const id = pendingFocusRef.current;
    if (!id) return;
    const el = findRow(id);
    if (el) {
      pendingFocusRef.current = null;
      el.focus();
    }
  });

  const statusOptionList = statusGroupList.map((group) => ({ value: group.key, label: group.label }));

  const handleScroll = (e: React.UIEvent<HTMLElement>) => {
    if (e.currentTarget.scrollTop > 0) scrolledRef.current = true;
    onScroll(e);
  };

  const sessionsLabel = truncated ? "sessions loaded" : "sessions";

  return (
    <section className="view almanac" aria-labelledby="almanac-title">
      <header className="view-head">
        <div>
          <p className="view-eyebrow">History</p>
          <h2 id="almanac-title" className="view-title">
            The Almanac
          </h2>
          <p className="view-lede">Every session with every agent, day by day.</p>
        </div>
        {loaded && !loadError && (
          <FigureGroup className="view-figures" aria-label="Summary">
            <Figure
              value={sessions.length.toLocaleString()}
              label={sessionsLabel}
              title={
                truncated
                  ? `${archiveTotal.toLocaleString()} match in the archive; the first ${fetched.length.toLocaleString()} are loaded`
                  : undefined
              }
            />
            <Figure value={layout.datedDayCount.toLocaleString()} label={layout.datedDayCount === 1 ? "day" : "days"} />
            <Figure
              value={layout.projectCount.toLocaleString()}
              label={layout.projectCount === 1 ? "project" : "projects"}
            />
          </FigureGroup>
        )}
      </header>

      <div className="almanac-filters" role="group" aria-label="Filters">
        <div className="almanac-filters__fields">
          <Select
            size="sm"
            hideLabel
            label="Agent"
            className="almanac-filter"
            value={selectedAgent}
            onChange={setSelectedAgent}
            options={[
              { value: "", label: "All agents" },
              ...agents.map((ag) => ({ value: ag.id, label: ag.name })),
            ]}
          />
          <Select
            size="sm"
            hideLabel
            label="Project"
            className="almanac-filter"
            value={selectedProject}
            onChange={setSelectedProject}
            options={[
              { value: "", label: "All projects" },
              ...projectRoots.map((proj) => ({ value: proj.root, label: proj.name })),
            ]}
          />
          <Select
            size="sm"
            hideLabel
            label="Model"
            className="almanac-filter"
            value={selectedModel}
            onChange={setSelectedModel}
            options={[{ value: "", label: "All models" }, ...modelOptions.map((m) => ({ value: m, label: m }))]}
          />
          <DateRangePicker
            from={fromDate}
            to={toDate}
            onChange={(newFrom, newTo) => {
              setFromDate(newFrom);
              setToDate(newTo);
            }}
            onClear={() => {
              setFromDate("");
              setToDate("");
            }}
          />
        </div>

        {statusOptionList.length > 0 &&
          (statusOptionList.length <= SEGMENTED_MAX ? (
            <SegmentedControl
              size="sm"
              label="Status"
              className="almanac-status"
              value={selectedStatus}
              onChange={setSelectedStatus}
              options={[{ value: "", label: "All" }, ...statusOptionList]}
            />
          ) : (
            <div className="almanac-status almanac-status--chips" role="group" aria-label="Status">
              {statusOptionList.map((opt) => (
                <FilterChip
                  key={opt.value}
                  label={opt.label}
                  count={statusCounts.get(opt.value)}
                  selected={selectedStatus === opt.value}
                  onToggle={(next) => setSelectedStatus(next ? opt.value : "")}
                />
              ))}
            </div>
          ))}

        {filtersActive && !showEmpty && (
          <Button size="sm" variant="ghost" className="almanac-clear" onClick={handleResetFilters}>
            Clear filters
          </Button>
        )}
      </div>

      <div
        className="almanac-days"
        data-testid="almanac-days-container"
        ref={containerRef}
        onScroll={handleScroll}
        aria-busy={loading}
      >
        {loading && (
          <p className="almanac-note" role="status">
            Loading sessions...
          </p>
        )}

        {loadError && (
          <p className="almanac-note almanac-note--error" role="alert">
            Could not load sessions: {loadError}
          </p>
        )}

        {showEmpty && (
          <div className="almanac-empty">
            <p className="almanac-empty__line">
              {filtersActive ? "No sessions match these filters." : "No sessions yet. Import some from the Field Guide."}
            </p>
            {filtersActive && (
              <Button size="sm" variant="ghost" onClick={handleResetFilters}>
                Clear filters
              </Button>
            )}
          </div>
        )}

        {!loading && sessions.length > 0 && (
          <div className="almanac-pages">
            <div style={{ height: range ? range.topSpacerHeight : 0 }} aria-hidden="true" />
            {visibleDays.map((day, i) => (
              <DaySection
                key={`${epoch}:${day.key}`}
                day={day}
                staggerIndex={scrolledRef.current ? null : Math.min(startIndex + i, MAX_STAGGER_STEPS)}
                agents={agents}
                tabbableId={tabbableId}
                onOpen={handleOpen}
                onMove={handleMove}
              />
            ))}
            <div style={{ height: range ? range.bottomSpacerHeight : 0 }} aria-hidden="true" />
          </div>
        )}
      </div>
    </section>
  );
};
