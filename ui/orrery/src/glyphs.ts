import { GLYPH_GEOMETRY, type GlyphFamily, type GlyphPrimitive } from '@orrery/design/glyph-geometry';
import { AgentFamily } from './types';

/** Orrery family names to the design system's glyph families (same symbols everywhere). */
const FAMILY_TO_GLYPH: Record<AgentFamily, GlyphFamily> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  github: 'github-microsoft',
  cursor: 'cursor',
  'open-source': 'open-source-clis',
  chinese: 'chinese-labs',
  other: 'other',
};

const pathCache = new Map<string, Path2D | null>();

function path2d(d: string): Path2D | null {
  if (!pathCache.has(d)) {
    pathCache.set(d, typeof Path2D === 'function' ? new Path2D(d) : null);
  }
  return pathCache.get(d) ?? null;
}

function drawPrimitive(ctx: CanvasRenderingContext2D, p: GlyphPrimitive, scale: number): void {
  const lineWidth = Math.max(0.8, (p.sw ?? 1.25) * scale) / scale;
  ctx.lineWidth = lineWidth;
  if (typeof ctx.setLineDash === 'function') ctx.setLineDash(p.dash ? [p.dash[0], p.dash[1]] : []);

  if (p.kind === 'path') {
    const path = path2d(p.d);
    if (!path) return;
    if (p.fill) ctx.fill(path);
    if (!p.noStroke) ctx.stroke(path);
    return;
  }

  ctx.beginPath();
  if (p.kind === 'circle') {
    ctx.arc(p.cx, p.cy, p.r, 0, Math.PI * 2);
  } else if (typeof ctx.ellipse === 'function') {
    ctx.ellipse(p.cx, p.cy, p.rx, p.ry, ((p.rotate ?? 0) * Math.PI) / 180, 0, Math.PI * 2);
  }
  if (p.fill) ctx.fill();
  if (!p.noStroke) ctx.stroke();
}

/**
 * Draws an agent family's engraved glyph (the shared design geometry) centred at x, y.
 * `r` is the glyph's half size in CSS px; hairline flourishes are dropped below 16 px so the
 * symbol stays legible on small planets.
 */
export function drawAgentGlyph(
  ctx: CanvasRenderingContext2D,
  family: AgentFamily,
  x: number,
  y: number,
  r: number,
  color: string
): void {
  const geometry = GLYPH_GEOMETRY[FAMILY_TO_GLYPH[family] ?? 'other'];
  const size = r * 2;
  const scale = size / 24;
  const small = size < 16;

  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(scale, scale);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const p of geometry) {
    if (small && p.detail) continue;
    drawPrimitive(ctx, p, scale);
  }
  if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
  ctx.restore();
}
