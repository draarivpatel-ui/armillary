import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FirstRun, RecordedSource } from "@orrery/firstrun";
import type { FirstRunResult, FirstRunSource, FirstRunStatus, HandoffTarget } from "@orrery/firstrun";
import { call, isCoreAvailable } from "../api/client";
import { fetchLiveList, type LiveListResult } from "../api/live";
import { TauriFirstRunSource, resetInCore, statusFromCore } from "./events";
import { firstRunForced, readLocalStatus, shouldShowFirstRun, writeLocalStatus } from "./status";
import { computeHandoffTarget, type OrreryStageHook } from "./target";

export interface FirstRunGateApi {
  replay: () => void;
  /** False after "Not now": the views that read agent folders show the not-given-access state. */
  accessGranted: boolean;
  /**
   * Delete archive and reset (R2-REV-3): the core stops its services, closes and deletes the archive
   * and firstrun.json; then local storage is cleared and the first-run plaque shows again. Rejects
   * (and changes nothing here) when the core could not delete.
   */
  deleteArchive: () => Promise<void>;
}

type Phase = "pending" | "running" | "done" | "broken";

const FRESH: FirstRunStatus = { consented: false, completed: false };

export function FirstRunGate({
  children,
}: {
  children: (api: FirstRunGateApi) => React.ReactNode;
  sampleData?: boolean;
}): React.ReactElement {
  const [phase, setPhase] = useState<Phase>("pending");
  const [runKey, setRunKey] = useState(0);
  const [appMounted, setAppMounted] = useState(false);
  // Without a core nothing real is read (mock data), so access is only ever withheld by the core.
  const [accessGranted, setAccessGranted] = useState(true);
  const [source, setSource] = useState<FirstRunSource | null>(null);
  const [fpsLog, setFpsLog] = useState<((line: string) => void) | undefined>(undefined);
  const appRef = useRef<HTMLDivElement | null>(null);
  const live = useRef<LiveListResult | null>(null);
  const orreryMountedAt = useRef<number | null>(null);

  const [archiveProblem, setArchiveProblem] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  // Decide once on mount (and again after a damaged archive is moved aside).
  const decide = useCallback(async (isCancelled: () => boolean = () => false) => {
    const forced = firstRunForced(window.location.search);
    // R2-REV-7: a damaged or newer archive is explained, not a failed launch. Asked alongside the status.
    const [health, status] = isCoreAvailable()
      ? await Promise.all([
          call<{ ok?: boolean; message?: string | null } | null>("archive_status").catch(() => null),
          statusFromCore().catch(() => ({ ...FRESH })),
        ])
      : [null, readLocalStatus()];
    if (isCancelled()) return;
    if (health && health.ok === false) {
      setArchiveProblem(health.message ?? "The archive could not be opened.");
      setPhase("broken");
      return;
    }
    if (isCoreAvailable()) setAccessGranted(status.consented);
    const show = shouldShowFirstRun({ forced, status });
    setAppMounted(!show);
    setPhase(show ? "running" : "done");
    return status;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void decide(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [decide]);

  const moveArchiveAside = useCallback(async () => {
    setMoveError(null);
    try {
      await call("archive_move_aside");
    } catch (err) {
      const message = err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : String(err);
      setMoveError(message);
      return;
    }
    setArchiveProblem(null);
    const status = await decide();
    // The launch skipped the services because the archive was broken; start them now if allowed.
    if (status?.consented && status.completed) await call("services_start").catch(() => {});
  }, [decide]);

  // Pick the source and the frame-time logging once the first run is going to show.
  const wantsFirstRun = phase === "running";
  useEffect(() => {
    if (!wantsFirstRun || source) return;
    let cancelled = false;
    // Captures over the presentation snapshot can ask for the recorded log (recorded by firstrun.rs over
    // the same synthetic dataset) while the app itself answers from the snapshot.
    const recorded = new URLSearchParams(window.location.search).get("firstrunSource") === "recorded";
    if (isCoreAvailable() && !recorded) {
      // Saying yes (or no) in the plaque is the moment access changes (V-REG-1): the app mounted
      // under the hand-over must already know it, or it paints "not given access" while it lands.
      class GateSource extends TauriFirstRunSource {
        async consent(accepted: boolean): Promise<void> {
          await super.consent(accepted);
          setAccessGranted(accepted);
        }
      }
      setSource(new GateSource());
      call<boolean>("firstrun_fps_enabled")
        .then((on) => {
          if (!cancelled && on === true) {
            setFpsLog(() => (line: string) => void call("firstrun_fps_report", { line }).catch(() => {}));
          }
        })
        .catch(() => {});
    } else {
      // No core: the recorded mock log (generated by the Rust scanner over the synthetic dataset).
      void import("@orrery/firstrun/src/data/mockEventLog.json").then((m) => {
        if (!cancelled) setSource(RecordedSource.fromJson(m.default));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [wantsFirstRun, source]);

  // The live model the Orrery will show, fetched once when the app mounts underneath.
  useEffect(() => {
    if (!appMounted || live.current || !accessGranted) return;
    void fetchLiveList().then(
      (res) => {
        live.current = res;
      },
      () => {},
    );
  }, [appMounted, accessGranted]);

  // The app underneath is hidden while the first run is up; onAppAlpha drives it directly.
  useLayoutEffect(() => {
    if (appRef.current) appRef.current.style.opacity = phase === "running" ? "0" : "1";
  }, [phase]);

  const observeOrrery = useCallback((): Element | null => {
    const stage = document.querySelector("[data-orrery-stage]");
    if (stage && orreryMountedAt.current === null && stage.querySelector("canvas")) {
      orreryMountedAt.current = performance.now();
    }
    return stage;
  }, []);

  const getTarget = useCallback(
    (msUntilLanding = 2950): HandoffTarget | null => {
      const stage = observeOrrery();
      if (!stage) return null;
      const rect = stage.getBoundingClientRect();
      const stageRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      const theme = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
      // Exact path: the Orrery exposes its own layout at any Orrery time.
      const hook = (stage as Element & { __armillaryOrrery?: OrreryStageHook }).__armillaryOrrery;
      if (hook) {
        return computeHandoffTarget({
          stageRect,
          projects: [],
          sessions: [],
          orreryElapsedMs: 0,
          theme,
          layout: hook.layoutAt(hook.now() + msUntilLanding),
        });
      }
      // Fallback: the same layout recomputed from the live model, with an estimated Orrery clock.
      if (!live.current) return null;
      const now = performance.now();
      return computeHandoffTarget({
        stageRect,
        projects: live.current.projects,
        sessions: live.current.sessions,
        orreryElapsedMs: now - (orreryMountedAt.current ?? now) + msUntilLanding,
        theme,
      });
    },
    [observeOrrery],
  );

  // The shell arrives with a deliberate move as the first run hands over: the stage is already in
  // place under the landing, then the rail slides in from the left and the view header settles down.
  const onAppAlpha = useCallback(
    (alpha: number) => {
      observeOrrery();
      const app = appRef.current;
      if (!app) return;
      app.style.opacity = String(alpha);
      const e = (k: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, k)), 3);
      const railK = e((alpha - 0.25) / 0.75);
      const headK = e((alpha - 0.4) / 0.6);
      const rail = app.querySelector<HTMLElement>(".rail");
      const head = app.querySelector<HTMLElement>(".view-head");
      if (rail) {
        rail.style.transform = railK >= 1 ? "" : `translate3d(${(-56 * (1 - railK)).toFixed(2)}px, 0, 0)`;
        rail.style.opacity = railK >= 1 ? "" : String(railK);
      }
      if (head) {
        head.style.transform = headK >= 1 ? "" : `translate3d(0, ${(-14 * (1 - headK)).toFixed(2)}px, 0)`;
        head.style.opacity = headK >= 1 ? "" : String(headK);
      }
    },
    [observeOrrery],
  );

  const onComplete = useCallback((result: FirstRunResult) => {
    for (const sel of [".rail", ".view-head"]) {
      const el = appRef.current?.querySelector<HTMLElement>(sel);
      if (el) {
        el.style.transform = "";
        el.style.opacity = "";
      }
    }
    if (!isCoreAvailable()) writeLocalStatus({ consented: !result.declined, completed: true });
    else setAccessGranted(!result.declined);
    setAppMounted(true);
    setPhase("done");
  }, []);

  const replay = useCallback(() => {
    const reset = isCoreAvailable() ? resetInCore().catch(() => {}) : Promise.resolve(writeLocalStatus({ completed: false }));
    void reset.then(() => {
      setRunKey((k) => k + 1);
      setPhase("running");
    });
  }, []);

  const deleteArchive = useCallback(async () => {
    // Errors propagate: the confirmation shows them and nothing here changes.
    if (isCoreAvailable()) await call("archive_delete");
    try {
      window.localStorage.clear();
    } catch {
      // storage unavailable: nothing to clear
    }
    live.current = null;
    orreryMountedAt.current = null;
    setAppMounted(false);
    if (isCoreAvailable()) setAccessGranted(false);
    setRunKey((k) => k + 1);
    setPhase("running");
  }, []);

  if (phase === "broken") {
    return (
      <div className="archive-problem" data-archive-problem="">
        <section className="no-access" aria-labelledby="archive-problem-title">
          <h2 id="archive-problem-title" className="no-access__title">
            The archive could not be opened
          </h2>
          <p className="no-access__body">{archiveProblem}</p>
          <p className="no-access__body">
            Nothing was changed. Armillary can rename the old file (it is kept next to the new one, with
            .bak and the time added to its name) and start a new, empty archive.
          </p>
          {moveError ? (
            <p className="delete-confirm__error" role="alert">
              The archive was not moved: {moveError}
            </p>
          ) : null}
          <button type="button" className="obs-button obs-button--gilt" onClick={() => void moveArchiveAside()}>
            Move it aside and start fresh
          </button>
        </section>
      </div>
    );
  }

  if (phase === "pending") {
    return <div data-firstrun-pending="" style={{ position: "fixed", inset: 0, background: "#0B1220" }} />;
  }
  const showing = phase === "running";
  return (
    <>
      <div
        data-app-root=""
        ref={appRef}
        style={{ width: "100%", height: "100%" }}
        {...(showing ? { "aria-hidden": true, inert: true } : {})}
      >
        {appMounted ? children({ replay, accessGranted, deleteArchive }) : null}
      </div>
      {showing && source ? (
        <FirstRun
          key={runKey}
          source={source}
          fpsLog={fpsLog}
          onComplete={onComplete}
          onHandoffStart={() => setAppMounted(true)}
          getTarget={getTarget}
          onAppAlpha={onAppAlpha}
        />
      ) : null}
    </>
  );
}
