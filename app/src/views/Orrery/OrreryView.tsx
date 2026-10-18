import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AgentGlyph,
  ArmillaryMark,
  Button,
  CloseIcon,
  Figure,
  FigureGroup,
  IconButton,
  Kbd,
  Mark,
  type AgentFamily,
} from "@orrery/design";
import { OrreryView as CanvasOrrery, Session, type Orrery as OrreryController, type OrreryLayout } from "@orrery/orrery";
import { fetchLiveList, getMockLiveList, watchLiveModel, LiveListResult } from "../../api/live";
import { appNow, dataMode, isCoreAvailable } from "../../api/client";
import { useNavigation } from "../../navigation";
import "./orrery-view.css";
import { NO_ACCESS, NoAccessNotice, isConsentRequired } from "../../access";

const EMPTY_MODEL: LiveListResult = {
  projects: [],
  sessions: [],
  telemetry: { activePlanets: 0, needsYou: 0, working: 0, idle: 0, done: 0, unknown: 0 },
};

/** The Orrery's family names to the design system's (same symbols, different keys). */
const FAMILY: Record<string, AgentFamily> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  github: "github-microsoft",
  cursor: "cursor",
  "open-source": "open-source-clis",
  chinese: "chinese-labs",
  other: "other",
};

type Locate = (sessionId: string) => DOMRect | null;

/** What the stage element carries for the first-run handoff (FR): the live layout and the host clock. */
export interface OrreryStageHandle {
  getLayout(): OrreryLayout;
  layoutAt(t: number): OrreryLayout;
  now(): number;
}
type StageElement = HTMLDivElement & { __armillaryOrrery?: OrreryStageHandle };
type TourWindow = Window & {
  __armillaryTour?: { registerLocator?: (kind: string, fn: Locate) => () => void };
  __armillaryLocators?: Record<string, Locate | undefined>;
};

const STATE_MARK: Record<string, { tone: "alert" | "gilt" | "success" | "neutral"; label: string; shape: "dot" | "ring" }> = {
  waiting: { tone: "alert", label: "Needs you", shape: "dot" },
  working: { tone: "gilt", label: "Working", shape: "dot" },
  idle: { tone: "neutral", label: "Idle", shape: "dot" },
  done: { tone: "success", label: "Done", shape: "dot" },
};

export const OrreryView: React.FC = () => {
  const [liveData, setLiveData] = useState<LiveListResult>(() => (isCoreAvailable() ? EMPTY_MODEL : getMockLiveList()));
  const navigation = useNavigation();
  // "Needs you for Nm" counts from this wall time: the real clock, or the snapshot's reference time.
  const [wallEpochMs] = useState<number>(() => appNow());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({ width: 1000, height: 560 });
  const [currentTheme, setCurrentTheme] = useState<"dark" | "light">("dark");
  const stageRef = useRef<HTMLDivElement | null>(null);
  const unregisterLocator = useRef<(() => void) | null>(null);
  const mode = dataMode();

  // Live data from the typed client (INT): the first list, then live:update.
  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | null = null;
    fetchLiveList()
      .then((res) => {
        if (mounted) setLiveData(res);
      })
      .catch((err: unknown) => {
        if (mounted) setLoadError(isConsentRequired(err) ? NO_ACCESS : err instanceof Error ? err.message : String(err));
      });
    watchLiveModel((model) => {
      if (mounted) {
        setLiveData(model);
        setLoadError(null);
      }
    }).then(
      (off) => {
        if (mounted) unsubscribe = off;
        else off();
      },
      () => {},
    );
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  // Follow the document theme.
  useEffect(() => {
    const updateTheme = () => {
      setCurrentTheme(document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
    };
    updateTheme();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  // The canvas takes the stage's measured size.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateSize = () => {
      const rect = stage.getBoundingClientRect();
      setDimensions({
        width: Math.max(480, Math.floor(rect.width || 1000)),
        height: Math.max(360, Math.floor(rect.height || 560)),
      });
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(updateSize);
    ro.observe(stage);
    return () => ro.disconnect();
  }, []);

  // The demo tour aims its cursor at planets: register a locator with the presentation bridge.
  const onLocator = useCallback((locate: Locate | null) => {
    unregisterLocator.current?.();
    unregisterLocator.current = null;
    if (!locate || typeof window === "undefined") return;
    const w = window as TourWindow;
    if (typeof w.__armillaryTour?.registerLocator === "function") {
      unregisterLocator.current = w.__armillaryTour.registerLocator("planet", locate);
      return;
    }
    const map = (w.__armillaryLocators ??= {});
    map.planet = locate;
    unregisterLocator.current = () => {
      if (map.planet === locate) delete map.planet;
    };
  }, []);

  useEffect(
    () => () => {
      unregisterLocator.current?.();
      unregisterLocator.current = null;
    },
    [],
  );

  // The first run's handoff measures the stage and lands on the live layout: expose it on the element.
  const handleStage = useRef<StageElement | null>(null);
  const onReady = useCallback((orrery: OrreryController | null) => {
    if (!orrery) {
      if (handleStage.current) delete handleStage.current.__armillaryOrrery;
      handleStage.current = null;
      return;
    }
    const stage = stageRef.current as StageElement | null;
    if (!stage) return;
    const handle: OrreryStageHandle = {
      getLayout: () => orrery.getLayout(),
      layoutAt: (t: number) => orrery.layoutAt(t),
      now: () => orrery.now(),
    };
    stage.__armillaryOrrery = handle;
    handleStage.current = stage;
    stage.dispatchEvent(new CustomEvent("orrery:ready", { bubbles: true, detail: handle }));
  }, []);

  const projects = liveData?.projects || [];
  const sessions = liveData?.sessions || [];
  const telemetry = liveData?.telemetry || EMPTY_MODEL.telemetry;
  const selectedProject = selectedSession
    ? projects.find((p) => selectedSession.project_root === p.root)?.name
    : undefined;
  const selectedMark = selectedSession
    ? STATE_MARK[selectedSession.state] ?? { tone: "neutral" as const, label: "State unknown", shape: "ring" as const }
    : null;

  const OrreryCanvas = CanvasOrrery as unknown as React.ComponentType<{
    projects: unknown[];
    sessions: unknown[];
    width?: number;
    height?: number;
    theme?: "dark" | "light";
    reducedMotion?: boolean;
    wallEpochMs?: number;
    onSelectSession?: (sess: Session) => void;
    onLocator?: (locate: Locate | null) => void;
    onReady?: (orrery: OrreryController | null) => void;
    style?: React.CSSProperties;
  }>;
  if (loadError === NO_ACCESS) return <NoAccessNotice what="the Orrery" />;


  return (
    <section className="view view--orrery" aria-labelledby="orrery-title">
      <header className="view-head">
        <div>
          <p className="view-eyebrow">Live</p>
          <h2 id="orrery-title" className="view-title">The Orrery</h2>
          <p className="view-lede">Sessions running now, each circling the project it works in.</p>
        </div>
        <div className="orrery-head__aside">
          {mode === "mock" && (
            <Mark tone="neutral" shape="ring" title="No archive is connected in this window; these sessions are examples">
              Demo data
            </Mark>
          )}
          <FigureGroup className="view-figures" aria-label="Live sessions">
            <Figure value={telemetry.needsYou} label={telemetry.needsYou === 1 ? "needs you" : "need you"} tone={telemetry.needsYou > 0 ? "alert" : "default"} />
            <Figure value={telemetry.working} label="working" />
            <Figure value={sessions.length} label={sessions.length === 1 ? "session" : "sessions"} />
          </FigureGroup>
        </div>
      </header>

      <div className="orrery-stage" data-orrery-stage="" ref={stageRef}>
        {projects.length > 0 ? (
          <OrreryCanvas
            projects={projects}
            sessions={sessions}
            width={dimensions.width}
            height={dimensions.height}
            theme={currentTheme}
            wallEpochMs={wallEpochMs}
            onSelectSession={(sess) => setSelectedSession(sess)}
            onLocator={onLocator}
            onReady={onReady}
            style={{ width: "100%", height: "100%" }}
          />
        ) : (
          <div className="orrery-empty">
            <ArmillaryMark size={56} className="orrery-empty__mark" />
            <p className="orrery-empty__title">No agent is running right now.</p>
            <p className="orrery-empty__body">
              Sessions appear here while an agent works. Finished ones settle into the Almanac.
            </p>
          </div>
        )}
      </div>

      {loadError && (
        <p className="orrery-error" role="alert">
          <Mark tone="alert" emphasis>Could not load live sessions</Mark>
          <span>{loadError}</span>
        </p>
      )}

      {selectedSession && selectedMark ? (
        <div className="orrery-selection" aria-live="polite">
          <AgentGlyph
            family={FAMILY[selectedSession.family] ?? "other"}
            size={24}
            className="orrery-selection__glyph"
            style={{ color: `var(--family-${FAMILY[selectedSession.family] ?? "other"})` }}
          />
          <div className="orrery-selection__text">
            <p className="orrery-selection__eyebrow">Selected session</p>
            <p className="orrery-selection__title">{selectedSession.title}</p>
            <p className="orrery-selection__meta">
              {[
                selectedSession.agent_id,
                selectedProject,
                // a live session that is not archived yet has unknown turns (0 only sizes its planet)
                (selectedSession as { archived?: boolean }).archived === false ? "turns unknown" : `${selectedSession.turns} turns`,
              ]
                .filter(Boolean)
                .join("  ·  ")}
            </p>
          </div>
          <Mark tone={selectedMark.tone} shape={selectedMark.shape} emphasis={selectedMark.tone === "alert"}>
            {selectedMark.label}
          </Mark>
          <Button variant="gilt" size="sm" onClick={() => navigation.openSession(selectedSession.id)}>
            Open in Folio
          </Button>
          <IconButton aria-label="Clear the selection" onClick={() => setSelectedSession(null)}>
            <CloseIcon size={14} />
          </IconButton>
        </div>
      ) : (
        <p className="orrery-legend" role="note" aria-label="How to read the Orrery">
          <span>Suns are projects, planets are live sessions in their agent's colour. A vermilion halo means it needs you.</span>
          <span className="orrery-legend__keys">
            <Kbd>{"\u2190"}</Kbd> <Kbd>{"\u2192"}</Kbd> <Kbd>{"\u2191"}</Kbd> <Kbd>{"\u2193"}</Kbd> move between planets, <Kbd>Enter</Kbd> opens one
          </span>
        </p>
      )}
    </section>
  );
};
