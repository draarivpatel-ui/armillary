/**
 * The 2D overlay shared by both renderers: the gilt rule around the window, every piece of text
 * (engraved letter by letter with a burin point), ring numerals etched along their bands, family
 * glyphs, the tally cartouche, and the hand-over suns, orbits and planets (drawn the way the
 * Orrery draws them, so the landing frame matches the live view).
 */
import { GLYPH_GEOMETRY, type GlyphPrimitive } from "../../../../design/src/glyphGeometry";
import { clamp, smoothstep } from "../math/ease";
import { C, css, FAMILY, FONT, mixRGB } from "../scene/palette";
import type { CartoucheState, Frame, OrbitDraw, PlanetDraw, RGB, RuleState, SunDraw, TextDraw } from "../scene/types";

const hexRGB = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
/** SPEC 3.1 Day almanac values (and the Orrery's light giltText), for the light-theme landing. */
const LIGHT = {
  ink0: hexRGB("#F3EBDA"),
  ink1: hexRGB("#EADFC8"),
  line: hexRGB("#C9B78F"),
  gilt: hexRGB("#8A6A22"),
  giltSoft: hexRGB("#A88634"),
  giltText: hexRGB("#5C4410"),
  star: hexRGB("#1D1A14"),
  verdigris: hexRGB("#2F6F62"),
};
/** The Orrery's family keys to the shared glyph geometry keys. */
const ORRERY_FAMILY_TO_GLYPH: Record<string, keyof typeof GLYPH_GEOMETRY> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  github: "github-microsoft",
  "github-microsoft": "github-microsoft",
  cursor: "cursor",
  "open-source": "open-source-clis",
  "open-source-clis": "open-source-clis",
  chinese: "chinese-labs",
  "chinese-labs": "chinese-labs",
  other: "other",
};

type Ctx = CanvasRenderingContext2D;

const glyphPaths = new Map<string, Path2D>();
function pathFor(d: string): Path2D | null {
  if (typeof Path2D === "undefined") return null;
  let p = glyphPaths.get(d);
  if (!p) {
    p = new Path2D(d);
    glyphPaths.set(d, p);
  }
  return p;
}

function drawGlyph(ctx: Ctx, prims: GlyphPrimitive[], x: number, y: number, size: number, color: string): void {
  const k = size / 24;
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(k, k);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const p of prims) {
    if (p.detail && size < 16) continue;
    ctx.lineWidth = (p.sw ?? 1.25) * 1.15;
    ctx.setLineDash(p.dash ?? []);
    if (p.kind === "path") {
      const path = pathFor(p.d);
      if (!path) continue;
      if (p.fill) ctx.fill(path);
      if (!p.noStroke) ctx.stroke(path);
    } else {
      ctx.beginPath();
      if (p.kind === "circle") ctx.arc(p.cx, p.cy, p.r, 0, Math.PI * 2);
      else ctx.ellipse(p.cx, p.cy, p.rx, p.ry, ((p.rotate ?? 0) * Math.PI) / 180, 0, Math.PI * 2);
      if (p.fill) ctx.fill();
      if (!p.noStroke) ctx.stroke();
    }
  }
  ctx.restore();
}

export class Overlay {
  private ctx: Ctx;
  private dpr = 1;
  private w = 1;
  private h = 1;
  private widthCache = new Map<string, number>();
  private parchment = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.w = cssW;
    this.h = cssH;
    this.dpr = dpr;
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
  }

  /** Text width with letter spacing, shared with the scene's label measurement. */
  measure(font: string, text: string, tracking: number): number {
    const key = font + "|" + tracking + "|" + text;
    const hit = this.widthCache.get(key);
    if (hit !== undefined) return hit;
    this.ctx.font = font;
    const w = this.ctx.measureText(text).width + Math.max(0, text.length - 1) * tracking;
    if (this.widthCache.size > 4000) this.widthCache.clear();
    this.widthCache.set(key, w);
    return w;
  }

  render(f: Frame): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.parchment = f.sky.parchment;
    this.drawRule(f.rule, f.sky.parchment);
    if (f.orbits.length) this.drawOrbits(f.orbits);
    if (f.suns.length) this.drawSuns(f.suns);
    if (f.planets.length) this.drawPlanets(f.planets);
    for (const t of f.texts) this.drawText(t);
    if (f.cartouche.alpha > 0.002) this.drawCartouche(f.cartouche);
  }

  // ------------------------------------------------------------------------------------------

  private drawRule(r: RuleState, parchment: number): void {
    if (r.draw <= 0 || r.alpha <= 0) return;
    const ctx = this.ctx;
    const { x, y, w, h } = r.rect;
    const gilt = css(mixRGB(C.gilt, C.giltDeep, parchment), r.alpha);
    const giltDim = css(mixRGB(C.gilt, C.giltDeep, parchment), r.alpha * 0.55);
    const per = 2 * (w + h);
    // Hairlines drawn from the top centre both ways, meeting at the bottom centre.
    const traced = (inset: number) => {
      const X = x + inset;
      const Y = y + inset;
      const W = w - 2 * inset;
      const H = h - 2 * inset;
      const P = 2 * (W + H);
      const len = (P / 2) * r.draw;
      const pathHalf = (dir: 1 | -1) => {
        // walk from top centre
        const pts: Array<[number, number]> = dir === 1
          ? [[X + W / 2, Y], [X + W, Y], [X + W, Y + H], [X + W / 2, Y + H]]
          : [[X + W / 2, Y], [X, Y], [X, Y + H], [X + W / 2, Y + H]];
        ctx.moveTo(pts[0][0], pts[0][1]);
        let left = len;
        for (let i = 1; i < pts.length && left > 0; i++) {
          const dx = pts[i][0] - pts[i - 1][0];
          const dy = pts[i][1] - pts[i - 1][1];
          const seg = Math.hypot(dx, dy);
          const k = Math.min(1, left / seg);
          ctx.lineTo(pts[i - 1][0] + dx * k, pts[i - 1][1] + dy * k);
          left -= seg;
        }
      };
      ctx.beginPath();
      pathHalf(1);
      pathHalf(-1);
      ctx.stroke();
      return P;
    };
    ctx.lineWidth = 0.75;
    ctx.strokeStyle = gilt;
    traced(0);
    if (r.band > 0.5) {
      ctx.strokeStyle = giltDim;
      traced(r.band);
    }
    // Burin point at the two drawing fronts.
    if (r.draw > 0 && r.draw < 1) {
      const P = per;
      const len = (P / 2) * r.draw;
      for (const dir of [1, -1] as const) {
        const pt = pointOnRect(x, y, w, h, dir, len);
        const g = ctx.createRadialGradient(pt[0], pt[1], 0, pt[0], pt[1], 7);
        g.addColorStop(0, "rgba(255, 244, 214, 0.95)");
        g.addColorStop(1, "rgba(255, 230, 170, 0)");
        ctx.fillStyle = g;
        ctx.fillRect(pt[0] - 7, pt[1] - 7, 14, 14);
      }
    }
    // Keys: alternate gilt and ink cells between the hairlines, filled in sequence around the frame.
    if (r.keys > 0 && r.band > 1.5) {
      const cells = 144;
      const shown = Math.floor(cells * r.keys);
      ctx.fillStyle = css(mixRGB(C.gilt, C.giltDeep, parchment), r.alpha * 0.42);
      const b = r.band;
      for (let i = 0; i < shown; i += 2) {
        const a0 = (i / cells) * per;
        const a1 = ((i + 1) / cells) * per;
        fillBandCell(ctx, x, y, w, h, b, a0, a1);
      }
      // Major ticks every 10 degrees (every fourth cell) reaching inward.
      ctx.strokeStyle = css(C.gilt, r.alpha * 0.55);
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      for (let i = 0; i < shown; i += 4) {
        const a = (i / cells) * per;
        const [px, py, nx, ny] = perimeterPoint(x, y, w, h, a);
        ctx.moveTo(px + nx * b, py + ny * b);
        ctx.lineTo(px + nx * (b + 5), py + ny * (b + 5));
      }
      ctx.stroke();
    }
    // Hand-over: the Orrery's own degree scale on the inner rule, ticks pointing outward.
    if (r.scale && r.scale.alpha > 0.01) {
      const sc = r.scale;
      const b = r.band;
      const ix = x + b;
      const iw = w - 2 * b;
      const top = y + b;
      const bottom = y + h - b;
      ctx.strokeStyle = css(C.gilt, 0.6 * sc.alpha);
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      for (let d = 0; d <= 360 + 1e-6; d += sc.minorTickDeg) {
        const tx = ix + (d / 360) * iw;
        const len = d % sc.majorTickDeg === 0 ? 7 : d % sc.midTickDeg === 0 ? 4.5 : 2.5;
        ctx.moveTo(tx, top);
        ctx.lineTo(tx, top - len);
        ctx.moveTo(tx, bottom);
        ctx.lineTo(tx, bottom + len);
      }
      ctx.stroke();
    }
    // Degree numerals every 30 degrees just inside the rule.
    if (r.numerals > 0) {
      const size = 13.5 * Math.min(this.w / 1440, this.h / 900);
      ctx.font = `600 ${Math.max(9.5, size).toFixed(2)}px ${FONT.display}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let d = 0; d < 360; d += 30) {
        const a = (d / 360) * per;
        const fade = clamp(r.numerals * 12 - (d / 360) * 11);
        if (fade <= 0) continue;
        const [px, py, nx, ny] = perimeterPoint(x, y, w, h, a);
        const off = r.band + 15;
        ctx.fillStyle = css(mixRGB(C.gilt, C.dust, 0.35), r.alpha * 0.85 * fade);
        ctx.fillText(`${d}°`, px + nx * off, py + ny * off);
      }
    }
  }

  // The Orrery's own designs (DS's ui/orrery renderer.ts), drawn with progress so the hand-over
  // resolves into exactly what the live Orrery draws next. Palette blends to the Day almanac with
  // the parchment cross.

  private pal(): { ink0: RGB; ink1: RGB; line: RGB; gilt: RGB; giltSoft: RGB; giltText: RGB; star: RGB; verdigris: RGB; dark: boolean } {
    const p = this.parchment;
    return {
      ink0: mixRGB(C.ink0, LIGHT.ink0, p),
      ink1: mixRGB(C.ink1, LIGHT.ink1, p),
      line: mixRGB(C.line, LIGHT.line, p),
      gilt: mixRGB(C.gilt, LIGHT.gilt, p),
      giltSoft: mixRGB(C.giltSoft, LIGHT.giltSoft, p),
      giltText: mixRGB(C.gilt, LIGHT.giltText, p),
      star: mixRGB(C.star, LIGHT.star, p),
      verdigris: mixRGB(C.verdigris, LIGHT.verdigris, p),
      dark: p < 0.5,
    };
  }

  private drawOrbits(orbits: OrbitDraw[]): void {
    const ctx = this.ctx;
    const P = this.pal();
    for (const o of orbits) {
      ctx.save();
      ctx.translate(o.cx, o.cy);
      ctx.rotate(o.tilt);
      ctx.beginPath();
      ctx.ellipse(0, 0, o.a, o.b, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * o.draw);
      ctx.lineWidth = 0.75;
      if (o.done) {
        ctx.strokeStyle = css(P.verdigris, (P.dark ? 0.55 : 0.6) * o.alpha);
        ctx.setLineDash([0.5, 3.5]);
        ctx.lineCap = "round";
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = css(P.line, (P.dark ? 0.9 : 0.85) * o.alpha);
        ctx.stroke();
        ctx.strokeStyle = css(P.gilt, (P.dark ? 0.16 : 0.2) * o.alpha);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawSuns(suns: SunDraw[]): void {
    const ctx = this.ctx;
    const P = this.pal();
    const TAU = Math.PI * 2;
    for (const s of suns) {
      if (s.r <= 0.2 || s.alpha <= 0.002) continue;
      const R = s.r;
      const A = s.alpha;
      ctx.save();
      ctx.translate(s.x, s.y);
      // Ink step behind the instrument.
      ctx.fillStyle = css(P.ink1, (P.dark ? 0.7 : 0.75) * A * smoothstep(0, 0.5, s.ring));
      ctx.beginPath();
      ctx.arc(0, 0, R + 21, 0, TAU);
      ctx.fill();
      // Graduated ring, drawn round from twelve o'clock; its ticks cut as the ring passes them.
      if (s.ring > 0) {
        ctx.strokeStyle = css(P.gilt, 0.5 * A);
        ctx.lineWidth = 0.75;
        ctx.beginPath();
        ctx.arc(0, 0, R + 17, -Math.PI / 2, -Math.PI / 2 + TAU * s.ring);
        ctx.stroke();
        for (let k = 0; k < 72; k++) {
          const a = (k * TAU) / 72;
          const along = (((a + Math.PI / 2) % TAU) + TAU) % TAU / TAU;
          if (along > s.ring) continue;
          const major = k % 6 === 0;
          const inner = R + 17 - (major ? 4 : 2);
          ctx.strokeStyle = css(P.gilt, (major ? 0.75 : 0.4) * A);
          ctx.lineWidth = major ? 0.8 : 0.55;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
          ctx.lineTo(Math.cos(a) * (R + 17), Math.sin(a) * (R + 17));
          ctx.stroke();
        }
      }
      // Rays in splendour: straight tapered rays alternating with wavy flames, grown out.
      if (s.rays > 0) {
        const grow = Math.max(0, s.rays);
        for (let k = 0; k < 24; k++) {
          const a = (k * TAU) / 24 - Math.PI / 2;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          const r0 = R + 2.5;
          if (k % 2 === 0) {
            const r1 = r0 + (R + 12.5 - r0) * grow;
            const half = 0.06;
            ctx.fillStyle = css(P.gilt, 0.8 * A * clamp(grow * 2));
            ctx.beginPath();
            ctx.moveTo(Math.cos(a - half) * r0, Math.sin(a - half) * r0);
            ctx.lineTo(ca * r1, sa * r1);
            ctx.lineTo(Math.cos(a + half) * r0, Math.sin(a + half) * r0);
            ctx.closePath();
            ctx.fill();
          } else {
            const r1 = r0 + (R + 9.5 - r0) * grow;
            ctx.strokeStyle = css(P.gilt, 0.6 * A * clamp(grow * 2));
            ctx.lineWidth = 0.7;
            ctx.beginPath();
            for (let st = 0; st <= 8; st++) {
              const f = st / 8;
              const rr = r0 + (r1 - r0) * f;
              const wob = Math.sin(f * Math.PI * 2) * 1.6 * (1 - f * 0.4) * Math.min(1, grow);
              const x = ca * rr - sa * wob;
              const y = sa * rr + ca * wob;
              if (st === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.stroke();
          }
        }
      }
      // The medallion: gilt wash, sheen from the upper left, engraved rings, burin hatching, a boss.
      ctx.fillStyle = css(P.ink0, A);
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, TAU);
      ctx.fill();
      ctx.fillStyle = css(P.gilt, (P.dark ? 0.26 : 0.34) * A);
      ctx.fill();
      const sheen = ctx.createRadialGradient(-R * 0.35, -R * 0.4, 0, -R * 0.35, -R * 0.4, R * 1.1);
      sheen.addColorStop(0, css(P.giltSoft, (P.dark ? 0.45 : 0.3) * A));
      sheen.addColorStop(1, css(P.giltSoft, 0));
      ctx.fillStyle = sheen;
      ctx.fill();
      const face = s.face;
      if (face > 0) {
        for (const [f, w, al] of [[0.34, 0.6, 0.55], [0.6, 0.6, 0.45], [0.82, 0.5, 0.4]] as const) {
          ctx.strokeStyle = css(P.gilt, al * A * face);
          ctx.lineWidth = w;
          ctx.beginPath();
          ctx.arc(0, 0, R * f, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(face * 1.4));
          ctx.stroke();
        }
        ctx.strokeStyle = css(P.gilt, 0.35 * A);
        ctx.lineWidth = 0.45;
        ctx.beginPath();
        const cut = Math.floor(24 * face);
        for (let k = 0; k < cut; k++) {
          const a = (k * TAU) / 24;
          ctx.moveTo(Math.cos(a) * R * 0.36, Math.sin(a) * R * 0.36);
          ctx.lineTo(Math.cos(a) * R * 0.58, Math.sin(a) * R * 0.58);
        }
        ctx.stroke();
        ctx.fillStyle = css(P.giltSoft, 0.95 * A * face);
        ctx.beginPath();
        ctx.moveTo(0, -3);
        ctx.lineTo(3, 0);
        ctx.lineTo(0, 3);
        ctx.lineTo(-3, 0);
        ctx.closePath();
        ctx.fill();
      }
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = css(P.gilt, 0.95 * A);
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, TAU);
      ctx.stroke();
      ctx.lineWidth = 0.5;
      ctx.strokeStyle = css(P.giltSoft, 0.6 * A);
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(0.1, R - 1.6), 0, TAU);
      ctx.stroke();
      // The ignition flash as the constellation arrives.
      if (s.flash > 0.01) {
        const fg = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 3.4);
        fg.addColorStop(0, `rgba(255, 246, 220, ${(0.9 * s.flash).toFixed(3)})`);
        fg.addColorStop(0.35, `rgba(255, 228, 160, ${(0.35 * s.flash).toFixed(3)})`);
        fg.addColorStop(1, "rgba(255, 230, 170, 0)");
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = fg;
        ctx.fillRect(-R * 3.4, -R * 3.4, R * 6.8, R * 6.8);
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.restore();
    }
  }

  private drawPlanets(planets: PlanetDraw[]): void {
    const ctx = this.ctx;
    const P = this.pal();
    for (const p of planets) {
      const r = p.r;
      const idle = p.state === "idle";
      const unknown = p.state === "unknown";
      const done = p.state === "done";
      ctx.save();
      ctx.translate(p.x, p.y);
      if (p.state === "waiting") {
        // The Orrery's steady needs-you halo: a vermilion wash and a sharp ring.
        const v = mixRGB(C.vermilion, hexRGB("#B83A24"), this.parchment);
        ctx.fillStyle = css(v, 0.16 * p.alpha);
        ctx.beginPath();
        ctx.arc(0, 0, r + 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = css(v, 0.95 * p.alpha);
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.arc(0, 0, r + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = p.alpha * (idle ? 0.5 : unknown ? 0.6 : 1);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      if (!done) {
        // The night side, away from the sun, in ink with fine hatching.
        let lx = p.sunX - p.x;
        let ly = p.sunY - p.y;
        const len = Math.hypot(lx, ly) || 1;
        lx /= len;
        ly /= len;
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.arc(lx * r * 0.62, ly * r * 0.62, r * 1.04, 0, Math.PI * 2);
        ctx.clip("evenodd");
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = css(P.dark ? P.ink0 : P.star, (P.dark ? 0.3 : 0.22) * p.alpha);
        ctx.fillRect(-r, -r, r * 2, r * 2);
        ctx.strokeStyle = css(P.dark ? P.ink0 : P.star, (P.dark ? 0.45 : 0.35) * p.alpha);
        ctx.lineWidth = 0.5;
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
      ctx.globalAlpha = 1;
      ctx.strokeStyle = css(P.star, (P.dark ? (idle ? 0.3 : 0.55) : idle ? 0.35 : 0.6) * p.alpha);
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
      if (r >= 5 && p.family) {
        const glyph = GLYPH_GEOMETRY[ORRERY_FAMILY_TO_GLYPH[p.family] ?? "other"];
        drawGlyph(ctx, glyph, 0, 0, r * 0.74 * 2, css(P.dark ? P.ink0 : P.star, (idle ? 0.55 : 0.9) * p.alpha));
      }
      ctx.restore();
    }
  }

  // ------------------------------------------------------------------------------------------

  private drawLeader(pts: Array<[number, number]>, progress: number, alpha: number): void {
    if (progress <= 0 || alpha <= 0.01 || pts.length < 2) return;
    const ctx = this.ctx;
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    let left = total * progress;
    ctx.save();
    ctx.strokeStyle = css(C.gilt, alpha);
    ctx.lineWidth = 0.7;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    let end: [number, number] = pts[0];
    for (let i = 1; i < pts.length && left > 0; i++) {
      const dx = pts[i][0] - pts[i - 1][0];
      const dy = pts[i][1] - pts[i - 1][1];
      const seg = Math.hypot(dx, dy);
      const k = seg > 0 ? Math.min(1, left / seg) : 1;
      end = [pts[i - 1][0] + dx * k, pts[i - 1][1] + dy * k];
      ctx.lineTo(end[0], end[1]);
      left -= seg;
    }
    ctx.stroke();
    ctx.restore();
    if (progress < 1) this.spark(end[0], end[1], 9);
  }

  private drawText(t: TextDraw): void {
    if (t.alpha <= 0.003) return;
    const ctx = this.ctx;
    if (t.leader) this.drawLeader(t.leader.pts, t.leader.progress, t.leader.alpha);
    if (t.reveal <= 0) return;
    ctx.save();
    ctx.font = t.font;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    if (t.transform && t.style === "numeral") {
      // Etched along a band: dark cut with a lit lip on the lower edge.
      const [a, b, c, d] = t.transform;
      ctx.setTransform(this.dpr * a, this.dpr * b, this.dpr * c, this.dpr * d, this.dpr * t.x, this.dpr * t.y);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = css(C.giltSoft, t.alpha * 0.45);
      ctx.fillText(t.text, 0, 0.7);
      ctx.fillStyle = css(t.color, t.alpha * 0.92);
      ctx.fillText(t.text, 0, 0);
      ctx.restore();
      return;
    }
    const width = this.measure(t.font, t.text, t.tracking);
    const sizeMatch = /([\d.]+)px/.exec(t.font);
    const size = sizeMatch ? parseFloat(sizeMatch[1]) : 14;
    // Local frame: either the screen, or a rotated frame centred on (x, y) for text along a line.
    let ox = t.x;
    let oy = t.y;
    if (t.transform) {
      const [a, b, c, d] = t.transform;
      ctx.setTransform(this.dpr * a, this.dpr * b, this.dpr * c, this.dpr * d, this.dpr * t.x, this.dpr * t.y);
      ox = 0;
      oy = size * 0.34;
    }
    const x0 = t.align === "center" ? ox - width / 2 : t.align === "right" ? ox - width : ox;
    if (t.glyph) {
      const gs = Math.round(size * 0.82);
      const gx = t.glyphSide === "right" ? x0 + width + size * 0.6 : x0 - size * 0.6;
      drawGlyph(ctx, GLYPH_GEOMETRY[t.glyph], gx, oy - size * 0.3, gs, css(FAMILY[t.glyph], t.alpha * clamp(t.reveal * 3)));
    }
    const fill = this.fillFor({ ...t, y: oy }, size);
    if (t.tracking > 0 || t.style === "title") {
      // Letter by letter (tracked capitals): each letter is cut in turn.
      let x = x0;
      const n = t.text.length;
      for (let i = 0; i < n; i++) {
        const ch = t.text[i];
        const cw = this.measure(t.font, ch, 0);
        const li = clamp(t.reveal * n - i);
        if (li > 0) {
          ctx.save();
          if (li < 1) {
            ctx.beginPath();
            ctx.rect(x - 2, oy - size * 1.2, (cw + 4) * li, size * 1.6);
            ctx.clip();
          }
          this.fillEngraved(t, ch, x, oy, size, fill, li);
          ctx.restore();
          if (li < 1) this.spark(x + cw * li, oy - size * 0.35, size);
        }
        x += cw + t.tracking;
      }
      if (t.style === "sun" && !t.transform) {
        // The Orrery's rule under the name: two hairlines meeting at a diamond.
        const P = this.pal();
        const len = t.text.length;
        const plateW = Math.max(90, Math.round(Math.max(68, Math.round(len * 8.2)) + 22));
        const rw = Math.min(plateW, width + 10) * clamp(t.reveal * 1.3);
        const ry = t.y - 4.5 + 9;
        ctx.strokeStyle = css(P.gilt, 0.55 * t.alpha);
        ctx.lineWidth = 0.75;
        ctx.beginPath();
        ctx.moveTo(t.x - rw / 2, ry);
        ctx.lineTo(t.x - 4, ry);
        ctx.moveTo(t.x + 4, ry);
        ctx.lineTo(t.x + rw / 2, ry);
        ctx.stroke();
        ctx.fillStyle = css(P.gilt, 0.85 * t.alpha * t.reveal);
        ctx.beginPath();
        ctx.moveTo(t.x, ry - 2.2);
        ctx.lineTo(t.x + 2.2, ry);
        ctx.lineTo(t.x, ry + 2.2);
        ctx.lineTo(t.x - 2.2, ry);
        ctx.closePath();
        ctx.fill();
      }
    } else {
      const r = t.reveal;
      if (r < 1) {
        ctx.beginPath();
        ctx.rect(x0 - 2, oy - size * 1.3, (width + 4) * r, size * 1.8);
        ctx.clip();
      }
      this.fillEngraved(t, t.text, x0, oy, size, fill, 1);
      if (r < 1) {
        ctx.restore();
        this.spark(x0 + width * r, oy - size * 0.35, size);
        return;
      }
    }
    ctx.restore();
  }

  private fillFor(t: TextDraw, size: number): string | CanvasGradient {
    if (t.style === "title" || t.style === "constellation" || t.style === "sun") {
      const g = this.ctx.createLinearGradient(0, t.y - size * 0.85, 0, t.y + size * 0.1);
      g.addColorStop(0, css(C.giltSoft, t.alpha));
      g.addColorStop(0.55, css(t.color, t.alpha));
      g.addColorStop(1, css(C.giltDeep, t.alpha));
      return g;
    }
    return css(t.color, t.alpha);
  }

  private fillEngraved(t: TextDraw, text: string, x: number, y: number, size: number, fill: string | CanvasGradient, li: number): void {
    const ctx = this.ctx;
    if (t.style === "sun") {
      // The Orrery's engraved name: an ink knockout under gilt, then a hairline rule with a diamond.
      const P = this.pal();
      ctx.save();
      ctx.strokeStyle = css(P.ink0, t.alpha);
      ctx.lineWidth = 5;
      ctx.lineJoin = "round";
      ctx.strokeText(text, x, y);
      ctx.restore();
      ctx.fillStyle = css(P.giltText, t.alpha);
      ctx.fillText(text, x, y);
      return;
    }
    if (t.style === "title" || t.style === "constellation") {
      if (t.style === "constellation") {
        // A soft ink halo so a line or a band passing under the name never hurts it.
        ctx.save();
        ctx.shadowColor = `rgba(6, 10, 20, ${(0.95 * t.alpha).toFixed(3)})`;
        ctx.shadowBlur = size * 0.7 * this.dpr;
        ctx.fillStyle = `rgba(6, 10, 20, ${(0.5 * t.alpha).toFixed(3)})`;
        ctx.fillText(text, x, y);
        ctx.restore();
      }
      // A fine shadow under the gilt and a light lip on top read as raised, engraved metal.
      ctx.fillStyle = `rgba(4, 7, 14, ${(0.85 * t.alpha).toFixed(3)})`;
      ctx.fillText(text, x, y + Math.max(1, size * 0.03));
      ctx.fillStyle = fill;
      ctx.fillText(text, x, y);
      if (t.style === "title") {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = css(C.giltSoft, 0.12 * t.alpha * li);
        ctx.fillText(text, x, y - 0.6);
        ctx.restore();
      }
      return;
    }
    if (t.style === "label" || t.style === "missing" || t.style === "sublabel" || t.style === "error") {
      // A soft ink halo keeps labels legible over the gilt rings and the beam.
      ctx.save();
      ctx.shadowColor = `rgba(6, 10, 20, ${(0.9 * t.alpha).toFixed(3)})`;
      ctx.shadowBlur = size * 0.45 * this.dpr;
      ctx.fillStyle = fill;
      ctx.fillText(text, x, y);
      ctx.restore();
      ctx.fillStyle = fill;
      ctx.fillText(text, x, y);
      return;
    }
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  private spark(x: number, y: number, size: number): void {
    const ctx = this.ctx;
    const r = Math.max(4, size * 0.45);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(255, 248, 226, 0.95)");
    g.addColorStop(0.3, "rgba(255, 228, 160, 0.45)");
    g.addColorStop(1, "rgba(255, 220, 150, 0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    ctx.restore();
  }

  private drawCartouche(c: CartoucheState): void {
    const ctx = this.ctx;
    const u = Math.min(this.w / 1440, this.h / 900);
    const W = 300 * u;
    const H = 92 * u;
    const x = c.x - W / 2;
    const y = c.y - H / 2;
    const notch = 10 * u;
    ctx.save();
    ctx.globalAlpha = c.alpha;
    // Cartouche plate: concave corners, ink backing, double gilt hairline.
    const plate = (inset: number) => {
      const X = x + inset;
      const Y = y + inset;
      const Wd = W - 2 * inset;
      const Hd = H - 2 * inset;
      const n = Math.max(2, notch - inset * 0.6);
      ctx.beginPath();
      ctx.moveTo(X + n, Y);
      ctx.lineTo(X + Wd - n, Y);
      ctx.arc(X + Wd, Y, n, Math.PI, Math.PI / 2, true);
      ctx.lineTo(X + Wd, Y + Hd - n);
      ctx.arc(X + Wd, Y + Hd, n, -Math.PI / 2, Math.PI, true);
      ctx.lineTo(X + n, Y + Hd);
      ctx.arc(X, Y + Hd, n, 0, -Math.PI / 2, true);
      ctx.lineTo(X, Y + n);
      ctx.arc(X, Y, n, Math.PI / 2, 0, true);
      ctx.closePath();
    };
    plate(0);
    ctx.fillStyle = css(C.ink0, 0.97);
    ctx.fill();
    ctx.strokeStyle = css(C.gilt, 0.85);
    ctx.lineWidth = 0.75;
    ctx.stroke();
    plate(4 * u);
    ctx.strokeStyle = css(C.gilt, 0.35);
    ctx.stroke();
    // Label
    const small = 9.5 * u;
    ctx.font = `600 ${small.toFixed(2)}px ${FONT.sans}`;
    ctx.fillStyle = css(C.dust, 1);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    const label = "AGENTS FOUND";
    const tr = 0.22 * small;
    const lw = this.measure(ctx.font, label, tr);
    let lx = c.x - lw / 2;
    for (const ch of label) {
      ctx.fillText(ch, lx, y + 20 * u);
      lx += this.measure(ctx.font, ch, 0) + tr;
    }
    // Count: "13 of 80" in Cormorant numerals.
    const big = 30 * u;
    const bigFont = `600 ${big.toFixed(2)}px ${FONT.display}`;
    const ofFont = `italic 500 ${(big * 0.6).toFixed(2)}px ${FONT.display}`;
    const n = String(c.found);
    const of = ` of ${c.catalogue}`;
    const nw = this.measure(bigFont, n, 0);
    const ow = this.measure(ofFont, of, 0);
    const bx = c.x - (nw + ow) / 2;
    const by = y + 20 * u + big * 0.95;
    const g = ctx.createLinearGradient(0, by - big * 0.8, 0, by);
    g.addColorStop(0, css(C.giltSoft));
    g.addColorStop(1, css(C.gilt));
    ctx.font = bigFont;
    ctx.fillStyle = g;
    ctx.fillText(n, bx, by);
    ctx.font = ofFont;
    ctx.fillStyle = css(C.dust, 1);
    ctx.fillText(of, bx + nw, by);
    if (c.sessionsAlpha > 0) {
      const s = 10.5 * u;
      ctx.font = `500 ${s.toFixed(2)}px ${FONT.sans}`;
      ctx.textAlign = "center";
      ctx.fillStyle = css(C.dust, c.sessionsAlpha * smoothstep(0, 1, c.alpha));
      const txt = c.sessions === 1 ? "1 session gathered" : `${c.sessions} sessions gathered`;
      ctx.fillText(txt, c.x, y + H - 14 * u);
    }
    ctx.restore();
  }
}

/** Point at arc length `a` along the rectangle perimeter, clockwise from the top centre, with inward normal. */
function perimeterPoint(x: number, y: number, w: number, h: number, a: number): [number, number, number, number] {
  const P = 2 * (w + h);
  let s = ((a % P) + P) % P;
  const top1 = w / 2;
  if (s < top1) return [x + w / 2 + s, y, 0, 1];
  s -= top1;
  if (s < h) return [x + w, y + s, -1, 0];
  s -= h;
  if (s < w) return [x + w - s, y + h, 0, -1];
  s -= w;
  if (s < h) return [x, y + h - s, 1, 0];
  s -= h;
  return [x + s, y, 0, 1];
}

function pointOnRect(x: number, y: number, w: number, h: number, dir: 1 | -1, len: number): [number, number] {
  if (dir === 1) {
    const p = perimeterPoint(x, y, w, h, len);
    return [p[0], p[1]];
  }
  const P = 2 * (w + h);
  const p = perimeterPoint(x, y, w, h, P - len);
  return [p[0], p[1]];
}

function fillBandCell(ctx: Ctx, x: number, y: number, w: number, h: number, b: number, a0: number, a1: number): void {
  const p0 = perimeterPoint(x, y, w, h, a0);
  const p1 = perimeterPoint(x, y, w, h, a1);
  // Cells that straddle a corner are skipped for clean corners.
  if (p0[2] !== p1[2] || p0[3] !== p1[3]) return;
  const nx = p0[2];
  const ny = p0[3];
  ctx.beginPath();
  ctx.moveTo(p0[0], p0[1]);
  ctx.lineTo(p1[0], p1[1]);
  ctx.lineTo(p1[0] + nx * b, p1[1] + ny * b);
  ctx.lineTo(p0[0] + nx * b, p0[1] + ny * b);
  ctx.closePath();
  ctx.fill();
}
