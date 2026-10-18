import { generateMockData, MockDataResult } from './mock';
import { Orrery } from './orrery';
import { OrreryTheme, Session } from './types';
import './tokens.css';

declare global {
  interface Window {
    renderCaptureAt: (seconds: number, theme?: OrreryTheme) => void;
    __CAPTURE_READY__: boolean;
    __ORRERY_INSTANCE__?: Orrery;
  }
}

/**
 * Fixed wall clock for captures: the Unix ms that corresponds to animation time t = 0.
 * Every "needs you for 2m" label in a capture is computed from this constant and t,
 * so a capture is identical on any date.
 */
export const CAPTURE_WALL_EPOCH_MS = 1_760_000_000_000;

/** Seconds at which the scripted timeline changes the data (event arrivals). */
export const CAPTURE_EVENT_SECONDS = [3, 5];

export const CAPTURE_WIDTH = 1200;
export const CAPTURE_HEIGHT = 800;

export function createCaptureBaseData(seed: number): MockDataResult {
  // Base scenario with 4 projects and 16 sessions, "now" fixed to the capture epoch
  return generateMockData({ seed, projectCount: 4, sessionCount: 16, nowMs: CAPTURE_WALL_EPOCH_MS });
}

/**
 * Session states for the 10-second timeline. Unix ms waiting_since values are relative
 * to CAPTURE_WALL_EPOCH_MS:
 * - 0s: initial working / waiting / done mix (session 2 has needed you for 45 s)
 * - 3s: session 5 arrives in waiting and swings to the front
 * - 5s: session 3 finishes and settles into the done ring
 */
export function getSessionsForTimestamp(seconds: number, baseSessions: Session[]): Session[] {
  const sessions = JSON.parse(JSON.stringify(baseSessions)) as Session[];

  // Session 1: waiting from the start (needs you) - waiting since 45s before epoch 0
  if (sessions[1]) {
    sessions[1].state = 'waiting';
    sessions[1].waiting_since = CAPTURE_WALL_EPOCH_MS - 45000;
  }

  // Session 4: transitions to waiting at 3 seconds (3000 ms)
  if (sessions[4] && seconds >= 3) {
    sessions[4].state = 'waiting';
    sessions[4].waiting_since = CAPTURE_WALL_EPOCH_MS + 3000;
  }

  // Session 2: finishes and settles into done ring at 5 seconds
  if (sessions[2] && seconds >= 5) {
    sessions[2].state = 'done';
    sessions[2].activity = 0;
  }

  return sessions;
}

export function createCaptureOrrery(
  canvas: HTMLCanvasElement,
  theme: OrreryTheme,
  seed: number
): Orrery {
  return new Orrery(canvas, {
    width: CAPTURE_WIDTH,
    height: CAPTURE_HEIGHT,
    theme,
    seed,
    reducedMotion: false,
    paused: true,
    wallEpochMs: CAPTURE_WALL_EPOCH_MS,
  });
}

/**
 * Replays the scripted timeline on a FRESH controller up to `seconds` and renders that
 * frame: data arrives at t = 0 (mount), then at each event second, then renderAt(seconds).
 * Replaying from the start makes the frame at any time identical, in any order.
 */
export function replayCapture(orrery: Orrery, seconds: number, seed = 42): void {
  const base = createCaptureBaseData(seed);
  orrery.renderAt(0);
  orrery.setData(base.projects, getSessionsForTimestamp(0, base.sessions));
  for (const event of CAPTURE_EVENT_SECONDS) {
    if (event <= seconds) {
      orrery.renderAt(event * 1000);
      orrery.setData(base.projects, getSessionsForTimestamp(event, base.sessions));
    }
  }
  orrery.renderAt(seconds * 1000);
}

// Browser bootstrap (the capture page). Skipped when imported by tests.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const params = new URLSearchParams(window.location.search);
  const initialTheme = (params.get('theme') as OrreryTheme) || 'dark';
  const initialSeconds = parseFloat(params.get('time') || '0');
  const seed = parseInt(params.get('seed') || '42', 10);

  document.documentElement.setAttribute('data-theme', initialTheme);

  const canvas = document.getElementById('capture-canvas') as HTMLCanvasElement;

  window.renderCaptureAt = async (seconds: number, theme: OrreryTheme = initialTheme) => {
    window.__CAPTURE_READY__ = false;
    document.documentElement.setAttribute('data-theme', theme);
    await document.fonts.ready;
    window.__ORRERY_INSTANCE__?.destroy();
    const orrery = createCaptureOrrery(canvas, theme, seed);
    window.__ORRERY_INSTANCE__ = orrery;
    replayCapture(orrery, seconds, seed);
    window.__CAPTURE_READY__ = true;
  };

  // Auto-render on load after fonts are ready
  document.fonts.ready.then(() => {
    window.renderCaptureAt(initialSeconds, initialTheme);
  });
}
