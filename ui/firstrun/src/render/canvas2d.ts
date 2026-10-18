/**
 * Canvas 2D fallback renderer (no WebGL2, or the context was lost). Draws the same Frame as the
 * WebGL2 renderer with cheaper effects, in the same layers: background, star field, the far half of
 * the instrument, the contents (links, beam, stars), the near half. Text and the window rule belong
 * to the overlay.
 *
 * Cost model: the heavy, static things (nebula band, two star layers, every sprite) are built once
 * per size in resize(). A frame then costs a few dozen quad fills (the ring faces batched by
 * quantised colour into one path each), a few strokes and one drawImage per soft effect.
 *
 * Determinism: no clocks and no Math.random. Everything time-dependent comes from the Frame.
 */
import { clamp, mix, smoothstep } from "../math/ease";
import { mulMV, project, toView, type Camera, type V3 } from "../math/vec";
import { AXIS_DIR, EQ_E1, EQ_E2, ringPoint, ringRadial, type RingState } from "../scene/instrument";
import { C, css, FAMILY } from "../scene/palette";
import type { FieldLayer } from "../scene/sky";
import type { Frame, RGB, StarDraw } from "../scene/types";
import type { SkyRenderer } from "./webgl";
import { ballSprite, beamSprite, coronaSprite, gaussianSprite, nebulaSprite, spikeSprite, type MakeCanvas, type Sprite } from "./sprites";

export interface Canvas2DOptions {
  /** Builds an offscreen canvas. Injected so tests can pass stub canvases. */
  createCanvas?: MakeCanvas;
  /** Called at the start of each layer ("background", "field", "back", "contents", "stars", "front"). */
  onPhase?: (label: string) => void;
}

const TAU = Math.PI * 2;
const SEGMENTS = 128;
/** Each quad overlaps its neighbours by this fraction of a segment, so antialiased seams do not show. */
const OVERLAP = 0.3;
const LEVELS = 23;
const BACK_INK: V3 = [0.045, 0.06, 0.1];
const GOLD: V3 = [0.93, 0.72, 0.33];
const L1: V3 = unit([-0.5, 0.72, 0.55]);
const L2: V3 = unit([0.75, -0.28, 0.45]);
const L3: V3 = unit([0.35, 0.5, -0.8]);
const FAMILY_KEYS = Object.keys(FAMILY) as Array<keyof typeof FAMILY>;
const PARCH: RGB = [0.953, 0.922, 0.855];
const WARM: RGB = [1, 0.92, 0.7];

function unit(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sat01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const saturate = (c: RGB, k: number): RGB => {
  const g = (c[0] + c[1] + c[2]) / 3;
  return [sat01(g + (c[0] - g) * k), sat01(g + (c[1] - g) * k), sat01(g + (c[2] - g) * k)];
};

/** A simplified giltShade: GILT in shaders.ts without the cavity or the hatching. N and vp are view space. */
function giltShade(N: V3, vp: V3, dist: number, glint: V3): V3 {
  const V = unit([-vp[0], -vp[1], dist - vp[2]]);
  const d1 = Math.max(dot3(N, L1), 0);
  const d2 = Math.max(dot3(N, L2), 0);
  const H1 = unit([L1[0] + V[0], L1[1] + V[1], L1[2] + V[2]]);
  const H2 = unit([L2[0] + V[0], L2[1] + V[1], L2[2] + V[2]]);
  const Hg = unit([glint[0] + V[0], glint[1] + V[1], glint[2] + V[2]]);
  const nh1 = Math.max(dot3(N, H1), 0);
  const s1 = Math.pow(nh1, 46);
  const s1b = Math.pow(nh1, 7);
  const s2 = Math.pow(Math.max(dot3(N, H2), 0), 16);
  const ng = Math.max(dot3(N, Hg), 0);
  const sg = Math.pow(ng, 220);
  const sgb = Math.pow(ng, 24);
  const nv = Math.max(dot3(N, V), 0);
  const rim = Math.pow(1 - nv, 3) * Math.max(dot3(N, L3) + 0.45, 0);
  const k = 2 * dot3(N, V);
  const R: V3 = [-V[0] + k * N[0], -V[1] + k * N[1], -V[2] + k * N[2]];
  const lamp = smoothstep(-0.2, 0.9, -R[0] * 0.7 + R[1] * 0.35 + 0.15);
  const sky = smoothstep(0.6, 1, R[1]);
  const env: V3 = [mix(0.035, 0.62, lamp) + 0.08 * sky, mix(0.04, 0.44, lamp) + 0.09 * sky, mix(0.07, 0.2, lamp) + 0.13 * sky];
  const out: V3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const g = GOLD[i];
    const spec1 = mix(g, [1, 0.94, 0.8][i], 0.45);
    out[i] =
      g * env[i] * 0.75 +
      g * d1 * 0.3 +
      g * s1b * 0.55 +
      spec1 * s1 * 1.1 +
      [0.3, 0.34, 0.45][i] * s2 * 0.35 +
      g * d2 * 0.05 +
      [1, 0.95, 0.82][i] * sg * 1.4 +
      g * sgb * 0.22 +
      g * rim * 0.4;
  }
  return out;
}

/** Colour batches for one ring in one pass: one path per quantised colour. */
interface Bucket {
  n: number;
  r: number;
  g: number;
  b: number;
  pts: number[];
}
interface RingPass {
  zSum: number;
  n: number;
  walls: Map<number, Bucket>;
  faces: Map<number, Bucket>;
  bevel: number[];
  grooveA: number[];
  grooveB: number[];
  tickMinor: number[];
  tickMajor: number[];
}
interface Item {
  z: number;
  draw: () => void;
}

const newPass = (): RingPass => ({ zSum: 0, n: 0, walls: new Map(), faces: new Map(), bevel: [], grooveA: [], grooveB: [], tickMinor: [], tickMajor: [] });

interface FamilySprites {
  bloom: Sprite;
  corona: Sprite;
  spike: Sprite;
}

export class Canvas2DSkyRenderer implements SkyRenderer {
  readonly kind = "canvas2d" as const;
  private ctx: CanvasRenderingContext2D;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private make: MakeCanvas;
  private phase: (label: string) => void;

  private nebula: Sprite = null;
  private layers: Sprite[] = [];
  private family = new Map<string, FamilySprites>();
  private dots: Sprite[] = [];
  private whiteSpike: Sprite = null;
  private ball: Sprite = null;
  private beam: Sprite = null;
  private glow: Sprite = null;
  private tipWarm: Sprite = null;
  private tipWhite: Sprite = null;

  constructor(private canvas: HTMLCanvasElement, private field: FieldLayer[], opts: Canvas2DOptions = {}) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.make =
      opts.createCanvas ??
      ((w, h) => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        return c;
      });
    this.phase = opts.onPhase ?? (() => {});
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.w = cssW;
    this.h = cssH;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssW * dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * dpr));
    this.build();
  }

  dispose(): void {
    this.nebula = null;
    this.layers = [];
    this.family.clear();
  }

  // ---------------------------------------------------------------- caches (once per size)

  private build(): void {
    const make = this.make;
    this.nebula = nebulaSprite(make, this.w, this.h);
    this.whiteSpike = spikeSprite(make, [1, 1, 1]);
    this.ball = ballSprite(make, 64);
    this.beam = beamSprite(make);
    this.glow = gaussianSprite(make, 64, [0.93, 0.84, 0.62], 5.6);
    this.tipWarm = gaussianSprite(make, 64, WARM, 3.5);
    this.tipWhite = gaussianSprite(make, 48, [1, 1, 1], 5.2);
    this.dots = [];
    for (let b = 0; b < 7; b++) this.dots.push(gaussianSprite(make, 24, tempColor(b / 3 - 1), 8));
    this.family.clear();
    for (const key of FAMILY_KEYS) {
      const sat = saturate(FAMILY[key], 1.35);
      this.family.set(key, {
        bloom: gaussianSprite(make, 64, sat, 10.1),
        corona: coronaSprite(make, 96, sat),
        spike: spikeSprite(make, mix3(sat, [1, 1, 1], 0.35)),
      });
    }
    // The far and middle star layers never change between frames: paint them once at device resolution.
    this.layers = [];
    for (let i = 0; i < Math.min(2, this.field.length); i++) this.layers.push(this.buildLayer(this.field[i]));
  }

  private buildLayer(layer: FieldLayer): Sprite {
    const bw = Math.max(1, Math.round(this.w * this.dpr));
    const bh = Math.max(1, Math.round(this.h * this.dpr));
    const c = this.make(bw, bh);
    const g = c.getContext("2d");
    if (!g) return null;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // Faint stars fall inside the soft dot: size and brightness as FIELD_FS.
    for (const s of layer.stars) {
      const dot = this.dots[tempBucket(s.temp)];
      if (!dot) continue;
      const sigma = Math.sqrt(Math.max(0.9 * s.size * s.size, 0.35) / 2);
      const H = 4 * sigma;
      g.globalAlpha = clamp(s.mag * 0.72);
      g.drawImage(dot, s.x * this.w - H, s.y * this.h - H, 2 * H, 2 * H);
    }
    g.globalAlpha = 1;
    return c;
  }

  // ---------------------------------------------------------------- frame

  render(f: Frame): void {
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    this.phase("background");
    this.drawBackground(f);
    this.phase("field");
    this.drawField(f);

    // The instrument, split into halves by view-space depth.
    const back: Item[] = [];
    const front: Item[] = [];
    const tipsBack: Array<() => void> = [];
    const tipsFront: Array<() => void> = [];
    this.collectRings(f, back, front, tipsBack, tipsFront);
    this.collectAxis(f, back, front);
    this.collectGlobe(f, front);
    back.sort((a, b) => a.z - b.z);
    front.sort((a, b) => a.z - b.z);

    this.phase("back");
    this.run(back, tipsBack);
    this.phase("contents");
    this.drawLinks(f);
    this.drawBeam(f);
    this.phase("stars");
    this.drawStars(f);
    this.phase("front");
    this.run(front, tipsFront);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  private run(items: Item[], tips: Array<() => void>): void {
    for (const it of items) it.draw();
    for (const t of tips) t();
  }

  // ---------------------------------------------------------------- background and field

  private drawBackground(f: Frame): void {
    const ctx = this.ctx;
    const { w, h } = this;
    const z = f.sky.zoom;
    ctx.fillStyle = css(C.ink0);
    ctx.fillRect(0, 0, w, h);
    // The soft lift behind the instrument: BG_FS radial terms, circular in px (r is in heights).
    const cy = h * ((0.44 - 0.5) * z + 0.5);
    const R = Math.max(1, 1.1 * h * z);
    const g = ctx.createRadialGradient(w / 2, cy, 0, w / 2, cy, R);
    const lift: V3 = [0.075, 0.098, 0.165];
    const ink: V3 = [0.043, 0.071, 0.125];
    const deep: V3 = [0.022, 0.035, 0.068];
    for (let i = 0; i <= 12; i++) {
      const r = (i / 12) * 1.1;
      const a = smoothstep(0, 0.55, r);
      const b = smoothstep(0.45, 1.1, r);
      const col: RGB = [0, 0, 0];
      for (let k = 0; k < 3; k++) col[k] = mix(mix(lift[k], ink[k], a), deep[k], b);
      g.addColorStop(i / 12, css(col));
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const nb = clamp(f.sky.nebula);
    if (this.nebula && nb > 0.002) {
      ctx.setTransform(this.dpr * z, 0, 0, this.dpr * z, this.dpr * (w / 2) * (1 - z), this.dpr * (h / 2) * (1 - z));
      ctx.globalAlpha = nb;
      ctx.drawImage(this.nebula, 0, 0, w, h);
      ctx.globalAlpha = 1;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    if (f.sky.parchment > 0.002) {
      // Through warm sepia first, as the shader does (navy straight to parchment reads grey).
      const p = f.sky.parchment;
      const sepiaA = smoothstep(0, 0.45, p) * (1 - smoothstep(0.45, 1, p));
      if (sepiaA > 0.002) {
        ctx.fillStyle = css([0.36, 0.27, 0.16], sepiaA);
        ctx.fillRect(0, 0, this.w, this.h);
      }
      ctx.fillStyle = css(PARCH, smoothstep(0.3, 1, p));
      ctx.fillRect(0, 0, w, h);
    }
  }

  private drawField(f: Frame): void {
    const ctx = this.ctx;
    const { w, h, dpr } = this;
    const fade = 1 - clamp(f.sky.parchment);
    for (let i = 0; i < this.field.length; i++) {
      const a = clamp(f.sky.layers[i] * fade);
      if (a <= 0.002) continue;
      const layer = this.field[i];
      const z = Math.pow(f.sky.zoom, 1 + layer.depth * 1.6);
      if (i < 2) {
        const off = this.layers[i];
        if (!off) continue;
        ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (w / 2) * (1 - z), dpr * (h / 2) * (1 - z));
        ctx.globalAlpha = a;
        ctx.drawImage(off, 0, 0, w, h);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        continue;
      }
      // The near layer twinkles, so it is drawn per star (FIELD_VS / FIELD_FS).
      const t = f.sky.time;
      for (const s of layer.stars) {
        const tw = 0.72 + 0.28 * Math.sin(TAU * (s.phase + t * s.speed)) * Math.sin(TAU * (s.phase * 1.7 + t * s.speed * 0.53));
        const mag = s.mag * tw * a;
        if (mag <= 0.003) continue;
        const x = ((s.x - 0.5) * z + 0.5) * w;
        const y = ((s.y - 0.5) * z + 0.5) * h;
        const size = s.size * mix(1, z, 0.35);
        const dot = this.dots[tempBucket(s.temp)];
        if (dot) {
          const H = 4 * Math.sqrt(Math.max(0.9 * size * size, 0.35) / 2);
          ctx.globalAlpha = clamp(mag);
          ctx.drawImage(dot, x - H, y - H, 2 * H, 2 * H);
        }
        if (this.whiteSpike && mag > 0.08) {
          ctx.globalAlpha = clamp(0.35 * mag);
          this.spike(this.whiteSpike, x, y, 0, 3.4 * size + 1.5, 2.4);
          this.spike(this.whiteSpike, x, y, Math.PI / 2, 3.4 * size + 1.5, 2.4);
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  /** One diffraction spike: a horizontal sprite of half-length `len` rotated to `ang`. */
  private spike(spr: Sprite, x: number, y: number, ang: number, len: number, thick: number): void {
    if (!spr || len <= 0.01) return;
    const ctx = this.ctx;
    const d = this.dpr;
    const c = Math.cos(ang) * d;
    const s = Math.sin(ang) * d;
    ctx.setTransform(c, s, -s, c, x * d, y * d);
    ctx.drawImage(spr, -len, -thick / 2, 2 * len, thick);
    ctx.setTransform(d, 0, 0, d, 0, 0);
  }

  // ---------------------------------------------------------------- the instrument

  private collectRings(f: Frame, back: Item[], front: Item[], tipsBack: Array<() => void>, tipsFront: Array<() => void>): void {
    const cam = f.cam;
    const view = cam.view;
    const camV: V3 = [0, 0, cam.dist];
    const glint = mulMV(view, f.glint);
    for (const r of f.rings) {
      const alpha = clamp(r.alpha * f.instrumentAlpha);
      if (alpha <= 0.002 || r.draw <= 0) continue;
      const spec = r.spec;
      const hw = spec.width / 2;
      const ht = spec.thickness / 2;
      const washer = spec.profile === "washer";
      const full = r.draw >= 0.9999;
      const drawn = Math.min(1, r.draw);
      const arc = TAU * drawn;
      const nseg = Math.max(3, Math.ceil(SEGMENTS * drawn));
      const dth = arc / nseg;
      const Nv = mulMV(view, r.N);
      const offV = mulMV(view, r.offset);
      const side = dot3(Nv, [camV[0] - offV[0], camV[1] - offV[1], camV[2] - offV[2]]) >= 0 ? 1 : -1;
      const passes: [RingPass, RingPass] = [newPass(), newPass()];
      const etchRel = Math.min(arc, r.etch * TAU);

      for (let i = 0; i < nseg; i++) {
        const a0 = r.drawFrom + i * dth;
        const a1 = a0 + dth;
        const am = (a0 + a1) / 2;
        const ta = a0 - (i === 0 && !full ? 0 : OVERLAP * dth);
        const tb = a1 + (i === nseg - 1 && !full ? 0 : OVERLAP * dth);
        const Rv = mulMV(view, ringRadial(r, am));
        const etched = i * dth + dth / 2 <= etchRel;

        // The visible broad face.
        let face: { ca: V3; cb: V3; cc: V3; cd: V3; N: V3; mid: V3 };
        if (washer) {
          const e = side * ht;
          face = {
            ca: ringPoint(r, ta, -hw, e),
            cb: ringPoint(r, ta, hw, e),
            cc: ringPoint(r, tb, hw, e),
            cd: ringPoint(r, tb, -hw, e),
            N: [side * Nv[0], side * Nv[1], side * Nv[2]],
            mid: toView(cam, ringPoint(r, am, 0, e)),
          };
        } else {
          const pOut = toView(cam, ringPoint(r, am, ht, 0));
          const outer = dot3(Rv, [camV[0] - pOut[0], camV[1] - pOut[1], camV[2] - pOut[2]]) >= 0;
          const rho = outer ? ht : -ht;
          const sg = outer ? 1 : -1;
          face = {
            ca: ringPoint(r, ta, rho, -hw),
            cb: ringPoint(r, ta, rho, hw),
            cc: ringPoint(r, tb, rho, hw),
            cd: ringPoint(r, tb, rho, -hw),
            N: [sg * Rv[0], sg * Rv[1], sg * Rv[2]],
            mid: toView(cam, ringPoint(r, am, rho, 0)),
          };
        }
        const isFront = face.mid[2] > 0;
        const pass = passes[isFront ? 1 : 0];
        pass.zSum += face.mid[2];
        pass.n++;
        this.pushQuad(pass.faces, cam, face, glint, !isFront);
        if (isFront) {
          const pa = project(cam, face.cb);
          const pb = project(cam, face.cc);
          pass.bevel.push(pa.x, pa.y, pb.x, pb.y);
          if (etched) {
            // Two grooves a little inside each edge of the graduated face.
            const k = 0.7;
            for (const [sgn, arr] of [[1, pass.grooveA], [-1, pass.grooveB]] as const) {
              const u0 = washer ? ringPoint(r, a0, sgn * k * hw, side * ht) : this.stripPoint(r, a0, face.N, Rv, sgn * k * hw, ht);
              const u1 = washer ? ringPoint(r, a1, sgn * k * hw, side * ht) : this.stripPoint(r, a1, face.N, Rv, sgn * k * hw, ht);
              const q0 = project(cam, u0);
              const q1 = project(cam, u1);
              arr.push(q0.x, q0.y, q1.x, q1.y);
            }
          }
        }

        // The thickness wall of a washer: the outer wall from outside, the inner wall from the far side.
        if (washer) {
          const pw = toView(cam, ringPoint(r, am, hw, 0));
          const outer = dot3(Rv, [camV[0] - pw[0], camV[1] - pw[1], camV[2] - pw[2]]) >= 0;
          const rho = outer ? hw : -hw;
          const sg = outer ? 1 : -1;
          const wall = {
            ca: ringPoint(r, ta, rho, -ht),
            cb: ringPoint(r, ta, rho, ht),
            cc: ringPoint(r, tb, rho, ht),
            cd: ringPoint(r, tb, rho, -ht),
            N: [sg * Rv[0], sg * Rv[1], sg * Rv[2]] as V3,
            mid: toView(cam, ringPoint(r, am, rho, 0)),
          };
          const wf = wall.mid[2] > 0;
          this.pushQuad(passes[wf ? 1 : 0].walls, cam, wall, glint, !wf);
        }
      }

      // The degree scale: ticks across the face, only where the etch has reached and only on the near half.
      this.collectTicks(r, f, passes[1], side, etchRel, hw, ht, washer);

      const drawPass = (p: RingPass, isFront: boolean): Item | null => {
        if (p.n === 0 && p.walls.size === 0) return null;
        return {
          z: p.n ? p.zSum / p.n : 0,
          draw: () => this.drawRingPass(p, alpha, isFront),
        };
      };
      const ib = drawPass(passes[0], false);
      const ifr = drawPass(passes[1], true);
      if (ib) back.push(ib);
      if (ifr) front.push(ifr);

      // The burin's bright tip at the end of the arc being cut.
      if (r.tip > 0 && !full) {
        const p = project(cam, ringPoint(r, r.drawFrom + arc));
        const tip = clamp(r.tip) * alpha;
        const draw = () => {
          const ctx = this.ctx;
          ctx.globalCompositeOperation = "lighter";
          if (this.tipWarm) {
            ctx.globalAlpha = tip;
            ctx.drawImage(this.tipWarm, p.x - 22, p.y - 22, 44, 44);
          }
          if (this.tipWhite) {
            ctx.globalAlpha = tip;
            ctx.drawImage(this.tipWhite, p.x - 11, p.y - 11, 22, 22);
          }
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = "source-over";
        };
        (p.z > 0 ? tipsFront : tipsBack).push(draw);
      }
    }
  }

  /** A point on the visible cylindrical face of a strip at axial offset `ax`. */
  private stripPoint(r: RingState, theta: number, N: V3, Rv: V3, ax: number, ht: number): V3 {
    // N is the face normal in view space; the face is outer when it points the same way as the radial.
    const outer = dot3(N, Rv) >= 0;
    return ringPoint(r, theta, outer ? ht : -ht, ax);
  }

  private pushQuad(
    buckets: Map<number, Bucket>,
    cam: Camera,
    q: { ca: V3; cb: V3; cc: V3; cd: V3; N: V3; mid: V3 },
    glint: V3,
    isBack: boolean,
  ): void {
    const c = giltShade(q.N, q.mid, cam.dist, glint);
    let r = c[0];
    let g = c[1];
    let b = c[2];
    if (isBack) {
      r = mix(BACK_INK[0], r * 0.62, 0.62);
      g = mix(BACK_INK[1], g * 0.62, 0.62);
      b = mix(BACK_INK[2], b * 0.62, 0.62);
    }
    r = sat01(r);
    g = sat01(g);
    b = sat01(b);
    const key = Math.round(Math.max(r, g, b) * LEVELS);
    let bk = buckets.get(key);
    if (!bk) {
      bk = { n: 0, r: 0, g: 0, b: 0, pts: [] };
      buckets.set(key, bk);
    }
    bk.n++;
    bk.r += r;
    bk.g += g;
    bk.b += b;
    const a = project(cam, q.ca);
    const bb = project(cam, q.cb);
    const cc = project(cam, q.cc);
    const d = project(cam, q.cd);
    // Keep one winding so overlapping quads merge under the non-zero rule instead of cancelling.
    const area = (a.x * bb.y - bb.x * a.y + bb.x * cc.y - cc.x * bb.y + cc.x * d.y - d.x * cc.y + d.x * a.y - a.x * d.y) / 2;
    if (area >= 0) bk.pts.push(a.x, a.y, bb.x, bb.y, cc.x, cc.y, d.x, d.y);
    else bk.pts.push(d.x, d.y, cc.x, cc.y, bb.x, bb.y, a.x, a.y);
  }

  private collectTicks(r: RingState, f: Frame, pass: RingPass, side: number, etchRel: number, hw: number, ht: number, washer: boolean): void {
    const spec = r.spec;
    const cam = f.cam;
    const step = (spec.minorDeg * Math.PI) / 180;
    const n = Math.round(TAU / step);
    const camV: V3 = [0, 0, cam.dist];
    const drawnArc = Math.min(1, r.draw) * TAU;
    interface Tick {
      theta: number;
      sx: number;
      sy: number;
      ok: boolean;
      major: boolean;
      outer: boolean;
    }
    const ticks: Tick[] = [];
    for (let k = 0; k < n; k++) {
      const theta = k * step;
      let rel = (theta - r.drawFrom) % TAU;
      if (rel < 0) rel += TAU;
      const major = k % spec.majorEvery === 0;
      const inside = rel <= Math.min(drawnArc, etchRel);
      let ok = inside;
      let outer = true;
      let sx = 0;
      let sy = 0;
      if (ok) {
        const Rv = mulMV(cam.view, ringRadial(r, theta));
        if (washer) {
          const p = project(cam, ringPoint(r, theta, 0, side * ht));
          ok = p.z > 0;
          sx = p.x;
          sy = p.y;
        } else {
          const pv = toView(cam, ringPoint(r, theta, ht, 0));
          outer = dot3(Rv, [camV[0] - pv[0], camV[1] - pv[1], camV[2] - pv[2]]) >= 0;
          const p = project(cam, ringPoint(r, theta, outer ? ht : -ht, 0));
          ok = p.z > 0;
          sx = p.x;
          sy = p.y;
        }
      }
      ticks.push({ theta, sx, sy, ok, major, outer });
    }
    for (let k = 0; k < n; k++) {
      const t = ticks[k];
      if (!t.ok) continue;
      if (!t.major) {
        const nx = ticks[(k + 1) % n];
        const pv = ticks[(k + n - 1) % n];
        // Too dense on screen: drop the minors, keep the majors.
        const gap = Math.min(nx.ok ? Math.hypot(nx.sx - t.sx, nx.sy - t.sy) : 99, pv.ok ? Math.hypot(pv.sx - t.sx, pv.sy - t.sy) : 99);
        if (gap < 5) continue;
      }
      const len = t.major ? 0.95 : 0.55;
      const from = 0.7 * hw;
      const to = Math.max(-hw, (0.7 - len * 1.4) * hw);
      let p0: V3;
      let p1: V3;
      if (washer) {
        p0 = ringPoint(r, t.theta, from, side * ht);
        p1 = ringPoint(r, t.theta, to, side * ht);
      } else {
        const rho = t.outer ? ht : -ht;
        p0 = ringPoint(r, t.theta, rho, from);
        p1 = ringPoint(r, t.theta, rho, to);
      }
      const q0 = project(cam, p0);
      const q1 = project(cam, p1);
      (t.major ? pass.tickMajor : pass.tickMinor).push(q0.x, q0.y, q1.x, q1.y);
    }
  }

  private drawRingPass(p: RingPass, alpha: number, isFront: boolean): void {
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    for (const map of [p.walls, p.faces]) {
      for (const b of map.values()) {
        if (!b.n) continue;
        ctx.fillStyle = css([b.r / b.n, b.g / b.n, b.b / b.n]);
        ctx.beginPath();
        const q = b.pts;
        for (let i = 0; i < q.length; i += 8) {
          ctx.moveTo(q[i], q[i + 1]);
          ctx.lineTo(q[i + 2], q[i + 3]);
          ctx.lineTo(q[i + 4], q[i + 5]);
          ctx.lineTo(q[i + 6], q[i + 7]);
          ctx.closePath();
        }
        ctx.fill();
      }
    }
    if (!isFront) {
      ctx.globalAlpha = 1;
      return;
    }
    ctx.lineCap = "butt";
    // Engraved grooves and degree ticks, dark in the cut.
    this.segments(p.grooveA, "rgba(40, 28, 6, 0.55)", 0.8, alpha);
    this.segments(p.grooveB, "rgba(40, 28, 6, 0.55)", 0.8, alpha);
    this.segments(p.tickMinor, "rgba(40, 28, 6, 0.55)", 0.8, alpha);
    this.segments(p.tickMajor, "rgba(40, 28, 6, 0.75)", 1.2, alpha);
    // The lit bevel along the outer edge.
    this.segments(p.bevel, "rgba(255, 232, 170, 0.5)", 0.9, alpha);
    ctx.globalAlpha = 1;
  }

  private segments(pts: number[], style: string, width: number, alpha: number): void {
    if (!pts.length) return;
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 4) {
      ctx.moveTo(pts[i], pts[i + 1]);
      ctx.lineTo(pts[i + 2], pts[i + 3]);
    }
    ctx.stroke();
  }

  // ---------------------------------------------------------------- axis and globe

  private collectAxis(f: Frame, back: Item[], front: Item[]): void {
    const ax = f.axis;
    const alpha = clamp(ax.alpha * f.instrumentAlpha);
    if (alpha <= 0.002 || ax.extent <= 0) return;
    const cam = f.cam;
    const Av = mulMV(cam.view, AXIS_DIR);
    const glint = mulMV(cam.view, f.glint);
    const len = ax.length * ax.extent;
    const fin = Math.max(0, ax.finials);
    const rodW = Math.max(1, 2 * 0.0105 * cam.scale);
    const origin = project(cam, [0, 0, 0]);
    for (const sg of [1, -1]) {
      const zEnd = sg * Av[2];
      const isFront = zEnd > 0;
      const endW: V3 = [sg * AXIS_DIR[0] * len, sg * AXIS_DIR[1] * len, sg * AXIS_DIR[2] * len];
      const end = project(cam, endW);
      const mid = toView(cam, [endW[0] / 2, endW[1] / 2, endW[2] / 2]);
      // Normals across the rod: one facing the viewer, one toward the key light, for body and highlight.
      const Vhat: V3 = [0, 0, 1];
      const nb = unit(sub3(Vhat, scale3(Av, dot3(Vhat, Av))));
      const lp = unit(sub3(L1, scale3(Av, dot3(L1, Av))));
      const body = giltShade(nb, mid, cam.dist, glint);
      const hi = giltShade(unit([lp[0] + nb[0] * 0.4, lp[1] + nb[1] * 0.4, lp[2] + nb[2] * 0.4]), mid, cam.dist, glint);
      const drawBall = fin > 0.01;
      const ballOff = 0.056 * fin;
      const tipOff = 0.162 * fin;
      const endUnit = (d: number): V3 => [sg * AXIS_DIR[0] * (len + d), sg * AXIS_DIR[1] * (len + d), sg * AXIS_DIR[2] * (len + d)];
      const ballP = project(cam, endUnit(ballOff));
      const ballS = project(cam, endUnit(ballOff + 0.032 * fin));
      const tipP = project(cam, endUnit(tipOff));
      const draw = () => {
        const ctx = this.ctx;
        let bodyC = body;
        let hiC = hi;
        if (!isFront) {
          bodyC = [mix(BACK_INK[0], bodyC[0] * 0.62, 0.62), mix(BACK_INK[1], bodyC[1] * 0.62, 0.62), mix(BACK_INK[2], bodyC[2] * 0.62, 0.62)];
          hiC = [mix(BACK_INK[0], hiC[0] * 0.62, 0.62), mix(BACK_INK[1], hiC[1] * 0.62, 0.62), mix(BACK_INK[2], hiC[2] * 0.62, 0.62)];
        }
        ctx.globalAlpha = alpha;
        ctx.lineCap = "round";
        ctx.strokeStyle = css(bodyC as RGB);
        ctx.lineWidth = rodW;
        ctx.beginPath();
        ctx.moveTo(origin.x, origin.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        // A lengthwise highlight on the lit side of the rod.
        const dx = end.x - origin.x;
        const dy = end.y - origin.y;
        const dl = Math.hypot(dx, dy) || 1;
        let px = -dy / dl;
        let py = dx / dl;
        if (px * -0.5 + py * -0.72 < 0) {
          px = -px;
          py = -py;
        }
        const off = rodW * 0.22;
        ctx.strokeStyle = css(mix3(hiC as RGB, [1, 0.95, 0.8], 0.25));
        ctx.lineWidth = Math.max(0.7, rodW * 0.3);
        ctx.beginPath();
        ctx.moveTo(origin.x + px * off, origin.y + py * off);
        ctx.lineTo(end.x + px * off, end.y + py * off);
        ctx.stroke();
        if (drawBall) {
          // A short taper from the ball to a fine spike, then the ball itself.
          const sx = tipP.x - ballP.x;
          const sy = tipP.y - ballP.y;
          const sl = Math.hypot(sx, sy) || 1;
          const bw = Math.max(0.6, 0.009 * cam.scale * fin);
          ctx.fillStyle = css(bodyC as RGB);
          ctx.beginPath();
          ctx.moveTo(ballP.x - (sy / sl) * bw, ballP.y + (sx / sl) * bw);
          ctx.lineTo(tipP.x, tipP.y);
          ctx.lineTo(ballP.x + (sy / sl) * bw, ballP.y - (sx / sl) * bw);
          ctx.closePath();
          ctx.fill();
          if (this.ball) {
            const rad = Math.max(1, Math.hypot(ballS.x - ballP.x, ballS.y - ballP.y));
            ctx.globalAlpha = alpha * (isFront ? 1 : 0.7);
            ctx.drawImage(this.ball, ballP.x - rad, ballP.y - rad, 2 * rad, 2 * rad);
          }
        }
        ctx.globalAlpha = 1;
        ctx.lineCap = "butt";
      };
      (isFront ? front : back).push({ z: zEnd / 2, draw });
    }
  }

  private collectGlobe(f: Frame, front: Item[]): void {
    if (f.globe <= 0.001 || f.instrumentAlpha <= 0.002) return;
    const cam = f.cam;
    const c = project(cam, [0, 0, 0]);
    const r = 0.085 * cam.scale * Math.max(0.001, f.globe) * c.p;
    const alpha = clamp(Math.min(1, f.globe) * f.instrumentAlpha);
    front.push({
      z: 0,
      draw: () => {
        const ctx = this.ctx;
        ctx.globalAlpha = alpha;
        const g = ctx.createRadialGradient(c.x - r * 0.34, c.y - r * 0.4, r * 0.04, c.x, c.y, r);
        g.addColorStop(0, css([1, 0.92, 0.7]));
        g.addColorStop(0.3, css([0.95, 0.74, 0.34]));
        g.addColorStop(0.72, css([0.5, 0.34, 0.12]));
        g.addColorStop(1, css([0.13, 0.09, 0.04]));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, TAU);
        ctx.fill();
        // Engraved meridians (three great circles through the poles) and the equator, near side only.
        ctx.strokeStyle = "rgba(43, 31, 8, 0.5)";
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        const pt = (lat: number, lon: number): { x: number; y: number; z: number } => {
          const cl = Math.cos(lat);
          const w: V3 = [
            AXIS_DIR[0] * Math.sin(lat) + cl * (Math.cos(lon) * EQ_E1[0] + Math.sin(lon) * EQ_E2[0]),
            AXIS_DIR[1] * Math.sin(lat) + cl * (Math.cos(lon) * EQ_E1[1] + Math.sin(lon) * EQ_E2[1]),
            AXIS_DIR[2] * Math.sin(lat) + cl * (Math.cos(lon) * EQ_E1[2] + Math.sin(lon) * EQ_E2[2]),
          ];
          const v = mulMV(cam.view, w);
          return { x: c.x + v[0] * r, y: c.y - v[1] * r, z: v[2] };
        };
        const N = 28;
        for (const lon0 of [0, Math.PI / 3, (2 * Math.PI) / 3]) {
          let pen = false;
          for (let i = 0; i <= N; i++) {
            // A full great circle: latitude sweeps -90..90 on lon0, then 90..-90 on lon0 + pi.
            const u = (i / N) * TAU;
            const lat = Math.asin(Math.sin(u));
            const lon = Math.cos(u) >= 0 ? lon0 : lon0 + Math.PI;
            const p = pt(lat, lon);
            if (p.z > 0) {
              if (pen) ctx.lineTo(p.x, p.y);
              else ctx.moveTo(p.x, p.y);
              pen = true;
            } else pen = false;
          }
        }
        let pen = false;
        for (let i = 0; i <= N; i++) {
          const p = pt(0, (i / N) * TAU);
          if (p.z > 0) {
            if (pen) ctx.lineTo(p.x, p.y);
            else ctx.moveTo(p.x, p.y);
            pen = true;
          } else pen = false;
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      },
    });
  }

  // ---------------------------------------------------------------- contents

  private drawLinks(f: Frame): void {
    if (!f.links.length) return;
    const ctx = this.ctx;
    ctx.lineWidth = 1.7;
    ctx.lineCap = "round";
    ctx.strokeStyle = css([(C.gilt[0] + C.giltSoft[0]) / 2, (C.gilt[1] + C.giltSoft[1]) / 2, (C.gilt[2] + C.giltSoft[2]) / 2]);
    for (const l of f.links) {
      const a = clamp(l.alpha);
      const p = clamp(l.progress);
      if (a <= 0.003 || p <= 0) continue;
      const x = l.x1 + (l.x2 - l.x1) * p;
      const y = l.y1 + (l.y2 - l.y1) * p;
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1);
      ctx.lineTo(x, y);
      ctx.stroke();
      if (l.tip > 0 && this.tipWarm) {
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = clamp(l.tip * l.alpha);
        ctx.drawImage(this.tipWarm, x - 10, y - 10, 20, 20);
        ctx.globalCompositeOperation = "source-over";
      }
    }
    ctx.globalAlpha = 1;
    ctx.lineCap = "butt";
  }

  private drawBeam(f: Frame): void {
    const b = f.beam;
    if (!b || b.alpha <= 0.002) return;
    const ctx = this.ctx;
    const d = this.dpr;
    ctx.globalCompositeOperation = "lighter";
    if (this.beam && b.length > 1 && b.spread > 0.001) {
      const sx = b.length * Math.tan(Math.min(1.8 * b.spread, 1.4));
      const ca = Math.cos(b.angle);
      const sa = Math.sin(b.angle);
      // Local +x is across the beam, local +y runs along it, from the pivot.
      ctx.setTransform(ca * sx * d, sa * sx * d, sa * b.length * d, -ca * b.length * d, b.x * d, b.y * d);
      ctx.globalAlpha = clamp(0.13 * b.alpha);
      ctx.drawImage(this.beam, -1, 0, 2, 1);
      ctx.setTransform(d, 0, 0, d, 0, 0);
    }
    const s = b.spot;
    if (s && s.alpha > 0.002 && this.glow && s.r > 0.5) {
      const R = 1.5 * s.r;
      ctx.globalAlpha = clamp(0.28 * s.alpha);
      ctx.drawImage(this.glow, s.x - R, s.y - R, 2 * R, 2 * R);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  private drawStars(f: Frame): void {
    const ctx = this.ctx;
    for (const s of f.stars) {
      if (s.alpha <= 0.003) continue;
      this.drawStar(ctx, s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  private drawStar(ctx: CanvasRenderingContext2D, s: StarDraw): void {
    const a = clamp(s.alpha);
    const spr = this.family.get(s.family) ?? this.family.get("other");
    const core = Math.max(s.core, 0.5);
    const flare = clamp(s.flare);
    // Bloom, tinted by the family, additive.
    ctx.globalCompositeOperation = "lighter";
    if (spr?.bloom && s.bloom > 0.5 && s.bloomAlpha > 0.003) {
      const R = 1.8 * s.bloom;
      ctx.globalAlpha = clamp(s.bloomAlpha * a * 0.9);
      ctx.drawImage(spr.bloom, s.x - R, s.y - R, 2 * R, 2 * R);
    }
    ctx.globalCompositeOperation = "source-over";
    // The saturated corona.
    if (spr?.corona) {
      const R = 3 * core;
      ctx.globalAlpha = clamp(0.85 * a);
      ctx.drawImage(spr.corona, s.x - R, s.y - R, 2 * R, 2 * R);
    }
    // Diffraction spikes: four long, four short at 45 degrees.
    if (spr?.spike && s.spikes > 0.5 && s.spikeAlpha > 0.003) {
      ctx.globalCompositeOperation = "lighter";
      const A = clamp(s.spikeAlpha * a);
      ctx.globalAlpha = A;
      this.spike(spr.spike, s.x, s.y, 0, s.spikes, 3.2);
      this.spike(spr.spike, s.x, s.y, Math.PI / 2, s.spikes, 3.2);
      ctx.globalAlpha = clamp(0.6 * A);
      this.spike(spr.spike, s.x, s.y, Math.PI / 4, s.spikes * 0.42, 3.2);
      this.spike(spr.spike, s.x, s.y, -Math.PI / 4, s.spikes * 0.42, 3.2);
      ctx.globalCompositeOperation = "source-over";
    }
    // The white-hot core.
    ctx.globalAlpha = a;
    ctx.fillStyle = css(mix3(s.color, [1, 0.98, 0.94], 0.55 + 0.45 * flare));
    ctx.beginPath();
    ctx.arc(s.x, s.y, Math.max(core * 0.62, 0.4), 0, TAU);
    ctx.fill();

    const R = s.arcRadius;
    if (s.arcAlpha > 0.001 && R > 0) {
      const A = clamp(s.arcAlpha * a);
      const arcCol: RGB = s.error ? C.vermilion : C.giltSoft;
      ctx.lineWidth = 1;
      ctx.lineCap = "butt";
      // The full track and its dial ticks.
      ctx.strokeStyle = css(C.giltSoft, 1);
      ctx.globalAlpha = 0.12 * A;
      ctx.beginPath();
      ctx.arc(s.x, s.y, R, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 0.3 * A;
      ctx.beginPath();
      for (let i = 0; i < 12; i++) {
        const ang = (i / 12) * TAU;
        ctx.moveTo(s.x + Math.sin(ang) * (R + 1.5), s.y - Math.cos(ang) * (R + 1.5));
        ctx.lineTo(s.x + Math.sin(ang) * (R + 3.5), s.y - Math.cos(ang) * (R + 3.5));
      }
      ctx.stroke();
      // The filled part, from twelve o'clock clockwise.
      const frac = clamp(s.arc);
      if (frac > 0) {
        ctx.strokeStyle = css(arcCol);
        ctx.globalAlpha = A;
        ctx.beginPath();
        ctx.arc(s.x, s.y, R, -Math.PI / 2, -Math.PI / 2 + frac * TAU);
        ctx.stroke();
      }
      if (s.error) {
        // A short radial cut at the end of the arc.
        const ang = frac * TAU;
        ctx.strokeStyle = css(C.vermilion);
        ctx.globalAlpha = a;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(s.x + Math.sin(ang) * (R - 4), s.y - Math.cos(ang) * (R - 4));
        ctx.lineTo(s.x + Math.sin(ang) * (R + 5), s.y - Math.cos(ang) * (R + 5));
        ctx.stroke();
      }
    }
    if (s.pulse > 0 && R > 0) {
      const p = clamp(s.pulse);
      ctx.strokeStyle = css(C.giltSoft);
      ctx.globalAlpha = (1 - p) * (1 - p) * 0.8 * a;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(s.x, s.y, R + p * 16, 0, TAU);
      ctx.stroke();
    }
  }
}

function sub3(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function scale3(a: V3, k: number): V3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}
function mix3(a: RGB, b: RGB, t: number): RGB {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

/** Colour temperature -1 (blue) .. 1 (warm) to a tint (FIELD_VS). */
function tempColor(t: number): RGB {
  return t < 0 ? mix3([1, 1, 1], [0.78, 0.86, 1], -t) : mix3([1, 1, 1], [1, 0.9, 0.74], t);
}
function tempBucket(t: number): number {
  return Math.max(0, Math.min(6, Math.round(((t + 1) / 2) * 6)));
}
