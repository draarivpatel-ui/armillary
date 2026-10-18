import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArmillaryMark,
  DayIcon,
  Gallery,
  Mark,
  NightIcon,
  ReplayIcon,
  SegmentedControl,
  ViewIcon,
  type ViewIconName,
} from "@orrery/design";
import { OrreryView } from "./views/OrreryView";
import { AlmanacView } from "./views/AlmanacView";
import { FolioView } from "./views/FolioView";
import { FieldGuideView } from "./views/FieldGuideView";
import { SwitchboardView } from "./views/SwitchboardView";
import { LaunchpadView } from "./views/LaunchpadView";
import { SearchView } from "./views/SearchView";
import { NavigationProvider, useNavigationController } from "./navigation";
import { AccessProvider, NoAccessNotice } from "./access";

export type ViewKey =
  | "orrery"
  | "almanac"
  | "folio"
  | "field-guide"
  | "switchboard"
  | "launchpad"
  | "search";

export type Theme = "dark" | "light";

interface RailItem {
  key: ViewKey;
  label: string;
  shortcut: string;
}

const RAIL_ITEMS: RailItem[] = [
  { key: "orrery", label: "Orrery", shortcut: "1" },
  { key: "almanac", label: "Almanac", shortcut: "2" },
  { key: "folio", label: "Folio", shortcut: "3" },
  { key: "field-guide", label: "Field Guide", shortcut: "4" },
  { key: "switchboard", label: "Switchboard", shortcut: "5" },
  { key: "launchpad", label: "Launchpad", shortcut: "6" },
  { key: "search", label: "Search", shortcut: "7" },
];

const THEME_KEY = "armillary.theme";
const MOTION_MS = 220;
const EASE = "cubic-bezier(0.25, 0.1, 0.25, 1)";

/**
 * Shell seams for other streams:
 * - onReplayFirstRun: supplied by the first-run gate (FR, app/src/main.tsx); the rail shows
 *   "Replay the first run" only when it is provided.
 * - sampleData: true when the app runs on the presentation snapshot (INT's flag); the rail shows a
 *   small "Sample data" mark. The web build also honours ?presentation=1.
 */
export interface AppProps {
  onReplayFirstRun?: () => void;
  sampleData?: boolean;
  /**
   * False after "Not now" on the first-run screen: the views that read agent folders (Orrery,
   * Field Guide, Switchboard, Launchpad) show the not-given-access state and call nothing.
   * Defaults to true (no core: the views show mock data and read nothing).
   */
  accessGranted?: boolean;
  /** Delete archive and reset (R2-REV-3): supplied by the first-run gate. Rejects with the reason. */
  onDeleteArchive?: () => Promise<void>;
}

/** The views whose commands read agent folders or the process table. */
const NEEDS_ACCESS: Partial<Record<ViewKey, string>> = {
  orrery: "the Orrery",
  "field-guide": "the Field Guide",
  switchboard: "the Switchboard",
  launchpad: "the Launchpad",
};

function DeleteArchiveDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}): React.ReactElement {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  const confirm = () => {
    setBusy(true);
    setError(null);
    onConfirm().catch((err: unknown) => {
      setBusy(false);
      const message = err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : String(err);
      const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
      // The core emptied the archive but could not remove a later file (V-REG-10).
      setError(code === "partly_deleted" ? `Partly deleted: ${message}` : `The archive was not deleted: ${message}`);
    });
  };
  return (
    <div className="delete-confirm__scrim">
      <div
        className="delete-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-confirm-title"
        aria-describedby="delete-confirm-body"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) onCancel();
        }}
      >
        <h2 id="delete-confirm-title" className="delete-confirm__title">
          Delete the archive?
        </h2>
        <p id="delete-confirm-body" className="delete-confirm__body">
          This deletes every session Armillary has copied (also any copies kept by "Move it aside"), its
          search index, the first-run choice and the app's settings on this Mac, then shows the
          first-run screen again. Your agents' own files
          are not touched. This cannot be undone.
        </p>
        {error ? (
          <p className="delete-confirm__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="delete-confirm__actions">
          <button ref={cancelRef} type="button" className="obs-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="obs-button obs-button--destructive" onClick={confirm} disabled={busy}>
            Delete archive
          </button>
        </div>
      </div>
    </div>
  );
}

function queryParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(name);
}

function initialTheme(): Theme {
  const fromQuery = queryParam("theme");
  if (fromQuery === "light" || fromQuery === "dark") return fromQuery;
  try {
    const stored = window.localStorage?.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // storage may be unavailable; fall through to the default
  }
  return "dark";
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement;
}

export const App: React.FC<AppProps> = ({ onReplayFirstRun, sampleData, accessGranted = true, onDeleteArchive }) => {
  const [active, setActive] = useState<ViewKey>("orrery");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [leaving, setLeaving] = useState<ViewKey | null>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const showSample = Boolean(sampleData) || queryParam("presentation") === "1";
  const isDev = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
  const showGallery = isDev && queryParam("gallery") === "1";

  const navRef = useRef<HTMLElement | null>(null);
  const markerRef = useRef<HTMLSpanElement | null>(null);
  const enteringRef = useRef<HTMLDivElement | null>(null);
  const leavingRef = useRef<HTMLDivElement | null>(null);
  const groundRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      window.localStorage?.setItem(THEME_KEY, theme);
    } catch {
      // ignore storage failures
    }
  }, [theme]);

  const activeRef = useRef<ViewKey>(active);
  const go = useCallback((next: ViewKey) => {
    const current = activeRef.current;
    if (current === next) return;
    activeRef.current = next;
    setLeaving(current);
    setActive(next);
  }, []);

  // Search, the Almanac and the Orrery open sessions in the Folio through this (INT).
  const nav = useNavigationController(active, go);

  // Rail shortcuts 1 to 7.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
      const item = RAIL_ITEMS.find((r) => r.shortcut === e.key);
      if (item) go(item.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  // The gilt marker: one element, positioned from the active item's measured box, so it slides.
  useLayoutEffect(() => {
    const nav = navRef.current;
    const marker = markerRef.current;
    if (!nav || !marker) return;
    const place = () => {
      const button = nav.querySelector<HTMLElement>(`[data-view-key="${active}"]`);
      if (!button) return;
      marker.style.transform = `translateY(${button.offsetTop}px)`;
      marker.style.height = `${button.offsetHeight}px`;
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(place);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [active]);

  // View change: cross-fade with a slight parallax on the document timeline (Web Animations API).
  useLayoutEffect(() => {
    if (!leaving) return;
    const enter = enteringRef.current;
    const exit = leavingRef.current;
    const ground = groundRef.current;
    if (!enter || typeof enter.animate !== "function") {
      setLeaving(null);
      return;
    }
    const reduced = prefersReducedMotion();
    const travel = reduced ? 0 : 10;
    const deco = reduced ? 0 : 3;
    const timing = { duration: MOTION_MS, easing: EASE, fill: "both" as FillMode };
    const animations: Animation[] = [
      enter.animate(
        [
          { opacity: 0, transform: `translateY(${travel}px)` },
          { opacity: 1, transform: "translateY(0)" },
        ],
        timing,
      ),
    ];
    if (exit && typeof exit.animate === "function") {
      animations.push(
        exit.animate(
          [
            { opacity: 1, transform: "translateY(0)" },
            { opacity: 0, transform: `translateY(${-travel * 0.6}px)` },
          ],
          { ...timing, duration: Math.round(MOTION_MS * 0.8) },
        ),
      );
    }
    if (ground && typeof ground.animate === "function" && deco) {
      animations.push(
        ground.animate(
          [{ transform: `translateY(${deco}px)` }, { transform: "translateY(0)" }],
          timing,
        ),
      );
    }
    let cancelled = false;
    Promise.all(animations.map((a) => a.finished))
      .then(() => {
        if (!cancelled) setLeaving(null);
      })
      .catch(() => {
        // a newer view change cancelled these animations; that change cleans up
      });
    return () => {
      cancelled = true;
      for (const a of animations) a.cancel();
    };
  }, [active, leaving]);

  const renderView = (key: ViewKey) => {
    const needs = NEEDS_ACCESS[key];
    if (needs && !accessGranted) return <NoAccessNotice what={needs} />;
    switch (key) {
      case "orrery":
        return <OrreryView />;
      case "almanac":
        return <AlmanacView onOpenSession={(id) => nav.openSession(id)} />;
      case "folio":
        return <FolioView />;
      case "field-guide":
        return <FieldGuideView />;
      case "switchboard":
        return <SwitchboardView />;
      case "launchpad":
        return <LaunchpadView />;
      case "search":
        return <SearchView onOpenFolio={(id, seq) => nav.openSession(id, { seq })} />;
    }
  };

  const layers: ViewKey[] = leaving && leaving !== active ? [leaving, active] : [active];

  return (
    <div className="app-shell">
      <aside className="rail">
        <div className="rail__brand">
          <ArmillaryMark size={34} className="rail__mark" />
          <div className="rail__brand-text">
            <h1 className="rail__wordmark">Armillary</h1>
            <p className="rail__tagline">Observatory</p>
          </div>
        </div>

        <div className="rail__rule" aria-hidden="true" />

        <nav ref={navRef} className="rail__nav" aria-label="Observatory Views">
          <span
            ref={markerRef}
            className="rail__marker"
            data-rail-marker=""
            data-active-view={active}
            aria-hidden="true"
          />
          {RAIL_ITEMS.map((item) => {
            const isActive = item.key === active;
            return (
              <button
                key={item.key}
                type="button"
                data-view-key={item.key}
                className={`rail-item${isActive ? " rail-item--active" : ""}`}
                onClick={() => go(item.key)}
                aria-current={isActive ? "page" : undefined}
                aria-keyshortcuts={item.shortcut}
              >
                <ViewIcon name={item.key as ViewIconName} size={20} className="rail-item__icon" />
                <span className="rail-item__label">{item.label}</span>
                <span className="rail-item__key" aria-hidden="true">{item.shortcut}</span>
              </button>
            );
          })}
        </nav>

        <div className="rail__foot">
          {showSample && (
            <Mark tone="gilt" shape="diamond" className="rail__sample" title="This window shows the fictional sample archive, not data from this machine">
              Sample data
            </Mark>
          )}
          <SegmentedControl<Theme>
            label="Theme"
            size="sm"
            className="rail__theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: "dark", label: "Night", icon: <NightIcon size={14} /> },
              { value: "light", label: "Day almanac", icon: <DayIcon size={14} /> },
            ]}
          />
          {onDeleteArchive ? (
            <button type="button" className="rail__replay rail__delete" onClick={() => setConfirmDelete(true)}>
              <span>Delete archive and reset</span>
            </button>
          ) : null}
          <div className="rail__meta">
            {onReplayFirstRun ? (
              <button type="button" className="rail__replay" onClick={onReplayFirstRun}>
                <ReplayIcon size={14} />
                <span>Replay the first run</span>
              </button>
            ) : (
              <span />
            )}
            <span className="rail__version">v0.1.0</span>
          </div>
        </div>
      </aside>

      {confirmDelete && onDeleteArchive ? (
        <DeleteArchiveDialog onCancel={() => setConfirmDelete(false)} onConfirm={onDeleteArchive} />
      ) : null}
      <AccessProvider value={{ granted: accessGranted, review: onReplayFirstRun }}>
      <NavigationProvider value={nav}>
      <main className="stage">
        <div ref={groundRef} className="stage__ground" aria-hidden="true" />
        {showGallery ? (
          <div className="view-layer" data-gallery-stage="">
            <Gallery theme={theme} onThemeChange={setTheme} showThemeSwitcher={true} />
          </div>
        ) : (
          layers.map((key) => {
            const isLeaving = key !== active;
            return (
              <div
                key={key}
                ref={isLeaving ? leavingRef : enteringRef}
                className={`view-layer${isLeaving ? " view-layer--leaving" : ""}`}
                data-view={key}
                aria-hidden={isLeaving ? true : undefined}
                inert={isLeaving ? true : undefined}
              >
                {renderView(key)}
              </div>
            );
          })
        )}
      </main>
      </NavigationProvider>
      </AccessProvider>
    </div>
  );
};
