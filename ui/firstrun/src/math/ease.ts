/** Pure scalar helpers. No clocks here: every function takes its time explicitly. */

export const clamp = (v: number, lo = 0, hi = 1): number => (v < lo ? lo : v > hi ? hi : v);
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Progress of t through [t0, t0 + dur], clamped to 0..1. */
export const span = (t: number, t0: number, dur: number): number => (dur <= 0 ? (t >= t0 ? 1 : 0) : clamp((t - t0) / dur));

export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

export const easeInCubic = (t: number): number => t * t * t;
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
export const easeOutQuart = (t: number): number => 1 - Math.pow(1 - t, 4);
export const easeOutExpo = (t: number): number => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
export const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeInOutSine = (t: number): number => -(Math.cos(Math.PI * t) - 1) / 2;
export const easeInOutQuint = (t: number): number => (t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2);

/** Ease out with a single overshoot of roughly `amount` (0.1 = 10 percent) before settling. */
export const easeOutBack = (t: number, amount = 1.4): number => {
  const c3 = amount + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + amount * Math.pow(t - 1, 2);
};

/** A damped spring step response: 0 -> 1 with decaying oscillation. zeta < 1 overshoots. */
export const spring = (t: number, freq = 2.2, zeta = 0.42): number => {
  if (t <= 0) return 0;
  if (t >= 1.6) return 1;
  const w = 2 * Math.PI * freq;
  const wd = w * Math.sqrt(1 - zeta * zeta);
  const e = Math.exp(-zeta * w * t);
  return 1 - e * (Math.cos(wd * t) + ((zeta * w) / wd) * Math.sin(wd * t));
};

/** CSS-style cubic-bezier(x1, y1, x2, y2) solved by Newton then bisection. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sy = (u: number) => ((ay * u + by) * u + cy) * u;
  const dx = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let u = x;
    for (let i = 0; i < 6; i++) {
      const err = sx(u) - x;
      const d = dx(u);
      if (Math.abs(err) < 1e-6) return sy(u);
      if (Math.abs(d) < 1e-6) break;
      u -= err / d;
    }
    let lo = 0;
    let hi = 1;
    u = x;
    for (let i = 0; i < 24; i++) {
      const v = sx(u);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = u;
      else hi = u;
      u = (lo + hi) / 2;
    }
    return sy(u);
  };
}

/** The app's UI curve (SPEC 3.5). */
export const easeUi = cubicBezier(0.25, 0.1, 0.25, 1);
/** A burin stroke: a quick bite, a long even cut, a gentle lift. */
export const easeBurin = cubicBezier(0.55, 0.05, 0.25, 1);
/** Heavy instrument parts: slow start, confident settle. */
export const easeHeavy = cubicBezier(0.7, 0, 0.2, 1);

/** Deterministic 32-bit hash of a string (FNV-1a), for stable per-id variation. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 seeded PRNG: deterministic, returns [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash-derived value in [0, 1) for (id, salt). */
export const hash01 = (id: string, salt = 0): number => prng(hashString(id) ^ Math.imul(salt + 1, 0x9e3779b1))();

/**
 * First-order smoothing toward a piecewise-constant target, evaluated analytically:
 * x' = k (target - x). `steps` are (time, target) sorted by time; x(t0) = initial.
 * Pure: the same inputs and t always give the same value, so seeking is exact.
 */
export function smoothTowards(steps: ReadonlyArray<{ t: number; v: number }>, t: number, ratePerMs: number, initial = 0): number {
  let x = initial;
  let tPrev = steps.length ? steps[0].t : t;
  let target = initial;
  for (const s of steps) {
    if (s.t > t) break;
    x = target + (x - target) * Math.exp(-ratePerMs * Math.max(0, s.t - tPrev));
    tPrev = s.t;
    target = s.v;
  }
  return target + (x - target) * Math.exp(-ratePerMs * Math.max(0, t - tPrev));
}
