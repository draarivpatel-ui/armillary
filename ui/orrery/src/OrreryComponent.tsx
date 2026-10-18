import React, { useEffect, useRef } from 'react';
import { Orrery } from './orrery';
import { ORRERY_LAYOUT_SEED } from './seam';
import { OrreryTheme, Project, Session } from './types';
import './tokens.css';

export interface OrreryViewProps {
  projects: Project[];
  sessions: Session[];
  width?: number;
  height?: number;
  theme?: OrreryTheme;
  reducedMotion?: boolean;
  seed?: number | string;
  /**
   * Unix ms that corresponds to animation time t = 0 (wall time at t is wallEpochMs + t).
   * Used only for "needs you for 2m" text. When omitted, the host samples the real
   * wall clock once at mount.
   */
  wallEpochMs?: number;
  onSelectSession?: (session: Session) => void;
  onHoverSession?: (session: Session | null) => void;
  onSelectSun?: (project: Project) => void;
  /**
   * Receives a locator once the canvas is live (and null when it goes away): given a session id it returns
   * that planet's box in page coordinates, so a scripted tour can move a cursor to it and click it.
   */
  onLocator?: (locate: ((sessionId: string) => DOMRect | null) | null) => void;
  /** Receives the live controller once it exists (and null when it goes away): layoutAt(t), now(), getLayout(). */
  onReady?: (orrery: Orrery | null) => void;
  /** Cap on paints per second while planets move; omitted means every host frame. */
  maxFps?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function resolveReducedMotion(propValue?: boolean): boolean {
  if (typeof propValue === 'boolean') {
    return propValue;
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  return false;
}

export function OrreryView({
  projects,
  sessions,
  width = 1200,
  height = 800,
  theme = 'dark',
  reducedMotion: reducedMotionProp,
  seed = ORRERY_LAYOUT_SEED,
  wallEpochMs: wallEpochMsProp,
  onSelectSession,
  onHoverSession,
  onSelectSun,
  onLocator,
  onReady,
  maxFps,
  className,
  style,
}: OrreryViewProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const orreryRef = useRef<Orrery | null>(null);
  // Host clock sample: the only real wall-clock read in the package, once at mount.
  const [mountWallEpochMs] = React.useState<number>(() => Date.now());
  const wallEpochMs = wallEpochMsProp ?? mountWallEpochMs;

  const [effectiveReducedMotion, setEffectiveReducedMotion] = React.useState<boolean>(() =>
    resolveReducedMotion(reducedMotionProp)
  );

  useEffect(() => {
    if (typeof reducedMotionProp === 'boolean') {
      setEffectiveReducedMotion(reducedMotionProp);
      return;
    }
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => {
      setEffectiveReducedMotion(e.matches);
    };

    setEffectiveReducedMotion(media.matches);
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    } else if (typeof (media as any).addListener === 'function') {
      (media as any).addListener(onChange);
      return () => (media as any).removeListener(onChange);
    }
  }, [reducedMotionProp]);

  const onSelectSessionRef = useRef(onSelectSession);
  const onHoverSessionRef = useRef(onHoverSession);
  const onSelectSunRef = useRef(onSelectSun);
  const onLocatorRef = useRef(onLocator);
  onLocatorRef.current = onLocator;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  onSelectSessionRef.current = onSelectSession;
  onHoverSessionRef.current = onHoverSession;
  onSelectSunRef.current = onSelectSun;

  useEffect(() => {
    if (!canvasRef.current) return;

    try {
      const instance = new Orrery(canvasRef.current, {
        width,
        height,
        theme,
        reducedMotion: effectiveReducedMotion,
        seed,
        wallEpochMs,
        maxFps,
        onSelectSession: (s) => onSelectSessionRef.current?.(s),
        onHoverSession: (s) => onHoverSessionRef.current?.(s),
        onSelectSun: (p) => onSelectSunRef.current?.(p),
      });
      instance.setData(projects, sessions);
      orreryRef.current = instance;
      const canvas = canvasRef.current;
      onLocatorRef.current?.((sessionId: string) => {
        const at = instance.locateSession(sessionId);
        if (!at || typeof DOMRect === 'undefined') return null;
        const box = canvas.getBoundingClientRect();
        const left = box.left + (typeof window !== 'undefined' ? window.scrollX : 0);
        const top = box.top + (typeof window !== 'undefined' ? window.scrollY : 0);
        return new DOMRect(left + at.x - at.radius, top + at.y - at.radius, at.radius * 2, at.radius * 2);
      });

      onReadyRef.current?.(instance);

      return () => {
        onReadyRef.current?.(null);
        onLocatorRef.current?.(null);
        instance.destroy();
        orreryRef.current = null;
      };
    } catch {
      // Headless environments (e.g. JSDOM) without 2D canvas context support
    }
  }, []);

  // Update wall epoch
  useEffect(() => {
    if (orreryRef.current) {
      orreryRef.current.setWallEpoch(wallEpochMs);
    }
  }, [wallEpochMs]);

  // Update callbacks
  useEffect(() => {
    if (orreryRef.current) {
      orreryRef.current.setCallbacks({
        onSelectSession: (s) => onSelectSessionRef.current?.(s),
        onHoverSession: (s) => onHoverSessionRef.current?.(s),
        onSelectSun: (p) => onSelectSunRef.current?.(p),
      });
    }
  }, [onSelectSession, onHoverSession, onSelectSun]);

  // Update data
  useEffect(() => {
    if (orreryRef.current) {
      orreryRef.current.setData(projects, sessions);
    }
  }, [projects, sessions]);

  // Update theme
  useEffect(() => {
    if (orreryRef.current) {
      orreryRef.current.setTheme(theme);
    }
  }, [theme]);

  // Update reduced motion
  useEffect(() => {
    if (orreryRef.current) {
      orreryRef.current.setReducedMotion(effectiveReducedMotion);
    }
  }, [effectiveReducedMotion]);

  // Update dimensions
  useEffect(() => {
    if (orreryRef.current) {
      orreryRef.current.resize(width, height);
    }
  }, [width, height]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      tabIndex={0}
      aria-label="Orrery celestial observatory view of live agent sessions"
      style={{
        display: 'block',
        outline: 'none',
        borderRadius: '4px',
        ...style,
      }}
    />
  );
};
