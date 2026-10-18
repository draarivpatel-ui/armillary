import { OrreryPlanet, OrrerySun, Session } from './types';

/**
 * Time model: every function here is a pure function of one clock value `t` (ms)
 * handed in by the host (the rAF timestamp minus the first rAF timestamp in live
 * mode, or the seek value in capture). Nothing in this file reads a real clock.
 */

/** Duration of the needs-you swing to the front of the orbit. */
export const SWING_DURATION_MS = 600;

export interface AnimationStepOptions {
  /** Animation time t in ms. Used as t when `timestamp` is not given. */
  elapsedMs: number;
  /** Kept for compatibility. Motion is a pure function of t, so it is not used. */
  deltaMs: number;
  /** Animation time t in ms (takes precedence over elapsedMs). */
  timestamp?: number;
  reducedMotion?: boolean;
  suns?: OrrerySun[];
  /** Unix ms that corresponds to t = 0. Wall time at t is wallEpochMs + t. Default 0. */
  wallEpochMs?: number;
}

/**
 * CSS cubic-bezier(0.25, 0.1, 0.25, 1) easing, solved numerically.
 */
const BEZIER_X1 = 0.25;
const BEZIER_Y1 = 0.1;
const BEZIER_X2 = 0.25;
const BEZIER_Y2 = 1.0;

function bezier(a1: number, a2: number, s: number): number {
  const u = 1 - s;
  return 3 * u * u * s * a1 + 3 * u * s * s * a2 + s * s * s;
}

export function easeCubic(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  if (x === 0 || x === 1) return x;
  // Bisection on the parametric x(s); 40 iterations is far below float noise.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (bezier(BEZIER_X1, BEZIER_X2, mid) < x) lo = mid;
    else hi = mid;
  }
  return bezier(BEZIER_Y1, BEZIER_Y2, (lo + hi) / 2);
}

/**
 * Normalizes an angle difference to [-PI, PI] to take the shortest arc.
 */
function normalizeAngleDiff(from: number, to: number): number {
  let diff = (to - from) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

export function wrapAngle(a: number): number {
  const full = Math.PI * 2;
  return ((a % full) + full) % full;
}

/** Orbital angular speed (rad/ms) of a working or idle session: 40 s to 120 s per revolution. */
export function orbitAngularSpeed(session: Session): number {
  const activity = session.state === 'idle' ? 0.05 : Math.max(0, Math.min(1, session.activity));
  const periodSec = 120 - 80 * activity;
  return (2 * Math.PI) / (periodSec * 1000);
}

/** Moon angular speed (rad/ms) for the moon at `index` of its planet: 12 s plus 3 s per index. */
export function moonAngularSpeed(index: number): number {
  return (2 * Math.PI) / (12000 + index * 3000);
}

/**
 * Updates positions and animation states for all planets and their moons as a
 * pure function of t (and the latched swing fields on each planet).
 */
export function updateAnimationState(
  planets: OrreryPlanet[],
  options: AnimationStepOptions
): void {
  const { reducedMotion = false, suns = [], wallEpochMs = 0 } = options;
  const t = options.timestamp ?? options.elapsedMs;
  const sunMap = new Map<string, OrrerySun>();
  for (const s of suns) {
    sunMap.set(s.id, s);
  }

  for (const planet of planets) {
    const isWaiting = planet.session.state === 'waiting';
    const isDone = planet.session.state === 'done';

    if (isWaiting) {
      // transitionStartTime is latched when the update arrives (or at mount).
      const start = planet.transitionStartTime ?? 0;
      const raw = reducedMotion ? 1 : Math.max(0, Math.min(1, (t - start) / SWING_DURATION_MS));
      const eased = easeCubic(raw);
      planet.transitionProgress = eased;

      const since = planet.session.waiting_since;
      planet.waitingElapsedMs =
        since !== undefined ? Math.max(0, wallEpochMs + t - since) : Math.max(0, t - start);

      if (raw >= 1) {
        planet.angle = planet.targetAngle;
        planet.isFront = true;
        planet.haloProgress = 1.0;
        planet.bellGlint = true;
      } else {
        const angleDiff = normalizeAngleDiff(planet.startAngle, planet.targetAngle);
        planet.angle = planet.startAngle + angleDiff * eased;
        planet.isFront = false;
        // Pulse up to 1.5 during the swing
        planet.haloProgress = raw * 1.5;
        planet.bellGlint = raw > 0.75;
      }
    } else if (!isDone && !reducedMotion) {
      // Working / idle: angle is a pure function of t
      planet.angle = wrapAngle(planet.startAngle + orbitAngularSpeed(planet.session) * t);
      planet.isFront = false;
      planet.haloProgress = 0;
      planet.bellGlint = false;
    } else {
      // Done planets, and every non-waiting planet in reduced motion, hold still.
      planet.isFront = false;
      planet.haloProgress = 0;
      planet.bellGlint = false;
    }

    // Recompute Cartesian coordinates on tilted ellipse if sun is available
    const sun = sunMap.get(planet.sunId);
    if (sun) {
      const cosA = Math.cos(planet.angle);
      const sinA = Math.sin(planet.angle);
      const unrotatedX = planet.orbitSemiMajor * cosA;
      const unrotatedY = planet.orbitSemiMinor * sinA;
      const cosT = Math.cos(planet.orbitTilt);
      const sinT = Math.sin(planet.orbitTilt);

      planet.currentX = Math.round((sun.x + (unrotatedX * cosT - unrotatedY * sinT)) * 10) / 10;
      planet.currentY = Math.round((sun.y + (unrotatedX * sinT + unrotatedY * cosT)) * 10) / 10;

      // Update moons
      for (let m = 0; m < planet.moons.length; m++) {
        const moon = planet.moons[m];
        if (!reducedMotion) {
          const startAngle = moon.startAngle ?? moon.angle;
          moon.angle = wrapAngle(startAngle + moonAngularSpeed(m) * t);
        }
        moon.x = Math.round((planet.currentX + Math.cos(moon.angle) * moon.orbitRadius) * 10) / 10;
        moon.y = Math.round((planet.currentY + Math.sin(moon.angle) * moon.orbitRadius) * 10) / 10;
      }
    }
  }
}

/**
 * Frame Governor class that handles:
 * - 30 fps while anything moves (33.3ms throttle)
 * - 0 fps when the tab is hidden (document.visibilityState === 'hidden')
 * - Low rate (1 fps) or sleep when nothing changes
 *
 * It reads no clock of its own: throttling and deltas come only from the rAF
 * timestamps it is handed. The first frame after start or resume reports delta 0.
 */
export class FrameGovernor {
  private rafId: number | null = null;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private isRunning = false;
  private lastThrottleTime: number | null = null;
  private lastCallbackTime: number | null = null;
  /** Minimum ms between paints while something moves; 0 paints every host frame (the default). */
  private readonly targetFrameInterval: number;
  private callback: (timestamp: number, deltaMs: number) => void;
  private hasActiveMovement = true;

  constructor(callback: (timestamp: number, deltaMs: number) => void, options: { maxFps?: number } = {}) {
    this.callback = callback;
    const maxFps = options.maxFps;
    this.targetFrameInterval = typeof maxFps === 'number' && Number.isFinite(maxFps) && maxFps > 0 ? 1000 / maxFps : 0;
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  public setActiveMovement(active: boolean): void {
    const wasActive = this.hasActiveMovement;
    this.hasActiveMovement = active;
    if (active && !wasActive && this.isRunning && this.timerId !== null) {
      // Leave the 1 fps idle wait at once so new motion starts on the next frame.
      clearTimeout(this.timerId);
      this.timerId = null;
      if (this.rafId === null) this.scheduleNextFrame();
    }
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastThrottleTime = null;
    this.lastCallbackTime = null;
    this.scheduleNextFrame();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  private handleVisibilityChange(): void {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      // 0 fps when tab is hidden
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      if (this.timerId !== null) {
        clearTimeout(this.timerId);
        this.timerId = null;
      }
    } else if (this.isRunning) {
      // Resume when visible: the next rAF timestamp restarts the throttle and delta.
      this.lastThrottleTime = null;
      this.lastCallbackTime = null;
      this.scheduleNextFrame();
    }
  }

  private emit(now: number): void {
    const delta = this.lastCallbackTime === null ? 0 : now - this.lastCallbackTime;
    this.lastCallbackTime = now;
    this.callback(now, delta);
  }

  private scheduleNextFrame(): void {
    if (!this.isRunning) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    // Headless hosts (no rAF) have no frame timestamps, so there is nothing to schedule.
    if (typeof requestAnimationFrame !== 'function') return;

    if (this.hasActiveMovement) {
      // Host-rate painting (optionally capped by maxFps)
      this.rafId = requestAnimationFrame((now) => {
        this.rafId = null;
        if (this.lastThrottleTime === null) {
          this.lastThrottleTime = now;
          this.emit(now);
        } else {
          const throttleDelta = now - this.lastThrottleTime;
          if (throttleDelta >= this.targetFrameInterval) {
            this.lastThrottleTime =
              this.targetFrameInterval > 0 ? now - (throttleDelta % this.targetFrameInterval) : now;
            this.emit(now);
          }
        }
        this.scheduleNextFrame();
      });
    } else {
      // Low rate (1 fps) when nothing is moving: wait, then take one rAF timestamp.
      this.timerId = setTimeout(() => {
        this.timerId = null;
        this.rafId = requestAnimationFrame((now) => {
          this.rafId = null;
          this.lastThrottleTime = now;
          this.emit(now);
          this.scheduleNextFrame();
        });
      }, 1000);
    }
  }

  public destroy(): void {
    this.stop();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }
}
