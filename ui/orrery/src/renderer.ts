import { ObservatoryPalette } from './colors';
import { drawAgentGlyph } from './glyphs';
import { computeLabelLayout, getPlaqueRect } from './collision';
import { SWING_DURATION_MS } from './animation';
import { ORRERY_FRAME } from './seam';
import {
  AgentFamily,
  OrreryLayout,
  OrreryMoon,
  OrreryPlanet,
  OrrerySun,
  OrreryTheme,
  WaitingLabelLayout,
} from './types';

/**
 * The Orrery's Canvas 2D renderer: an engraved instrument in the language of the first run.
 * Pure: every frame is a function of (layout, rc.timestamp, hover/focus); no clocks are read here.
 */
export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  dpr: number;
  theme: OrreryTheme;
  palette: ObservatoryPalette;
  layout: OrreryLayout;
  hoveredPlanet: OrreryPlanet | null;
  hoveredSun: OrrerySun | null;
  focusedPlanet: OrreryPlanet | null;
  focusedMoon?: OrreryMoon | null;
  /** Host animation time t in ms (the one injectable clock). */
  timestamp: number;
  reducedMotion?: boolean;
}

/** Frame geometry (CSS px from the canvas edge), shared with the first run's handoff. */
export const FRAME_METRICS = {
  outer: ORRERY_FRAME.outerInset,
  inner: ORRERY_FRAME.innerInset,
  /** Degrees spanned by the top and bottom scales. */
  scaleDegrees: ORRERY_FRAME.scaleDegrees,
} as const;

/** One-off needs-you effects after the 600 ms swing lands. */
export const NEEDS_YOU_PULSE_MS = 1100;
export const NEEDS_YOU_GLINT_MS = 560;
const LABEL_FADE_MS = 220;
/** Lining figures for elapsed time (Cormorant's old-style 1 reads as an i at this size). */
const TIME_FONT = '600 12px "Instrument Sans", system-ui, sans-serif';

const TAU = Math.PI * 2;

// ---------- small, stub-tolerant canvas helpers ----------

function has(ctx: CanvasRenderingContext2D, name: string): boolean {
  return typeof (ctx as unknown as Record<string, unknown>)[name] === 'function';
}

function measure(ctx: CanvasRenderingContext2D, text: string, approxCharWidth: number): number {
  if (has(ctx, 'measureText')) {
    const w = ctx.measureText(text)?.width;
    if (typeof w === 'number' && Number.isFinite(w) && w > 0) return w;
  }
  return text.length * approxCharWidth;
}

function setSpacing(ctx: CanvasRenderingContext2D, px: number): void {
  const c = ctx as unknown as { letterSpacing?: string };
  if ('letterSpacing' in (ctx as object)) c.letterSpacing = `${px}px`;
}

function dash(ctx: CanvasRenderingContext2D, pattern: number[]): void {
  if (has(ctx, 'setLineDash')) ctx.setLineDash(pattern);
}

/** Text with an ink knockout so it stays legible where hairlines cross it. */
function engravedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fill: string,
  knockout: string,
  knockoutWidth = 4,
): void {
  if (has(ctx, 'strokeText')) {
    ctx.save();
    ctx.strokeStyle = knockout;
    ctx.lineWidth = knockoutWidth;
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 1;
    ctx.strokeText(text, x, y);
    ctx.restore();
  }
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.lineTo(x + s, y);
  ctx.lineTo(x, y + s);
  ctx.lineTo(x - s, y);
  ctx.closePath();
}

function easeOut(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - c, 3);
}

function seeded(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// ---------- backdrop and frame ----------

interface Star {
  x: number;
  y: number;
  r: number;
  a: number;
  bright: boolean;
}

const starCache = new Map<string, Star[]>();

function starfield(width: number, height: number): Star[] {
  const key = `${Math.round(width)}x${Math.round(height)}`;
  const cached = starCache.get(key);
  if (cached) return cached;
  const rand = seeded(1337);
  const count = Math.round((width * height) / 9000);
  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    const bright = rand() > 0.94;
    stars.push({
      x: rand() * width,
      y: rand() * height,
      r: bright ? 0.9 + rand() * 0.5 : 0.35 + rand() * 0.55,
      a: bright ? 0.55 + rand() * 0.25 : 0.12 + rand() * 0.3,
      bright,
    });
  }
  starCache.set(key, stars);
  return stars;
}

function drawBackdrop(rc: RenderContext): void {
  const { ctx, width, height, theme, palette } = rc;
  const dark = theme === 'dark';

  ctx.fillStyle = palette.ink0;
  ctx.fillRect(0, 0, width, height);

  // Depth from an ink step, not a glow: the plate is a touch lighter towards its centre.
  if (has(ctx, 'createRadialGradient')) {
    const g = ctx.createRadialGradient(width * 0.5, height * 0.46, 0, width * 0.5, height * 0.5, Math.max(width, height) * 0.62);
    g.addColorStop(0, dark ? palette.ink1 : palette.parchment);
    g.addColorStop(1, palette.ink0);
    ctx.save();
    ctx.globalAlpha = dark ? 0.85 : 0.7;
    ctx.fillStyle = g as unknown as string;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  // Fixed star field (it does not twinkle: nothing loops just to look busy).
  ctx.save();
  ctx.fillStyle = dark ? palette.star : palette.dust;
  for (const s of starfield(width, height)) {
    ctx.globalAlpha = s.a * (dark ? 0.55 : 0.28);
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, TAU);
    ctx.fill();
    if (s.bright && dark) {
      ctx.globalAlpha = s.a * 0.35;
      ctx.strokeStyle = palette.star;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(s.x - 3.2, s.y);
      ctx.lineTo(s.x + 3.2, s.y);
      ctx.moveTo(s.x, s.y - 3.2);
      ctx.lineTo(s.x, s.y + 3.2);
      ctx.stroke();
    }
  }
  ctx.restore();

  // Celestial coordinate arcs, very faint.
  ctx.save();
  ctx.strokeStyle = palette.line;
  ctx.lineWidth = 0.75;
  ctx.globalAlpha = dark ? 0.32 : 0.4;
  ctx.beginPath();
  ctx.arc(width / 2, height * 1.02, width * 0.46, Math.PI, TAU);
  ctx.stroke();
  ctx.globalAlpha = dark ? 0.2 : 0.26;
  ctx.beginPath();
  ctx.arc(width / 2, height * 1.02, width * 0.72, Math.PI, TAU);
  ctx.stroke();
  ctx.restore();

  drawFrame(rc);
}

/** Double gilt hairline frame with a burin-cut degree scale along the top and bottom bands. */
function drawFrame(rc: RenderContext): void {
  const { ctx, width, height, palette, theme } = rc;
  const dark = theme === 'dark';
  const o = FRAME_METRICS.outer;
  const i = FRAME_METRICS.inner;

  ctx.save();
  ctx.strokeStyle = palette.gilt;
  ctx.lineWidth = 0.75;
  ctx.globalAlpha = dark ? 0.55 : 0.7;
  ctx.strokeRect(o, o, width - 2 * o, height - 2 * o);
  ctx.globalAlpha = dark ? 0.35 : 0.5;
  ctx.strokeRect(i, i, width - 2 * i, height - 2 * i);

  // Degree scale: minor every 2 degrees, mid every 10, numerals every 30.
  const x0 = i;
  const x1 = width - i;
  const span = x1 - x0;
  const deg = FRAME_METRICS.scaleDegrees;
  ctx.strokeStyle = palette.gilt;
  const T = ORRERY_FRAME.tickLength;
  for (let d = 0; d <= deg; d += ORRERY_FRAME.minorTickDeg) {
    const x = x0 + (span * d) / deg;
    const major = d % ORRERY_FRAME.majorTickDeg === 0;
    const mid = d % ORRERY_FRAME.midTickDeg === 0;
    const len = major ? T.major : mid ? T.mid : T.minor;
    ctx.globalAlpha = (major ? 0.75 : mid ? 0.5 : 0.3) * (dark ? 1 : 1.1);
    ctx.lineWidth = major ? 0.9 : 0.6;
    ctx.beginPath();
    ctx.moveTo(x, i);
    ctx.lineTo(x, i - len);
    ctx.moveTo(x, height - i);
    ctx.lineTo(x, height - i + len);
    ctx.stroke();
  }
  // Side bands: declination ticks every 10 degrees.
  const y0 = i;
  const y1 = height - i;
  for (let d = 0; d <= 180; d += 10) {
    const y = y0 + ((y1 - y0) * d) / 180;
    const major = d % 30 === 0;
    ctx.globalAlpha = major ? 0.6 : 0.32;
    ctx.lineWidth = major ? 0.9 : 0.6;
    const len = major ? 6 : 3.5;
    ctx.beginPath();
    ctx.moveTo(i, y);
    ctx.lineTo(i - len, y);
    ctx.moveTo(width - i, y);
    ctx.lineTo(width - i + len, y);
    ctx.stroke();
  }

  // Numerals, engraved small in the band, skipping the ends.
  ctx.font = '600 10px "Cormorant Garamond", Cormorant, Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = palette.giltText;
  ctx.globalAlpha = dark ? 0.8 : 0.9;
  for (let d = ORRERY_FRAME.numeralDeg; d < deg; d += ORRERY_FRAME.numeralDeg) {
    const x = x0 + (span * d) / deg;
    const label = `${d}°`;
    const w = measure(ctx, label, 5.5) / 2 + 3;
    // clear a small gap in the inner line so the numeral sits in the band
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.ink0;
    ctx.fillRect(x - w, (o + i) / 2 - 5, w * 2, 10);
    ctx.fillRect(x - w, height - (o + i) / 2 - 5, w * 2, 10);
    ctx.restore();
    ctx.fillText(label, x, (o + i) / 2 + 0.5);
    ctx.fillText(label, x, height - (o + i) / 2 + 0.5);
  }

  // Corner rosettes: a quarter arc and a diamond where the two rules meet.
  const corners: Array<[number, number, number, number]> = [
    [i, i, 1, 1],
    [width - i, i, -1, 1],
    [i, height - i, 1, -1],
    [width - i, height - i, -1, -1],
  ];
  ctx.strokeStyle = palette.gilt;
  ctx.fillStyle = palette.gilt;
  for (const [cx, cy, sx, sy] of corners) {
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 0.75;
    // The quarter arc opens into the plate: start angle by corner.
    const start = sx > 0 ? (sy > 0 ? 0 : -Math.PI / 2) : sy > 0 ? Math.PI / 2 : Math.PI;
    ctx.beginPath();
    ctx.arc(cx, cy, 9, start, start + Math.PI / 2);
    ctx.stroke();
    ctx.globalAlpha = 0.85;
    diamond(ctx, cx - sx * (i - o) * 0.5, cy - sy * (i - o) * 0.5, 2.6);
    ctx.fill();
  }
  ctx.restore();
}

// ---------- suns ----------

/** A sun as an engraved instrument: graduated ring, rays in splendour, a hatched medallion. */
function drawSun(sun: OrrerySun, rc: RenderContext): void {
  const { ctx, palette, hoveredSun, theme } = rc;
  const dark = theme === 'dark';
  const hovered = hoveredSun?.id === sun.id;
  const R = sun.radius;

  ctx.save();
  ctx.translate(sun.x, sun.y);

  // Ink step behind the instrument.
  ctx.fillStyle = dark ? palette.ink1 : palette.parchment;
  ctx.globalAlpha = dark ? 0.7 : 0.75;
  ctx.beginPath();
  ctx.arc(0, 0, R + 21, 0, TAU);
  ctx.fill();

  // Graduated ring.
  ctx.strokeStyle = palette.gilt;
  ctx.lineWidth = 0.75;
  ctx.globalAlpha = hovered ? 0.75 : 0.5;
  ctx.beginPath();
  ctx.arc(0, 0, R + 17, 0, TAU);
  ctx.stroke();
  for (let k = 0; k < 72; k++) {
    const a = (k * TAU) / 72;
    const major = k % 6 === 0;
    const inner = R + 17 - (major ? 4 : 2);
    ctx.globalAlpha = (major ? 0.75 : 0.4) * (hovered ? 1.15 : 1);
    ctx.lineWidth = major ? 0.8 : 0.55;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
    ctx.lineTo(Math.cos(a) * (R + 17), Math.sin(a) * (R + 17));
    ctx.stroke();
  }

  // Rays in splendour: straight tapered rays alternating with wavy flames.
  const rays = 12;
  for (let k = 0; k < rays * 2; k++) {
    const a = (k * TAU) / (rays * 2) - Math.PI / 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    if (k % 2 === 0) {
      const r0 = R + 2.5;
      const r1 = R + (hovered ? 14 : 12.5);
      const half = 0.06;
      ctx.fillStyle = palette.gilt;
      ctx.globalAlpha = hovered ? 0.95 : 0.8;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a - half) * r0, Math.sin(a - half) * r0);
      ctx.lineTo(ca * r1, sa * r1);
      ctx.lineTo(Math.cos(a + half) * r0, Math.sin(a + half) * r0);
      ctx.closePath();
      ctx.fill();
    } else {
      const r0 = R + 2.5;
      const r1 = R + (hovered ? 11 : 9.5);
      ctx.strokeStyle = palette.gilt;
      ctx.lineWidth = 0.7;
      ctx.globalAlpha = hovered ? 0.85 : 0.6;
      ctx.beginPath();
      const steps = 8;
      for (let s = 0; s <= steps; s++) {
        const f = s / steps;
        const rr = r0 + (r1 - r0) * f;
        const wobble = Math.sin(f * Math.PI * 2) * 1.6 * (1 - f * 0.4);
        const x = ca * rr - sa * wobble;
        const y = sa * rr + ca * wobble;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  // The medallion: a gilt wash with a metallic sheen from the upper left, engraved rings, a boss.
  ctx.globalAlpha = 1;
  ctx.fillStyle = palette.ink0;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, TAU);
  ctx.fill();
  ctx.fillStyle = palette.gilt;
  ctx.globalAlpha = dark ? 0.26 : 0.34;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, TAU);
  ctx.fill();
  if (has(ctx, 'createRadialGradient')) {
    const sheen = ctx.createRadialGradient(-R * 0.35, -R * 0.4, 0, -R * 0.35, -R * 0.4, R * 1.1);
    sheen.addColorStop(0, palette.giltSoft);
    sheen.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sheen as unknown as string;
    ctx.globalAlpha = dark ? 0.45 : 0.3;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fill();
  }
  ctx.strokeStyle = palette.gilt;
  for (const [f, w, a] of [[0.34, 0.6, 0.55], [0.6, 0.6, 0.45], [0.82, 0.5, 0.4]] as const) {
    ctx.lineWidth = w;
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(0, 0, R * f, 0, TAU);
    ctx.stroke();
  }
  // Fine radial hatching between the inner rings, like a burin-cut face.
  ctx.lineWidth = 0.45;
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  for (let k = 0; k < 24; k++) {
    const a = (k * TAU) / 24;
    ctx.moveTo(Math.cos(a) * R * 0.36, Math.sin(a) * R * 0.36);
    ctx.lineTo(Math.cos(a) * R * 0.58, Math.sin(a) * R * 0.58);
  }
  ctx.stroke();
  ctx.fillStyle = palette.giltSoft;
  ctx.globalAlpha = 0.95;
  diamond(ctx, 0, 0, 3);
  ctx.fill();
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = palette.gilt;
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, TAU);
  ctx.stroke();
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = palette.giltSoft;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.arc(0, 0, R - 1.6, 0, TAU);
  ctx.stroke();

  ctx.restore();
}

/** The project name engraved above its sun, with a hairline rule and a diamond. */
function drawSunName(sun: OrrerySun, rc: RenderContext): void {
  const { ctx, palette, hoveredSun } = rc;
  const hovered = hoveredSun?.id === sun.id;
  const plaque = getPlaqueRect(sun);
  const cy = plaque.y + plaque.height / 2;
  const name = sun.project.name.toUpperCase();

  ctx.save();
  ctx.font = '600 13px "Cormorant Garamond", Cormorant, Georgia, serif';
  setSpacing(ctx, 1.6);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = 1;
  engravedText(ctx, name, sun.x, cy, hovered ? palette.star : palette.giltText, palette.ink0, 5);
  const w = Math.min(plaque.width, measure(ctx, name, 8.6) + 10);
  setSpacing(ctx, 0);
  ctx.strokeStyle = palette.gilt;
  ctx.lineWidth = 0.75;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.moveTo(sun.x - w / 2, cy + 9);
  ctx.lineTo(sun.x - 4, cy + 9);
  ctx.moveTo(sun.x + 4, cy + 9);
  ctx.lineTo(sun.x + w / 2, cy + 9);
  ctx.stroke();
  ctx.fillStyle = palette.gilt;
  ctx.globalAlpha = 0.85;
  diamond(ctx, sun.x, cy + 9, 2.2);
  ctx.fill();
  ctx.restore();
}

// ---------- orbits ----------

function drawOrbit(planet: OrreryPlanet, sun: OrrerySun, rc: RenderContext): void {
  const { ctx, palette, theme } = rc;
  const dark = theme === 'dark';

  ctx.save();
  ctx.translate(sun.x, sun.y);
  ctx.rotate(planet.orbitTilt);
  ctx.beginPath();
  ctx.ellipse(0, 0, planet.orbitSemiMajor, planet.orbitSemiMinor, 0, 0, TAU);

  if (planet.isDoneRing) {
    ctx.strokeStyle = palette.verdigris;
    ctx.lineWidth = 0.75;
    ctx.globalAlpha = dark ? 0.55 : 0.6;
    dash(ctx, [0.5, 3.5]);
    ctx.lineCap = 'round';
    ctx.stroke();
    dash(ctx, []);
  } else {
    ctx.strokeStyle = palette.line;
    ctx.lineWidth = 0.75;
    ctx.globalAlpha = dark ? 0.9 : 0.85;
    ctx.stroke();
    ctx.strokeStyle = palette.gilt;
    ctx.globalAlpha = dark ? 0.16 : 0.2;
    ctx.stroke();
  }
  ctx.restore();
}

/** A short gilt wake behind a working planet, fading back along its orbit. */
function drawTrail(planet: OrreryPlanet, sun: OrrerySun, rc: RenderContext): void {
  const { ctx, palette, theme } = rc;
  if (rc.reducedMotion || planet.isDoneRing || planet.session.state !== 'working') return;
  const length = 0.62;
  const segments = 10;
  ctx.save();
  ctx.translate(sun.x, sun.y);
  ctx.rotate(planet.orbitTilt);
  ctx.strokeStyle = theme === 'dark' ? palette.giltSoft : palette.gilt;
  ctx.lineCap = 'round';
  for (let s = 0; s < segments; s++) {
    const a0 = planet.angle - length + (length * s) / segments;
    const a1 = planet.angle - length + (length * (s + 1)) / segments;
    const f = (s + 1) / segments;
    ctx.globalAlpha = 0.6 * f * f;
    ctx.lineWidth = 0.6 + 0.9 * f;
    ctx.beginPath();
    ctx.ellipse(0, 0, planet.orbitSemiMajor, planet.orbitSemiMinor, 0, a0, a1);
    ctx.stroke();
  }
  ctx.restore();
}

// ---------- planets ----------

function glyphInk(rc: RenderContext): string {
  return rc.theme === 'dark' ? rc.palette.ink0 : rc.palette.star;
}

/** Time since the needs-you swing landed (ms), or null when there is no fresh arrival to play. */
function sinceArrival(planet: OrreryPlanet, rc: RenderContext): number | null {
  if (rc.reducedMotion) return null;
  const start = planet.transitionStartTime;
  if (start === undefined || !Number.isFinite(start)) return null;
  return rc.timestamp - (start + SWING_DURATION_MS);
}

function drawNeedsYou(planet: OrreryPlanet, rc: RenderContext): void {
  const { ctx, palette } = rc;
  const r = planet.radius;
  const progress = rc.reducedMotion ? 1 : Math.max(0, Math.min(1, planet.transitionProgress ?? 1));
  const since = sinceArrival(planet, rc);

  ctx.save();
  // Steady halo: a wash and a sharp ring, faded in by the swing.
  ctx.fillStyle = palette.vermilion;
  ctx.globalAlpha = 0.16 * progress;
  ctx.beginPath();
  ctx.arc(0, 0, r + 8, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = palette.vermilion;
  ctx.lineWidth = 1.25;
  ctx.globalAlpha = 0.95 * progress;
  ctx.beginPath();
  ctx.arc(0, 0, r + 4, 0, TAU);
  ctx.stroke();

  // The halo pulses once when the planet arrives at the front.
  if (since !== null && since >= 0 && since < NEEDS_YOU_PULSE_MS) {
    const f = since / NEEDS_YOU_PULSE_MS;
    ctx.globalAlpha = 0.8 * (1 - f);
    ctx.lineWidth = 1.4 - f * 0.9;
    ctx.beginPath();
    ctx.arc(0, 0, r + 4 + 22 * easeOut(f), 0, TAU);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBellGlint(planet: OrreryPlanet, rc: RenderContext): void {
  const since = sinceArrival(planet, rc);
  if (since === null || since < 0 || since >= NEEDS_YOU_GLINT_MS) return;
  const { ctx, palette } = rc;
  const f = since / NEEDS_YOU_GLINT_MS;
  const size = 8 * Math.sin(Math.PI * f);
  const x = planet.radius * 0.78;
  const y = -planet.radius * 0.78;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(0.35 * f);
  ctx.fillStyle = palette.giltSoft;
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(size * 0.18, -size * 0.18);
  ctx.lineTo(size, 0);
  ctx.lineTo(size * 0.18, size * 0.18);
  ctx.lineTo(0, size);
  ctx.lineTo(-size * 0.18, size * 0.18);
  ctx.lineTo(-size, 0);
  ctx.lineTo(-size * 0.18, -size * 0.18);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Engraved terminator: the side facing away from its sun is shaded with fine hatching. */
function drawShading(planet: OrreryPlanet, sun: OrrerySun | undefined, rc: RenderContext): void {
  const { ctx, palette, theme } = rc;
  if (!sun || !has(ctx, 'clip')) return;
  const r = planet.radius;
  let lx = sun.x - planet.currentX;
  let ly = sun.y - planet.currentY;
  const len = Math.hypot(lx, ly) || 1;
  lx /= len;
  ly /= len;
  const ink = theme === 'dark' ? palette.ink0 : palette.star;

  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.arc(lx * r * 0.62, ly * r * 0.62, r * 1.04, 0, TAU);
  ctx.clip('evenodd');
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.clip();
  ctx.fillStyle = ink;
  ctx.globalAlpha = theme === 'dark' ? 0.3 : 0.22;
  ctx.fillRect(-r, -r, r * 2, r * 2);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.5;
  ctx.globalAlpha = theme === 'dark' ? 0.45 : 0.35;
  ctx.beginPath();
  const px = -ly;
  const py = lx;
  for (let k = -r; k <= r; k += 1.8) {
    ctx.moveTo(px * -r + lx * k, py * -r + ly * k);
    ctx.lineTo(px * r + lx * k, py * r + ly * k);
  }
  ctx.stroke();
  ctx.restore();
}

function drawPlanet(planet: OrreryPlanet, sun: OrrerySun | undefined, rc: RenderContext): void {
  const { ctx, palette, hoveredPlanet, focusedPlanet, theme } = rc;
  const state = planet.session.state as string;
  const waiting = state === 'waiting';
  const done = state === 'done';
  const idle = state === 'idle';
  const unknown = state === 'unknown';
  const hovered = hoveredPlanet?.id === planet.id;
  const focused = focusedPlanet?.id === planet.id && !rc.focusedMoon;
  const r = planet.radius;

  const family = palette.agents[planet.session.family] || palette.agents.other;
  const body = done ? palette.verdigris : family;

  ctx.save();
  ctx.translate(planet.currentX, planet.currentY);

  if (waiting) drawNeedsYou(planet, rc);

  ctx.save();
  ctx.globalAlpha = idle ? 0.5 : unknown ? 0.6 : 1;
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();
  ctx.restore();

  if (!done) {
    ctx.save();
    ctx.globalAlpha = idle ? 0.5 : 1;
    drawShading(planet, sun, rc);
    ctx.restore();
  }

  // Rim: a light hairline at night, an ink line by day; dashed when the state or parent is unknown.
  ctx.save();
  ctx.strokeStyle = theme === 'dark' ? palette.star : palette.star;
  ctx.lineWidth = 0.75;
  ctx.globalAlpha = theme === 'dark' ? (idle ? 0.3 : 0.55) : idle ? 0.35 : 0.6;
  if (unknown || planet.isOrphan) dash(ctx, [1.5, 1.8]);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.stroke();
  dash(ctx, []);
  ctx.restore();

  if (r >= 5) {
    ctx.save();
    ctx.globalAlpha = idle ? 0.55 : 0.9;
    drawAgentGlyph(ctx, planet.session.family, 0, 0, r * 0.74, glyphInk(rc));
    ctx.restore();
  }

  if (waiting) drawBellGlint(planet, rc);

  // Keyboard focus is a sighting reticle; hover a lighter ring.
  if (focused || hovered) {
    ctx.save();
    ctx.strokeStyle = focused ? palette.giltSoft : palette.gilt;
    ctx.lineWidth = focused ? 1.25 : 0.9;
    ctx.globalAlpha = focused ? 1 : 0.8;
    const rr = r + (waiting ? 10 : 6);
    ctx.beginPath();
    ctx.arc(0, 0, rr, 0, TAU);
    ctx.stroke();
    if (focused) {
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        ctx.moveTo(dx * (rr + 2), dy * (rr + 2));
        ctx.lineTo(dx * (rr + 6), dy * (rr + 6));
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.restore();

  for (const moon of planet.moons) drawMoon(moon, rc);
}

function drawMoon(moon: OrreryMoon, rc: RenderContext): void {
  const { ctx, palette, theme } = rc;
  const parentX = moon.x - Math.cos(moon.angle) * moon.orbitRadius;
  const parentY = moon.y - Math.sin(moon.angle) * moon.orbitRadius;

  ctx.save();
  ctx.strokeStyle = palette.gilt;
  ctx.lineWidth = 0.5;
  ctx.globalAlpha = 0.35;
  dash(ctx, [0.5, 2.5]);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(parentX, parentY, moon.orbitRadius, 0, TAU);
  ctx.stroke();
  dash(ctx, []);

  const family = palette.agents[moon.session.family as AgentFamily] || palette.agents.other;
  ctx.fillStyle = family;
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(moon.x, moon.y, moon.radius, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = palette.star;
  ctx.lineWidth = 0.5;
  ctx.globalAlpha = theme === 'dark' ? 0.55 : 0.6;
  ctx.stroke();
  ctx.restore();

  if (moon.session.state === 'waiting') {
    ctx.save();
    ctx.fillStyle = palette.vermilion;
    ctx.globalAlpha = 0.16;
    ctx.beginPath();
    ctx.arc(moon.x, moon.y, moon.radius + 5, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = palette.vermilion;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.arc(moon.x, moon.y, moon.radius + 2.5, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  if (rc.focusedMoon?.id === moon.id) {
    ctx.save();
    ctx.strokeStyle = palette.giltSoft;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(moon.x, moon.y, moon.radius + 4.5, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }
}

// ---------- labels and tooltip ----------

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** "NEEDS YOU  2m": a plate with a vermilion bar, the time in Cormorant. Fades in as the swing lands. */
function drawNeedsYouLabel(label: WaitingLabelLayout, planet: OrreryPlanet, rc: RenderContext): void {
  const { ctx, palette } = rc;
  const since = sinceArrival(planet, rc);
  const progress = rc.reducedMotion ? 1 : planet.transitionProgress ?? 1;
  const alpha = since === null ? (progress >= 1 ? 1 : 0) : Math.max(0, Math.min(1, since / LABEL_FADE_MS));
  if (alpha <= 0) return;

  const word = 'NEEDS YOU';
  const time = formatElapsed(planet.waitingElapsedMs ?? 0);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = '600 10px "Instrument Sans", system-ui, sans-serif';
  setSpacing(ctx, 1.1);
  const wordW = measure(ctx, word, 7.2);
  setSpacing(ctx, 0);
  ctx.font = TIME_FONT;
  const timeW = measure(ctx, time, 7);
  const padX = 9;
  const gap = 8;
  const w = Math.max(label.width, padX * 2 + 3 + wordW + gap + timeW);
  const h = 22;
  const cx = label.x + label.width / 2;
  const x = Math.round(cx - w / 2);
  const y = Math.round(label.y + label.height / 2 - h / 2);

  ctx.fillStyle = palette.ink1;
  ctx.globalAlpha = 0.96 * alpha;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = palette.vermilion;
  ctx.lineWidth = 0.75;
  ctx.globalAlpha = 0.45 * alpha;
  ctx.strokeRect(x + 0.375, y + 0.375, w - 0.75, h - 0.75);
  ctx.fillStyle = palette.vermilion;
  ctx.globalAlpha = alpha;
  ctx.fillRect(x, y, 2, h);

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = '600 10px "Instrument Sans", system-ui, sans-serif';
  setSpacing(ctx, 1.1);
  ctx.fillStyle = palette.vermilionText;
  const contentW = wordW + gap + timeW;
  const tx = x + 3 + (w - 3 - contentW) / 2;
  ctx.fillText(word, tx, y + h / 2 + 0.5);
  setSpacing(ctx, 0);
  ctx.font = TIME_FONT;
  ctx.fillStyle = palette.star;
  ctx.fillText(time, tx + wordW + gap, y + h / 2 + 0.5);
  ctx.restore();
}

function drawLeader(label: WaitingLabelLayout, planet: OrreryPlanet, rc: RenderContext): void {
  const { ctx, palette } = rc;
  const progress = rc.reducedMotion ? 1 : planet.transitionProgress ?? 1;
  if (progress < 1) return;
  ctx.save();
  ctx.strokeStyle = palette.vermilion;
  ctx.fillStyle = palette.vermilion;
  ctx.lineWidth = 0.75;
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  if (label.leaderLine) {
    ctx.moveTo(label.leaderLine.fromX, label.leaderLine.fromY);
    ctx.lineTo(label.leaderLine.toX, label.leaderLine.toY);
  } else {
    ctx.moveTo(planet.currentX, planet.currentY + planet.radius + 5);
    ctx.lineTo(planet.currentX, label.y + label.height / 2 - 11);
  }
  ctx.stroke();
  ctx.restore();
}

function drawHoverCard(planet: OrreryPlanet, rc: RenderContext, projectName: string | undefined): void {
  const { ctx, width, height, palette } = rc;
  const s = planet.session;
  const pad = 12;

  ctx.save();
  ctx.font = '600 12.5px "Instrument Sans", system-ui, sans-serif';
  const agentW = measure(ctx, s.agent_id, 7);
  const stateLabel =
    s.state === 'waiting' ? 'Needs you' : s.state.charAt(0).toUpperCase() + s.state.slice(1);
  ctx.font = '500 11px "Instrument Sans", system-ui, sans-serif';
  const stateW = measure(ctx, stateLabel, 6);
  const boxW = Math.max(220, Math.min(300, agentW + stateW + pad * 2 + 30));
  const boxH = 78;

  let x = planet.currentX + planet.radius + 16;
  let y = planet.currentY - boxH / 2;
  if (x + boxW > width - 30) x = planet.currentX - planet.radius - 16 - boxW;
  y = Math.max(30, Math.min(height - boxH - 30, y));

  ctx.fillStyle = palette.ink1;
  ctx.globalAlpha = 0.97;
  ctx.fillRect(x, y, boxW, boxH);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = palette.line;
  ctx.lineWidth = 0.75;
  ctx.strokeRect(x + 0.375, y + 0.375, boxW - 0.75, boxH - 0.75);
  ctx.fillStyle = palette.agents[s.family] || palette.agents.other;
  ctx.fillRect(x, y, boxW, 1.5);

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = '600 12.5px "Instrument Sans", system-ui, sans-serif';
  ctx.fillStyle = palette.star;
  ctx.fillText(s.agent_id, x + pad, y + 22);

  ctx.textAlign = 'right';
  ctx.font = '500 11px "Instrument Sans", system-ui, sans-serif';
  ctx.fillStyle = s.state === 'waiting' ? palette.vermilionText : palette.dust;
  ctx.fillText(stateLabel, x + boxW - pad, y + 22);
  ctx.fillStyle = s.state === 'waiting' ? palette.vermilion : s.state === 'working' ? palette.gilt : palette.dust;
  ctx.beginPath();
  ctx.arc(x + boxW - pad - stateW - 8, y + 18.5, 2.6, 0, TAU);
  ctx.fill();

  ctx.textAlign = 'left';
  ctx.font = '400 12px "Instrument Sans", system-ui, sans-serif';
  ctx.fillStyle = palette.dust;
  let title = s.title || 'Untitled session';
  const maxW = boxW - pad * 2;
  if (measure(ctx, title, 6.4) > maxW) {
    while (title.length > 1 && measure(ctx, `${title}…`, 6.4) > maxW) title = title.slice(0, -1);
    title = `${title.trimEnd()}…`;
  }
  ctx.fillText(title, x + pad, y + 42);

  ctx.strokeStyle = palette.line;
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(x + pad, y + 52);
  ctx.lineTo(x + boxW - pad, y + 52);
  ctx.stroke();

  ctx.font = '600 15px "Cormorant Garamond", Cormorant, Georgia, serif';
  ctx.fillStyle = palette.star;
  const turns = String(s.turns);
  ctx.fillText(turns, x + pad, y + 69);
  const turnsW = measure(ctx, turns, 7.5);
  ctx.font = '400 11px "Instrument Sans", system-ui, sans-serif';
  ctx.fillStyle = palette.dust;
  const tail = projectName ? `turns  ·  ${projectName}` : 'turns';
  ctx.fillText(tail, x + pad + turnsW + 5, y + 68);
  ctx.restore();
}

// ---------- the frame ----------

export function renderOrrery(rc: RenderContext): void {
  const { ctx, width, height, layout, hoveredPlanet, palette } = rc;

  ctx.clearRect(0, 0, width, height);
  drawBackdrop(rc);

  const sunMap = new Map<string, OrrerySun>();
  for (const sun of layout.suns) sunMap.set(sun.id, sun);

  // The ecliptic: a faint dashed path from sun to sun.
  if (layout.suns.length > 1) {
    const sorted = [...layout.suns].sort((a, b) => a.x - b.x);
    ctx.save();
    ctx.strokeStyle = palette.gilt;
    ctx.lineWidth = 0.75;
    ctx.globalAlpha = 0.18;
    dash(ctx, [3, 6]);
    ctx.beginPath();
    ctx.moveTo(sorted[0].x, sorted[0].y);
    for (let k = 1; k < sorted.length; k++) {
      const prev = sorted[k - 1];
      const cur = sorted[k];
      const midX = (prev.x + cur.x) / 2;
      const midY = (prev.y + cur.y) / 2 - 18;
      if (has(ctx, 'quadraticCurveTo')) ctx.quadraticCurveTo(midX, midY, cur.x, cur.y);
      else ctx.lineTo(cur.x, cur.y);
    }
    ctx.stroke();
    dash(ctx, []);
    ctx.restore();
  }

  for (const planet of layout.planets) {
    const sun = sunMap.get(planet.sunId);
    if (sun) drawOrbit(planet, sun, rc);
  }
  for (const planet of layout.planets) {
    const sun = sunMap.get(planet.sunId);
    if (sun) drawTrail(planet, sun, rc);
  }
  for (const sun of layout.suns) drawSun(sun, rc);
  for (const sun of layout.suns) drawSunName(sun, rc);

  const labels = computeLabelLayout(layout.planets, layout.suns, { width, height });
  const planetById = new Map(layout.planets.map((p) => [p.id, p] as const));
  for (const label of labels) {
    const planet = planetById.get(label.planetId);
    if (planet) drawLeader(label, planet, rc);
  }

  const ordered = [...layout.planets].sort((a, b) => {
    if (a.isFront && !b.isFront) return 1;
    if (!a.isFront && b.isFront) return -1;
    return a.currentY - b.currentY;
  });
  for (const planet of ordered) drawPlanet(planet, sunMap.get(planet.sunId), rc);

  for (const label of labels) {
    const planet = planetById.get(label.planetId);
    if (planet) drawNeedsYouLabel(label, planet, rc);
  }

  if (hoveredPlanet) {
    drawHoverCard(hoveredPlanet, rc, sunMap.get(hoveredPlanet.sunId)?.project.name);
  }
}
