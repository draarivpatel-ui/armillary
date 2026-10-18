/**
 * The first-run host. Owns the one clock (the rAF timestamp, or a capture seek), stamps every
 * input on it, evaluates the scene and hands the frame to the renderers. Exposes
 * window.__armillaryFirstRun for frame-perfect capture.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CoreEvent, FirstRunPlan } from "../events";
import { Canvas2DSkyRenderer } from "../render/canvas2d";
import { Overlay } from "../render/overlay";
import { WebGLSkyRenderer, type SkyRenderer } from "../render/webgl";
import { HANDOFF } from "../scene/schedule";
import { Scene } from "../scene/scene";
import type { Frame, HandoffTarget, Phase, SceneInput } from "../scene/types";
import type { FirstRunSource } from "../sources";
import { ConsentPlaque } from "./ConsentPlaque";
import "./firstrun.css";

export interface FirstRunResult {
  declined: boolean;
  skipped: boolean;
}

export interface FirstRunProps {
  source: FirstRunSource;
  onComplete: (result: FirstRunResult) => void;
  /**
   * Called once, early enough for the app to mount and lay out off-screen: when the calm
   * constellation scene begins (or on an exit). Mount the app underneath then.
   */
  onHandoffStart?: () => void;
  /**
   * Where the live Orrery will draw things `msUntilLanding` ms from now (the middle of the final
   * cross-fade), or null until the app has laid out.
   */
  getTarget?: (msUntilLanding: number) => HandoffTarget | null;
  /** The opacity the app underneath should have (the final cross-fade). */
  onAppAlpha?: (alpha: number) => void;
  /** Forces reduced motion; defaults to the OS preference. */
  reducedMotion?: boolean;
  /** "auto" (WebGL2 with a Canvas 2D fallback) or force one renderer. */
  renderer?: "auto" | "webgl2" | "canvas2d";
  /** Capture mode: no autoplay; time comes only from window.__armillaryFirstRun.seek. */
  capture?: boolean;
  /** When set, frame-time percentiles over 600 frames are reported through it. */
  fpsLog?: (line: string) => void;
}

export interface CaptureApi {
  ready: boolean;
  renderer: () => "webgl2" | "canvas2d" | "none";
  seek: (ms: number) => Promise<void>;
  pause: () => void;
  play: () => void;
  /** Replace every input (a scripted run). Times are scene ms. */
  load: (inputs: SceneInput[]) => void;
  /** Convenience: the recorded source's plan and events, with consent at `consentAt`. */
  script: (opts: { consentAt: number; target?: HandoffTarget; targetAt?: number; skipAt?: number; declineAt?: number }) => Promise<void>;
  state: () => { t: number; phase: Phase; completeAt: number | null; handoffAt: number | null; scanEndAt: number | null };
  frame: () => Frame | null;
}

declare global {
  interface Window {
    __armillaryFirstRun?: CaptureApi;
  }
}

const FONT_LOADS = [
  '600 56px "Cormorant Garamond"',
  '700 12px "Cormorant Garamond"',
  'italic 500 12px "Cormorant Garamond"',
  '500 14px "Instrument Sans"',
  '600 10px "Instrument Sans"',
];

async function fontsReady(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const all = Promise.all(FONT_LOADS.map((f) => document.fonts.load(f).catch(() => [])));
  await Promise.race([all, new Promise((r) => setTimeout(r, 1500))]);
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

export const FirstRun: React.FC<FirstRunProps> = (props) => {
  const { source, capture = false } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const skyHostRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const rigRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const reduced = props.reducedMotion ?? prefersReducedMotion();
  const [plan, setPlan] = useState<FirstRunPlan | null>(null);
  const [plaqueVisible, setPlaqueVisible] = useState(false);
  const [plaqueInteractive, setPlaqueInteractive] = useState(false);
  const [skipVisible, setSkipVisible] = useState(false);
  const [status, setStatus] = useState("");

  const scene = useMemo(
    () => new Scene({ w: 1440, h: 900, reducedMotion: reduced, measure: (f, t, tr) => t.length * (parseFloat(/([\d.]+)px/.exec(f)?.[1] ?? "14") * 0.55 + tr) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const st = useRef({
    startTs: null as number | null,
    pausedAt: null as number | null,
    t: 0,
    raf: 0,
    sky: null as SkyRenderer | null,
    overlay: null as Overlay | null,
    frame: null as Frame | null,
    handoffSignalled: false,
    targetPushed: false,
    completed: false,
    declined: false,
    skipped: false,
    scanning: false,
    fps: { last: 0, deltas: [] as number[], work: [] as number[], reported: 0, final: false, firstAt: 0, frames: 0 },
    ready: false,
    dirty: false,
  });

  /** The current scene time: the clock the inputs are stamped on. */
  const now = useCallback((): number => {
    const s = st.current;
    if (capture || s.startTs === null) return s.t;
    if (s.pausedAt !== null) return s.pausedAt;
    return performance.now() - s.startTs;
  }, [capture]);

  const push = useCallback((input: SceneInput) => scene.push(input), [scene]);

  const renderAt = useCallback(
    (t: number) => {
      const s = st.current;
      if (!s.overlay || !s.sky) return;
      const work0 = performance.now();
      s.t = t;
      const p = propsRef.current;
      // The hand-over needs the app underneath: ask for it and its measured Orrery.
      const sched = scene.schedule();
      const handing = (sched.scanEndAt !== undefined && t >= sched.scanEndAt) || (sched.exitAt !== undefined && t >= sched.exitAt);
      if (handing && !s.handoffSignalled) {
        s.handoffSignalled = true;
        p.onHandoffStart?.();
      }
      if (sched.handoffAt !== undefined && t >= sched.handoffAt && !s.targetPushed && sched.target === undefined && p.getTarget) {
        const landing = sched.handoffAt + HANDOFF.dur - HANDOFF.fade / 2;
        const target = p.getTarget(Math.max(0, landing - t));
        if (target) {
          s.targetPushed = true;
          scene.push({ kind: "target", at: capture ? sched.handoffAt : Math.max(sched.handoffAt, t), target });
        }
      }
      const f = scene.evaluate(t);
      s.frame = f;
      s.sky.render(f);
      s.overlay.render(f);
      if (rootRef.current) rootRef.current.style.opacity = String(f.canvasAlpha);
      p.onAppAlpha?.(f.appAlpha);
      // The plaque follows the frame (imperative: no React render per frame).
      if (f.plaque.visible !== plaqueVisibleRef.current) {
        plaqueVisibleRef.current = f.plaque.visible;
        setPlaqueVisible(f.plaque.visible);
      }
      if (f.plaque.interactive !== plaqueInteractiveRef.current) {
        plaqueInteractiveRef.current = f.plaque.interactive;
        setPlaqueInteractive(f.plaque.interactive);
      }
      if (rigRef.current) {
        rigRef.current.style.transform = `translate3d(0, ${f.plaque.offsetY.toFixed(2)}px, 0) rotate(${f.plaque.swing.toFixed(5)}rad)`;
        rigRef.current.style.opacity = String(f.plaque.alpha);
      }
      if (f.skipVisible !== skipVisibleRef.current) {
        skipVisibleRef.current = f.skipVisible;
        setSkipVisible(f.skipVisible);
      }
      const msg = statusLine(f);
      if (msg !== statusRef.current) {
        statusRef.current = msg;
        setStatus(msg);
      }
      if (f.phase === "complete" && !s.completed && !capture) {
        s.completed = true;
        const result = { declined: s.declined, skipped: s.skipped };
        const done = s.declined ? Promise.resolve() : source.complete().catch(() => undefined);
        void done.then(() => propsRef.current.onComplete(result));
      }
      // Frame-time logging (ARMILLARY_FPS_LOG): rAF interval and per-frame work, p50/p95 over 600 frames.
      if (p.fpsLog && s.pausedAt === null) {
        const fp = s.fps;
        const nowTs = performance.now();
        if (fp.last) fp.deltas.push(nowTs - fp.last);
        else if (!fp.firstAt) fp.firstAt = nowTs;
        fp.work.push(nowTs - work0);
        fp.last = nowTs;
        fp.frames++;
        // A last report when the run completes (any frame count), so short or throttled runs still say how they went.
        const finishing = f.phase === "complete" && fp.deltas.length >= 1 && fp.reported >= 0 && !fp.final;
        if (finishing) fp.final = true;
        if (fp.deltas.length >= 600 || finishing) {
          const d = fp.deltas.slice().sort((a, b) => a - b);
          const w = fp.work.slice().sort((a, b) => a - b);
          fp.reported++;
          p.fpsLog(
            `firstrun renderer=${s.sky.kind} frames=${d.length} total_frames=${fp.frames} elapsed=${Math.round(nowTs - fp.firstAt)}ms interval_p50=${percentile(d, 0.5).toFixed(2)}ms interval_p95=${percentile(d, 0.95).toFixed(2)}ms work_p50=${percentile(w, 0.5).toFixed(2)}ms work_p95=${percentile(w, 0.95).toFixed(2)}ms phase=${f.phase} size=${f.w}x${f.h} dpr=${window.devicePixelRatio}`,
          );
          fp.deltas = [];
          fp.work = [];
        }
      }
    },
    [scene, capture, source],
  );

  const plaqueVisibleRef = useRef(false);
  const plaqueInteractiveRef = useRef(false);
  const skipVisibleRef = useRef(false);
  const statusRef = useRef("");

  useLayoutEffect(() => {
    const f = st.current.frame;
    if (plaqueVisible && f && rigRef.current) {
      rigRef.current.style.transform = `translate3d(0, ${f.plaque.offsetY.toFixed(2)}px, 0) rotate(${f.plaque.swing.toFixed(5)}rad)`;
      rigRef.current.style.opacity = String(f.plaque.alpha);
    }
  }, [plaqueVisible]);

  // ---- renderers, sizing, fonts, clock
  useEffect(() => {
    const s = st.current;
    const host = skyHostRef.current!;
    const overlayCanvas = overlayRef.current!;
    let disposed = false;

    const makeSky = (force?: "webgl2" | "canvas2d"): SkyRenderer => {
      host.replaceChildren();
      const c = document.createElement("canvas");
      c.className = "fr-canvas";
      c.setAttribute("aria-hidden", "true");
      host.appendChild(c);
      const want = force ?? propsRef.current.renderer ?? "auto";
      if (want !== "canvas2d") {
        const gl = WebGLSkyRenderer.create(c, scene.field);
        if (gl) {
          c.addEventListener(
            "webglcontextlost",
            (e) => {
              e.preventDefault();
              // Swap to the Canvas 2D renderer on a fresh canvas; the next frame draws with it.
              if (!disposed) {
                s.sky = makeSky("canvas2d");
                sizeAll();
                if (s.frame) s.sky.render(s.frame);
              }
            },
            { once: true },
          );
          return gl;
        }
        host.replaceChildren();
        const c2 = document.createElement("canvas");
        c2.className = "fr-canvas";
        c2.setAttribute("aria-hidden", "true");
        host.appendChild(c2);
        return new Canvas2DSkyRenderer(c2, scene.field);
      }
      return new Canvas2DSkyRenderer(c, scene.field);
    };

    const sizeAll = () => {
      const r = rootRef.current!.getBoundingClientRect();
      const w = Math.max(320, Math.round(r.width));
      const h = Math.max(240, Math.round(r.height));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      s.sky?.resize(w, h, dpr);
      s.overlay?.resize(w, h, dpr);
      scene.setConfig({ w, h });
    };

    s.sky = makeSky();
    s.overlay = new Overlay(overlayCanvas);
    scene.setConfig({ measure: (f, t, tr) => s.overlay!.measure(f, t, tr), reducedMotion: reduced });
    sizeAll();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
      sizeAll();
      if (s.pausedAt !== null) s.dirty = true;
    }) : null;
    ro?.observe(rootRef.current!);

    // One loop for both modes. The scene clock is the rAF timestamp minus the start; while paused
    // (capture mode starts paused) a frame is drawn only when a seek or a resize asks for one.
    const loop = (ts: number) => {
      if (disposed) return;
      if (s.pausedAt === null) {
        if (s.startTs === null) s.startTs = ts - s.t;
        renderAt(ts - s.startTs);
      } else if (s.dirty) {
        s.dirty = false;
        renderAt(s.pausedAt);
      }
      if (!s.completed) s.raf = requestAnimationFrame(loop);
    };

    void fontsReady().then(() => {
      if (disposed) return;
      s.ready = true;
      if (capture) {
        s.pausedAt = 0;
        renderAt(0);
      }
      s.raf = requestAnimationFrame(loop);
      if (window.__armillaryFirstRun) window.__armillaryFirstRun.ready = true;
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(s.raf);
      ro?.disconnect();
      s.sky?.dispose();
    };
  }, [scene, renderAt, capture, reduced]);

  // ---- the plan (registry only) for the plaque
  useEffect(() => {
    let live = true;
    source
      .plan()
      .then((p) => {
        if (!live) return;
        setPlan(p);
        push({ kind: "plan", at: now(), plan: p });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [source, push, now]);

  // ---- user actions
  const startScan = useCallback(
    (consentAt: number) => {
      const s = st.current;
      if (s.scanning) return;
      s.scanning = true;
      void source
        .consent(true)
        .then(() =>
          source.scan((ev: CoreEvent, offset?: number) => {
            push({ kind: "core", at: offset !== undefined ? consentAt + offset : Math.max(consentAt, now()), event: ev });
          }),
        )
        .catch((err: unknown) => push({ kind: "coreError", at: now(), message: err instanceof Error ? err.message : String(err) }));
    },
    [source, push, now],
  );

  const onContinue = useCallback(() => {
    if (!plaqueInteractiveRef.current) return;
    const at = now();
    push({ kind: "consent", at });
    startScan(at);
  }, [now, push, startScan]);

  const onDecline = useCallback(() => {
    if (!plaqueInteractiveRef.current) return;
    st.current.declined = true;
    push({ kind: "decline", at: now() });
    void source.consent(false).catch(() => undefined);
  }, [now, push, source]);

  const onSkip = useCallback(() => {
    const s = st.current;
    const sched = scene.schedule();
    if (sched.consentAt !== undefined) s.skipped = true;
    push({ kind: "skip", at: now() });
  }, [now, push, scene]);

  useEffect(() => {
    if (capture) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || plaqueInteractiveRef.current) return;
      e.preventDefault();
      onSkip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSkip, capture]);

  // ---- capture API
  useEffect(() => {
    const s = st.current;
    const api: CaptureApi = {
      ready: s.ready,
      renderer: () => s.sky?.kind ?? "none",
      seek: (ms: number) =>
        new Promise<void>((resolve) => {
          s.pausedAt = ms;
          s.t = ms;
          renderAt(ms);
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
      pause: () => {
        s.pausedAt = s.t;
      },
      play: () => {
        // Resume from the current scene time on the next rAF timestamp.
        if (s.pausedAt !== null) s.t = s.pausedAt;
        s.startTs = null;
        s.pausedAt = null;
        s.fps.last = 0;
      },
      load: (inputs: SceneInput[]) => {
        s.targetPushed = inputs.some((i) => i.kind === "target");
        s.handoffSignalled = false;
        scene.setInputs(inputs);
      },
      script: async (opts) => {
        const p = await source.plan();
        const inputs: SceneInput[] = [{ kind: "plan", at: 0, plan: p }];
        if (opts.skipAt !== undefined) inputs.push({ kind: "skip", at: opts.skipAt });
        if (opts.declineAt !== undefined) inputs.push({ kind: "decline", at: opts.declineAt });
        else {
          inputs.push({ kind: "consent", at: opts.consentAt });
          await source.scan((ev, offset) => inputs.push({ kind: "core", at: opts.consentAt + (offset ?? 0), event: ev }));
        }
        if (opts.target) inputs.push({ kind: "target", at: opts.targetAt ?? 0, target: opts.target });
        api.load(inputs);
      },
      state: () => {
        const sc = scene.schedule();
        return { t: s.t, phase: scene.phaseAt(s.t), completeAt: sc.completeAt ?? null, handoffAt: sc.handoffAt ?? null, scanEndAt: sc.scanEndAt ?? null };
      },
      frame: () => s.frame,
    };
    window.__armillaryFirstRun = api;
    return () => {
      if (window.__armillaryFirstRun === api) delete window.__armillaryFirstRun;
    };
  }, [scene, source, renderAt]);

  return (
    <div className="fr-root" ref={rootRef} data-firstrun="">
      <div className="fr-sky" ref={skyHostRef} />
      <canvas className="fr-canvas fr-overlay" ref={overlayRef} aria-hidden="true" />
      {plaqueVisible && <ConsentPlaque plan={plan} interactive={plaqueInteractive} onContinue={onContinue} onDecline={onDecline} rigRef={rigRef} />}
      {skipVisible && (
        <button type="button" data-firstrun-action="skip" className="fr-skip" onClick={onSkip}>
          Skip <kbd>Esc</kbd>
        </button>
      )}
      <p className="fr-sr" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
};

function statusLine(f: Frame): string {
  switch (f.phase) {
    case "intro":
      return "Armillary is opening.";
    case "consent":
      return f.plaque.interactive ? "What Armillary reads. Continue or not now." : "";
    case "scan":
      return f.cartouche.catalogue ? `${f.cartouche.found} of ${f.cartouche.catalogue} agents found.` : "Looking for agents.";
    case "constellations":
      return `${f.cartouche.found} of ${f.cartouche.catalogue} agents found. History gathered.`;
    case "handoff":
    case "exit":
    case "complete":
      return "Opening the Orrery.";
  }
}
