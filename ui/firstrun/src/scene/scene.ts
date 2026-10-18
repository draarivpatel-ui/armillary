/**
 * The first-run scene: a pure function of (inputs, t) -> Frame, with memoisation that never
 * changes results (schedule by input count, label keyframes by index, placement by catalogue).
 * No clock is read here. The host passes t (the rAF timestamp or a capture seek).
 */
import type { CatalogueEntry, FamilyKey } from "../events";
import { clamp, easeInOutCubic, easeOutBack, easeOutCubic, mix, smoothTowards, smoothstep, span } from "../math/ease";
import { add, mulMV, normalize, project, scale as vscale, type Camera, type V3 } from "../math/vec";
import { PRIORITY, solveLabels, type LabelRequest, type Obstacle, type PlacedLabel, type Rect } from "../labels/solver";
import { cameraAt, PLACEMENT_VIEW, uiScale } from "./camera";
import {
  AXIS_DIR,
  evaluateInstrument,
  PLAQUE_INTERACTIVE,
  RINGS,
  restPose,
  ringNumerals,
  ringPoint,
  ringRadial,
  ringTangent,
  STAR_RADIUS,
  T,
  type RingState,
} from "./instrument";
import { C, FAMILY, FONT, mixRGB } from "./palette";
import { buildSchedule, CONST, EXIT, HANDOFF, introTime, SCAN, type AgentSched, type ConstellationSched, type Schedule } from "./schedule";
import { buildField, placeCatalogue, starAt, type CatalogueStar, type FieldLayer } from "./sky";
import type {
  BeamState,
  CartoucheState,
  Frame,
  HandoffTarget,
  LinkDraw,
  OrbitDraw,
  Phase,
  PlanetDraw,
  RuleState,
  SceneConfig,
  SceneInput,
  StarDraw,
  SunDraw,
  TextDraw,
  TextStyle,
} from "./types";

/** Label keyframe spacing (ms). Labels re-solve at most this often and glide between solutions. */
export const LABEL_KEY = 200;

export const TITLE = "ARMILLARY";
/** SPEC 0 and 3A: the product line, verbatim from the SPEC title. */
export const SUBTITLE = "Every AI agent you use, in one observatory";

interface LabelSpec {
  req: LabelRequest;
  /** Builds the text items for a box placed at (x, y). */
  draw: (x: number, y: number, alpha: number) => TextDraw[];
  /** For keyed placements: builds the items for a chosen candidate key at the current t. */
  drawKey?: (key: string, alpha: number) => TextDraw[];
  /** For sticky keyed placements: the box of a candidate key at this spec's time. */
  slotBox?: (key: string) => Rect | null;
}

interface Callout {
  id: string;
  entry: CatalogueEntry;
  a: AgentSched;
  star: { x: number; y: number; z: number };
  /** Star height when the order was frozen. */
  orderY: number;
  /** Star position when the order was frozen. */
  orderStar: { x: number; y: number };
  side: -1 | 1;
  w: number;
  h: number;
  /** 0..1 how much room the label takes (it grows in as the star ignites). */
  weight: number;
  nameW: number;
  subW: number;
  sub: { text: string; error: boolean } | null;
  box: Rect;
  nameFont: string;
  subFont: string;
  subTracking: number;
  nameSize: number;
  subSize: number;
  glyphW: number;
}

interface LabelSolve {
  placed: Map<string, PlacedLabel>;
  anchors: Map<string, { x: number; y: number }>;
}

/** Label hint chains restart at scene boundaries and every CHAIN_EPOCH ms, so a cold seek is bounded. */
const CHAIN_EPOCH = 10000;
function segmentIndex(s: Schedule, t: number): number {
  const marks = [s.consentAt, s.scanEndAt, s.handoffAt, s.exitAt].filter((m): m is number => m !== undefined && m <= t);
  // Only the open-ended wait before consent is cut into epochs; after consent every scene is bounded.
  const epoch = s.consentAt === undefined || t < s.consentAt ? Math.floor(t / CHAIN_EPOCH) : 0;
  return marks.length * 1_000_000 + epoch;
}

export class Scene {
  private cfg: SceneConfig;
  private inputs: SceneInput[] = [];
  private sched: Schedule | null = null;
  private placement: Map<string, CatalogueStar> = new Map();
  private placementKey = "";
  private labelCache = new Map<number, LabelSolve>();
  readonly field: FieldLayer[] = buildField();

  constructor(cfg: SceneConfig) {
    this.cfg = cfg;
  }

  get config(): SceneConfig {
    return this.cfg;
  }

  setConfig(patch: Partial<SceneConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
    this.labelCache.clear();
  }

  setInputs(list: SceneInput[]): void {
    this.inputs = list.slice().sort((a, b) => a.at - b.at);
    this.sched = null;
    this.labelCache.clear();
  }

  push(input: SceneInput): void {
    this.inputs.push(input);
    if (this.inputs.length > 1 && this.inputs[this.inputs.length - 2].at > input.at) this.inputs.sort((a, b) => a.at - b.at);
    this.sched = null;
    // Causality: solutions at keyframes before this input stay valid.
    for (const k of [...this.labelCache.keys()]) if (k * LABEL_KEY >= input.at) this.labelCache.delete(k);
  }

  getInputs(): readonly SceneInput[] {
    return this.inputs;
  }

  schedule(): Schedule {
    if (!this.sched) {
      this.sched = buildSchedule(this.inputs, {
        place: (ids) => this.ensurePlacement(ids),
        starPos: (id) => this.placement.get(id)?.p0,
      });
    }
    return this.sched;
  }

  private ensurePlacement(ids: string[]): CatalogueStar[] {
    const key = ids.join("|");
    if (key !== this.placementKey) {
      this.placementKey = key;
      const placed = placeCatalogue(ids, PLACEMENT_VIEW, blockedForPlacement);
      this.placement = new Map(placed.map((p) => [p.id, p]));
    }
    return ids.map((id) => this.placement.get(id)!);
  }

  phaseAt(t: number): Phase {
    const s = this.schedule();
    if (s.completeAt !== undefined && t >= s.completeAt) return "complete";
    if (s.exitAt !== undefined && t >= s.exitAt) return "exit";
    if (s.handoffAt !== undefined && t >= s.handoffAt) return "handoff";
    if (s.scanEndAt !== undefined && t >= s.scanEndAt) return "constellations";
    if (s.consentAt !== undefined && t >= s.consentAt) return "scan";
    if (introTime(s, t) >= T.plaque[0]) return "consent";
    return "intro";
  }

  /** Sky spin about the polar axis (radians), closed form so seeking is exact. */
  spinAt(t: number): number {
    const s = this.schedule();
    if (s.scanEndAt === undefined || t <= s.scanEndAt || this.cfg.reducedMotion) return 0;
    const T0 = CONST.spinRamp;
    const u = t - s.scanEndAt;
    if (u < T0) {
      const x = u / T0;
      return CONST.spinRate * T0 * (x * x * x - (x * x * x * x) / 2);
    }
    return CONST.spinRate * (T0 / 2 + (u - T0));
  }

  evaluate(t: number): Frame {
    const s = this.schedule();
    const { w, h, reducedMotion: reduced } = this.cfg;
    const u = uiScale(w, h);
    const phase = this.phaseAt(t);
    const ti = introTime(s, t);
    const spin = this.spinAt(t);
    const cam = cameraAt({ w, h, t, consentAt: s.consentAt, handoffAt: s.handoffAt, reduced });
    const inst = evaluateInstrument(ti, spin, reduced);

    const ha = s.handoffAt;
    const hu = ha !== undefined && t > ha ? t - ha : -1;
    const exitU = s.exitAt !== undefined && t > s.exitAt ? t - s.exitAt : -1;

    // ---- global fades
    let canvasAlpha = 1;
    let appAlpha = 0;
    if (hu >= 0) {
      const dur = reduced ? HANDOFF.reducedDur : HANDOFF.dur;
      const fade = reduced ? HANDOFF.reducedDur : HANDOFF.fade;
      canvasAlpha = 1 - smoothstep(dur - fade, dur, hu);
      appAlpha = smoothstep(dur - fade - 150, dur - 80, hu);
    }
    if (exitU >= 0) {
      canvasAlpha = Math.min(canvasAlpha, 1 - smoothstep(0, EXIT.dur, exitU));
      appAlpha = Math.max(appAlpha, smoothstep(0, EXIT.dur - 60, exitU));
    }
    if (phase === "complete") {
      canvasAlpha = 0;
      appAlpha = 1;
    }
    const target = (s.target && t >= (s.targetAt ?? 0) ? s.target : undefined) ?? (hu >= 0 ? fallbackTarget(w, h, s) : undefined);
    const lightLanding = target?.theme === "light";

    // ---- sky
    const sky = {
      layers: [
        reduced ? smoothstep(0, 600, t) : easeOutCubic(span(ti, T.skyFar[0], T.skyFar[1])),
        reduced ? smoothstep(0, 600, t) : easeOutCubic(span(ti, T.skyMid[0], T.skyMid[1])),
        reduced ? smoothstep(0, 600, t) : easeOutCubic(span(ti, T.skyNear[0], T.skyNear[1])),
      ] as [number, number, number],
      time: t / 1000,
      zoom: hu >= 0 && !reduced ? 1 + 0.32 * easeInOutCubic(span(hu, 0, 2400)) : 1,
      parchment: lightLanding && hu >= 0 ? smoothstep(2350, 3150, hu) : 0,
      nebula: reduced ? smoothstep(0, 600, t) : easeOutCubic(span(ti, 600, 2600)),
    };

    // ---- the rule around the window, morphing onto the Orrery frame during the hand-over
    const inset = 22 * u;
    let rect = { x: inset, y: inset, w: w - 2 * inset, h: h - 2 * inset };
    let band = 7 * u;
    let keys = reduced ? smoothstep(0, 600, t) : span(ti, T.ruleKeys[0], T.ruleKeys[1]);
    let scale: RuleState["scale"] = null;
    if (hu >= 0 && target) {
      // The rule's outer hairline lands on the Orrery's outer hairline, its inner one on the inner
      // rule, and the keys give way to the Orrery's own degree scale.
      const m = reduced ? 0 : easeInOutCubic(span(hu, 900, 1700));
      const f = target.frame;
      const tr = { x: target.stage.x + f.outerInset, y: target.stage.y + f.outerInset, w: target.stage.w - 2 * f.outerInset, h: target.stage.h - 2 * f.outerInset };
      rect = { x: mix(rect.x, tr.x, m), y: mix(rect.y, tr.y, m), w: mix(rect.w, tr.w, m), h: mix(rect.h, tr.h, m) };
      band = mix(band, f.innerInset - f.outerInset, m);
      keys *= 1 - m;
      const sa = reduced ? 0 : smoothstep(0.45, 1, m);
      if (sa > 0) scale = { alpha: sa, minorTickDeg: f.minorTickDeg, midTickDeg: f.midTickDeg, majorTickDeg: f.majorTickDeg };
    }
    const rule = {
      rect,
      draw: reduced ? smoothstep(0, 600, t) : easeOutCubic(span(ti, T.ruleDraw[0], T.ruleDraw[1])),
      keys,
      numerals: (reduced ? smoothstep(0, 600, t) : span(ti, T.ruleNumerals[0], T.ruleNumerals[1])) * (hu >= 0 ? 1 - smoothstep(600, 1400, hu) : 1),
      band,
      alpha: 1,
      scale,
    };

    // ---- instrument visibility
    const instrumentAlpha = hu >= 0 ? (reduced ? 1 : 1 - smoothstep(350, 1350, hu)) : 1;
    const glintAng = (t / 1000) * ((2 * Math.PI) / 15);
    const glint: V3 = normalize([Math.cos(glintAng) * 0.9, 0.55 + 0.25 * Math.sin(glintAng * 0.7), Math.sin(glintAng) * 0.9 + 0.35]);

    // ---- stars, beam, links
    const stars: StarDraw[] = [];
    const starScreen = new Map<string, { x: number; y: number; z: number }>();
    const consent = s.consentAt;
    if (consent !== undefined && t >= consent && s.catalogueAt !== undefined && t >= s.catalogueAt) {
      for (const entry of s.catalogue) {
        const a = s.agents.get(entry.id)!;
        const pl = this.placement.get(entry.id);
        if (!pl) continue;
        const p3 = starAt(pl, spin);
        const pr = project(cam, p3);
        const vz = mulMV(cam.view, p3)[2] / STAR_RADIUS;
        starScreen.set(entry.id, { x: pr.x, y: pr.y, z: vz });
        stars.push(this.starDraw(entry.id, entry.family, a, pr.x, pr.y, vz, t, cam));
      }
    }
    const beam = this.beamAt(t, s, starScreen);
    const links = this.linksAt(t, s, starScreen);

    // ---- hand-over: stars converge into suns, suns ignite, planets spin out
    const suns: SunDraw[] = [];
    const orbits: OrbitDraw[] = [];
    const planets: PlanetDraw[] = [];
    if (hu >= 0 && target && !reduced) this.handoffBodies(hu, s, target, stars, links, suns, orbits, planets, w, h);
    if (hu >= 0 && reduced && target) {
      // Reduced motion: no camera moves; the suns and planets simply appear for the cross-fade.
      const a = smoothstep(0, 400, hu);
      for (const sun of target.suns) suns.push({ id: sun.id, x: sun.x, y: sun.y, r: sun.r, alpha: a, flash: 0, rays: 1, ring: 1, face: 1 });
      for (const p of target.planets) {
        orbits.push({ ...p.orbit, draw: 1, alpha: a, done: p.done });
        planets.push({ id: p.id, x: p.x, y: p.y, r: p.r, color: p.color, alpha: a, family: p.family, state: p.state, sunX: p.orbit.cx, sunY: p.orbit.cy });
      }
      for (const st of stars) st.alpha *= 1 - a;
      for (const l of links) l.alpha *= 1 - a;
    }

    // ---- text and labels
    const texts: TextDraw[] = [];
    const titleObstacles: Obstacle[] = [];
    this.titleTexts(ti, t, s, u, texts, titleObstacles, hu);
    const cartouche = this.cartoucheAt(t, s, u, hu);
    if (cartouche.alpha > 0) {
      const cw = 300 * u;
      const ch = 92 * u;
      titleObstacles.push({ kind: "rect", x: cartouche.x - cw / 2, y: cartouche.y - ch / 2, w: cw, h: ch });
    }
    this.labelTexts(t, texts, cam, spin, hu, exitU);
    if (hu >= 0 && target) this.sunTexts(hu, target, suns, texts, u, reduced);

    // ---- plaque
    const plaque = this.plaqueAt(t, ti, s, h);

    const skipVisible =
      phase === "intro" || phase === "scan" || phase === "constellations" || (phase === "handoff" && hu < HANDOFF.dur - HANDOFF.fade);

    return {
      t,
      w,
      h,
      phase,
      reducedMotion: reduced,
      sky,
      rule,
      cam,
      spin,
      rings: inst.rings,
      axis: inst.axis,
      globe: inst.globe,
      instrumentAlpha,
      glint,
      beam,
      stars,
      links,
      suns,
      orbits,
      planets,
      texts,
      cartouche,
      plaque,
      canvasAlpha,
      appAlpha,
      skipVisible,
    };
  }

  // ------------------------------------------------------------------------------------------
  // Stars

  private starDraw(id: string, family: FamilyKey, a: Schedule["agents"] extends Map<string, infer V> ? V : never, x: number, y: number, z: number, t: number, cam: Camera): StarDraw {
    const reduced = this.cfg.reducedMotion;
    const u = uiScale(this.cfg.w, this.cfg.h);
    const color = FAMILY[family];
    const depthFade = clamp(0.35 + 0.65 * smoothstep(-0.25, 0.35, z));
    // Chart dots sweep in clockwise from the top, like a beam passing over the chart.
    const dotAt = this.dotAt(id, x, y, cam.cx, cam.cy);
    const dotA = reduced ? smoothstep(dotAt, dotAt + 250, t) : easeOutCubic(span(t, dotAt, 500));
    const base: StarDraw = {
      id,
      x,
      y,
      z,
      found: false,
      family,
      color: mixRGB(C.dust, color, 0.25),
      alpha: dotA * 0.55 * depthFade,
      core: 1.25 * u,
      flare: 0,
      spikes: 0,
      spikeAlpha: 0,
      bloom: 0,
      bloomAlpha: 0,
      arc: 0,
      arcAlpha: 0,
      arcRadius: 0,
      pulse: 0,
      error: false,
    };
    if (a.igniteAt === undefined || t < a.igniteAt) return base;
    const k = t - a.igniteAt;
    base.found = true;
    base.color = color;
    if (reduced) {
      // Stars appear without flares.
      const ap = smoothstep(0, 300, k);
      base.alpha = depthFade * mix(base.alpha, 1, ap);
      base.core = mix(1.25, 2.6, ap) * u;
      base.bloom = 9 * u;
      base.bloomAlpha = 0.28 * ap;
    } else {
      const flare = Math.exp(-k / 260) * smoothstep(0, 40, k);
      const settle = easeOutCubic(span(k, 0, 700));
      base.alpha = depthFade;
      base.flare = flare;
      base.core = (mix(1.25, 2.6, settle) + 2.2 * flare) * u;
      base.spikes = (mix(0, 21, settle) + 52 * flare) * u;
      base.spikeAlpha = 0.62 + 0.38 * flare;
      base.bloom = (mix(4, 15, settle) + 34 * flare) * u;
      base.bloomAlpha = 0.42 + 0.5 * flare;
    }
    if (a.history && a.importStartAt !== undefined && t >= a.importStartAt) {
      base.arc = clamp(smoothTowards(a.steps, t, SCAN.arcRate, 0));
      base.arcAlpha = (reduced ? 1 : smoothstep(a.importStartAt, a.importStartAt + 300, t)) * depthFade;
      base.arcRadius = 11.5 * u;
      if (reduced && a.finishedAt !== undefined && t >= a.finishedAt) base.arc = 1;
    }
    if (a.pulseAt !== undefined && t >= a.pulseAt && !reduced) {
      const p = span(t, a.pulseAt, 900);
      base.pulse = p < 1 ? p : 0;
    }
    if (a.errorAt !== undefined && t >= a.errorAt) base.error = true;
    return base;
  }

  /** When a catalogue star's chart dot appears (the sweep passes it). */
  private dotAt(id: string, x: number, y: number, cx: number, cy: number): number {
    const s = this.schedule();
    if (s.consentAt === undefined || s.catalogueAt === undefined || !this.placement.has(id)) return Infinity;
    const ang = Math.atan2(x - cx, -(y - cy));
    const sweep = this.cfg.reducedMotion ? 0 : ((ang + Math.PI) / (2 * Math.PI)) * SCAN.dotsSweep;
    return Math.max(s.catalogueAt, s.consentAt + SCAN.dotsFrom) + sweep;
  }

  private beamAt(t: number, s: Schedule, scr: Map<string, { x: number; y: number }>): BeamState | null {
    if (this.cfg.reducedMotion || s.consentAt === undefined || t < s.consentAt + 500) return null;
    const { w, h } = this.cfg;
    const px = w / 2;
    const py = h + h * 0.08;
    const angleTo = (x: number, y: number) => Math.atan2(x - px, py - y);
    const ign = s.ignitions.map((id) => ({ id, at: s.agents.get(id)!.igniteAt! }));
    const lastIgn = ign.length ? ign[ign.length - 1].at : undefined;
    const endAt = s.scanEndAt ?? Infinity;
    const off = Math.min(endAt, lastIgn !== undefined && s.doneAt !== undefined ? Math.max(lastIgn + 900, s.doneAt) : Infinity);
    const alpha = smoothstep(s.consentAt + 500, s.consentAt + 1300, t) * (1 - smoothstep(off, off + 700, t));
    if (alpha <= 0.001) return null;
    const idle = (tt: number) => 0.34 * Math.sin((tt - s.consentAt!) / 1400);
    let angle = idle(t);
    let spot: BeamState["spot"] = null;
    // Aim at the next ignition: ease from the previous aim to this star, arriving as it ignites.
    let prevAt = s.consentAt + 500;
    let prevAngle = idle(prevAt);
    for (let i = 0; i < ign.length; i++) {
      const p = scr.get(ign[i].id);
      if (!p) continue;
      const a = angleTo(p.x, p.y);
      const travel = Math.min(520, Math.max(160, ign[i].at - prevAt));
      if (t < ign[i].at) {
        const k = easeInOutCubic(span(t, ign[i].at - travel, travel));
        angle = t < ign[i].at - travel ? prevAngle : mix(prevAngle, a, k);
        break;
      }
      angle = a;
      const since = t - ign[i].at;
      if (since < 420) spot = { x: p.x, y: p.y, r: 26 * uiScale(w, h), alpha: 1 - since / 420 };
      prevAt = ign[i].at;
      prevAngle = a;
      if (i === ign.length - 1) {
        // Drift back into a slow idle sweep while the imports finish.
        const k = easeInOutCubic(span(t, ign[i].at + 300, 1400));
        angle = mix(a, idle(t), k);
      }
    }
    return { x: px, y: py, angle, length: h * 1.08, spread: 0.075, alpha: alpha * 0.9, spot };
  }

  private linksAt(t: number, s: Schedule, scr: Map<string, { x: number; y: number; z: number }>): LinkDraw[] {
    const out: LinkDraw[] = [];
    const reduced = this.cfg.reducedMotion;
    for (const c of s.constellations) {
      c.edges.forEach(([a, b], j) => {
        const pa = scr.get(a);
        const pb = scr.get(b);
        if (!pa || !pb) return;
        const st = c.startAt + j * CONST.edgeStagger;
        const p = reduced ? smoothstep(c.startAt, c.startAt + 400, t) : easeOutCubic(span(t, st, CONST.edgeDur));
        if (p <= 0) return;
        const depth = Math.min(smoothstep(-0.3, 0.3, pa.z), smoothstep(-0.3, 0.3, pb.z));
        out.push({ x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, progress: reduced ? 1 : p, alpha: (reduced ? p : 1) * (0.35 + 0.65 * depth), tip: !reduced && p < 1 ? 1 : 0 });
      });
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------
  // Hand-over

  private handoffBodies(
    hu: number,
    s: Schedule,
    target: HandoffTarget,
    stars: StarDraw[],
    links: LinkDraw[],
    suns: SunDraw[],
    orbits: OrbitDraw[],
    planets: PlanetDraw[],
    w: number,
    h: number,
  ): void {
    const sunFor = new Map<string, (typeof target.suns)[number]>();
    for (const c of s.constellations) {
      const sun = target.suns.find((x) => x.root === c.root) ?? target.suns.find((x) => x.name === c.name);
      if (sun) for (const m of c.members) if (!sunFor.has(m)) sunFor.set(m, sun);
    }
    const sunOrder = new Map(target.suns.map((x, i) => [x.id, i]));
    // Stars that belong to a landing constellation travel into their sun; the rest drift out.
    for (const st of stars) {
      if (!st.found) {
        st.alpha *= 1 - smoothstep(0, 650, hu);
        continue;
      }
      const sun = sunFor.get(st.id);
      if (!sun) {
        // Nothing live in that project: the star streams toward the nearest sun and dissolves into it.
        let near: (typeof target.suns)[number] | null = null;
        let best = Infinity;
        for (const sn of target.suns) {
          const d = Math.hypot(sn.x - st.x, sn.y - st.y);
          if (d < best) {
            best = d;
            near = sn;
          }
        }
        const k = easeInOutCubic(span(hu, 300, 1100));
        if (near) {
          st.x += (near.x - st.x) * k * 0.85;
          st.y += (near.y - st.y) * k * 0.85;
        } else {
          st.x += (st.x - w / 2) * 0.6 * k;
          st.y += (st.y - h / 2) * 0.6 * k;
        }
        st.spikes *= 1 - k;
        st.arcAlpha *= 1 - smoothstep(0, 0.4, k);
        st.alpha *= 1 - smoothstep(0.55, 1, k);
        continue;
      }
      const i = sunOrder.get(sun.id) ?? 0;
      const c = easeInOutCubic(span(hu, 240 + i * 90, 1150));
      // A gentle arc rather than a straight line: bend perpendicular to the path.
      const dx = sun.x - st.x;
      const dy = sun.y - st.y;
      const bend = Math.sin(Math.PI * c) * 0.18;
      st.x = st.x + dx * c - dy * bend;
      st.y = st.y + dy * c + dx * bend;
      st.spikes *= 1 - c;
      st.arcAlpha *= 1 - smoothstep(0, 0.4, c);
      st.bloom = mix(st.bloom, sun.r * 1.6, c);
      st.alpha *= 1 - smoothstep(0.82, 1, c);
    }
    // Links follow their stars (recompute endpoints from the moved stars).
    const pos = new Map(stars.map((st) => [st.id, st]));
    let li = 0;
    for (const c of s.constellations) {
      for (const [a, b] of c.edges) {
        const l = links[li];
        const pa = pos.get(a);
        const pb = pos.get(b);
        if (l && pa && pb) {
          l.x1 = pa.x;
          l.y1 = pa.y;
          l.x2 = pb.x;
          l.y2 = pb.y;
          l.alpha *= Math.min(pa.alpha, pb.alpha) > 0 ? 1 - smoothstep(900, 1500, hu) : 0;
          l.tip = 0;
        }
        li++;
      }
    }
    target.suns.forEach((sun, i) => {
      // Each sun forms as its constellation arrives: a flash, the medallion, then the Orrery's
      // engraving etches in (graduated ring drawn round, rays in splendour grown, face cut).
      const st = 1050 + i * 90;
      const p = span(hu, st, 520);
      if (p <= 0) return;
      suns.push({
        id: sun.id,
        x: sun.x,
        y: sun.y,
        r: sun.r * clamp(easeOutBack(p, 1.4), 0, 1.15),
        alpha: smoothstep(0, 0.3, p),
        flash: Math.exp(-(hu - st) / 300) * smoothstep(0, 60, hu - st),
        ring: easeInOutCubic(span(hu, st + 160, 760)),
        rays: easeOutBack(span(hu, st + 320, 620), 1.3),
        face: easeOutCubic(span(hu, st + 420, 700)),
      });
    });
    target.planets.forEach((pl, i) => {
      const si = sunOrder.get(pl.sunId) ?? 0;
      const st = 1550 + si * 90 + (i % 6) * 70;
      const od = easeOutCubic(span(hu, st - 200, 850));
      if (od > 0) orbits.push({ ...pl.orbit, draw: od, alpha: 1, done: pl.done });
      const e = easeOutCubic(span(hu, st, 950));
      if (e <= 0) return;
      // Spiral out of the sun onto the orbit, arriving at the live Orrery's angle.
      const ang = pl.angle - (1 - e) * 2.4;
      const { cx, cy, a, b, tilt } = pl.orbit;
      const ux = a * Math.cos(ang) * e;
      const uy = b * Math.sin(ang) * e;
      const x = cx + ux * Math.cos(tilt) - uy * Math.sin(tilt);
      const y = cy + ux * Math.sin(tilt) + uy * Math.cos(tilt);
      planets.push({ id: pl.id, x, y, r: pl.r * mix(0.4, 1, e), color: pl.color, alpha: smoothstep(0, 0.2, e), family: pl.family, state: pl.state, sunX: cx, sunY: cy });
    });
  }

  // ------------------------------------------------------------------------------------------
  // Title, subtitle, counter, plaque

  private titleTexts(ti: number, t: number, s: Schedule, u: number, out: TextDraw[], obstacles: Obstacle[], hu: number): void {
    const { w, h, reducedMotion: reduced } = this.cfg;
    const leave = s.consentAt !== undefined ? 1 - (reduced ? smoothstep(s.consentAt, s.consentAt + 300, t) : easeOutCubic(span(t, s.consentAt, 700))) : 1;
    const gone = s.declineAt !== undefined ? 1 - smoothstep(s.declineAt, s.declineAt + 500, t) : 1;
    // The title steps back while the plaque hangs in front of it, and returns if it is declined.
    const plaque = this.plaqueAt(t, ti, s, h);
    const under = plaque.visible ? clamp(1 + plaque.offsetY / (h * 0.5)) * plaque.alpha : 0;
    const a = leave * gone * (hu >= 0 ? 0 : 1) * (1 - under);
    if (a <= 0) return;
    const size = 56 * u;
    const tracking = 0.3 * size;
    const font = `600 ${size.toFixed(2)}px ${FONT.display}`;
    const tw = this.cfg.measure(font, TITLE, tracking);
    const lift = (1 - leave) * 26 * u;
    const y = h * 0.872 - lift;
    const titleStart = T.title[0];
    const per = T.title[1];
    const dur = T.title[2];
    const reveal = reduced ? 1 : clamp((ti - titleStart) / (per * (TITLE.length - 1) + dur));
    const ta = reduced ? smoothstep(titleStart, titleStart + 450, ti) : smoothstep(titleStart - 50, titleStart + 150, ti);
    if (ta > 0)
      out.push({ id: "title", text: TITLE, style: "title", font, tracking, x: w / 2, y, align: "center", color: C.gilt, alpha: a * ta, reveal });
    const sub = 14.5 * u;
    const subFont = `500 ${sub.toFixed(2)}px ${FONT.sans}`;
    const subTracking = 0.24 * sub;
    const sa = reduced ? smoothstep(T.subtitle[0], T.subtitle[0] + 450, ti) : easeOutCubic(span(ti, T.subtitle[0], T.subtitle[1]));
    if (sa > 0)
      out.push({ id: "subtitle", text: SUBTITLE.toUpperCase(), style: "subtitle", font: subFont, tracking: subTracking, x: w / 2, y: y + 40 * u, align: "center", color: mixRGB(C.dust, C.star, 0.25), alpha: a * sa, reveal: 1 });
    obstacles.push({ kind: "rect", x: w / 2 - tw / 2 - 12 * u, y: y - size * 0.8, w: tw + 24 * u, h: size * 0.8 + 52 * u });
  }

  private cartoucheAt(t: number, s: Schedule, u: number, hu: number): CartoucheState {
    const { w, h, reducedMotion: reduced } = this.cfg;
    const st = s.consentAt !== undefined ? s.consentAt + 900 : Infinity;
    let alpha = reduced ? smoothstep(st, st + 300, t) : easeOutCubic(span(t, st, 700));
    if (hu >= 0) alpha *= 1 - smoothstep(0, 600, hu);
    if (s.exitAt !== undefined) alpha *= 1 - smoothstep(s.exitAt, s.exitAt + 300, t);
    let found = 0;
    let sessions = 0;
    let sessionsAlpha = 0;
    const catalogue = s.catalogueAt !== undefined && t >= s.catalogueAt ? s.catalogue.length : 0;
    for (const id of s.ignitions) {
      const a = s.agents.get(id)!;
      if (a.igniteAt! <= t) found++;
      if (a.importStartAt !== undefined && t >= a.importStartAt) {
        const frac = clamp(smoothTowards(a.steps, t, SCAN.arcRate, 0));
        sessions += reduced ? (a.finishedAt !== undefined && t >= a.finishedAt ? a.imported : 0) : frac * Math.max(a.known, a.imported);
        sessionsAlpha = 1;
      }
    }
    return { alpha, found, catalogue, sessions: Math.round(sessions), sessionsAlpha, x: w / 2, y: h - 100 * u };
  }

  private plaqueAt(t: number, ti: number, s: Schedule, h: number): Frame["plaque"] {
    const reduced = this.cfg.reducedMotion;
    const st = T.plaque[0];
    if (ti < st) return { visible: false, offsetY: -h, swing: 0, alpha: 0, interactive: false };
    let offsetY: number;
    let swing = 0;
    let alpha = 1;
    if (reduced) {
      offsetY = 0;
      alpha = smoothstep(st, st + 400, ti);
    } else {
      const p = span(ti, st, T.plaque[1]);
      // Lowered on chains: a quick drop that checks and settles with a small bounce.
      const drop = clamp(1 - Math.pow(1 - Math.min(1, p * 1.35), 3) + Math.sin(Math.min(1, p) * Math.PI * 3.2) * Math.exp(-p * 5) * 0.035 * smoothstep(0.3, 0.6, p), 0, 1.04);
      offsetY = -(1 - drop) * h * 0.9;
      swing = Math.sin(p * Math.PI * 2.4) * Math.exp(-p * 3.2) * 0.012;
    }
    const resolved = s.consentAt ?? s.declineAt;
    if (resolved !== undefined && t >= resolved) {
      const r = span(t, resolved, EXIT.plaqueRise);
      if (reduced) alpha *= 1 - r;
      else offsetY -= easeInOutCubic(r) * h * 0.95;
      if (r >= 1) return { visible: false, offsetY, swing: 0, alpha: 0, interactive: false };
    }
    const interactive = (resolved === undefined || t < resolved) && ti >= PLAQUE_INTERACTIVE;
    return { visible: true, offsetY, swing, alpha, interactive };
  }

  // ------------------------------------------------------------------------------------------
  // Labels.
  // Found agents: chart callouts in two columns outside the sphere's silhouette, joined to their
  // stars by fine gilt leaders, stacked by star height (a continuous function of t: new labels make
  // room smoothly; the order freezes when the sky starts to turn, so nothing jumps).
  // Constellation names: written along an edge of their own figure (solver-placed at keyframes).
  // Ring numerals: fixed on their bands, kept only where the solver finds them clear.

  /** Callout layout at time t (pure). */
  private callouts(t: number, cam: Camera, spin: number): Callout[] {
    const s = this.schedule();
    const { w, h, reducedMotion: reduced } = this.cfg;
    const u = uiScale(w, h);
    if (s.consentAt === undefined || t < s.consentAt || s.catalogueAt === undefined || t < s.catalogueAt) return [];
    const nameSize = 17 * u;
    const nameFont = `600 ${nameSize.toFixed(2)}px ${FONT.display}`;
    const subSize = 10 * u;
    const subFont = `600 ${subSize.toFixed(2)}px ${FONT.sans}`;
    const subTracking = 0.14 * subSize;
    const glyphW = 17 * u;
    const gap = 9 * u;
    // Order and side are taken at a time when the sky does not turn (the scan), then frozen.
    const tOrder = s.scanEndAt !== undefined ? Math.min(t, s.scanEndAt) : t;
    const camOrder = tOrder === t ? cam : cameraAt({ w, h, t: tOrder, consentAt: s.consentAt, handoffAt: s.handoffAt, reduced });
    const spinOrder = tOrder === t ? spin : this.spinAt(tOrder);
    const items: Callout[] = [];
    for (const id of s.ignitions) {
      const a = s.agents.get(id)!;
      const ig = a.igniteAt!;
      if (t < ig + 40) continue;
      const pl = this.placement.get(id);
      if (!pl) continue;
      const p3 = starAt(pl, spin);
      const pr = project(cam, p3);
      const po = spinOrder === spin && camOrder === cam ? pr : project(camOrder, starAt(pl, spinOrder));
      const vz = mulMV(cam.view, p3)[2] / STAR_RADIUS;
      const sub = subLabel(a, t);
      const nameW = this.cfg.measure(nameFont, a.entry.name, 0);
      const subW = sub ? this.cfg.measure(subFont, sub.text.toUpperCase(), subTracking) : 0;
      const bw = Math.max(nameW, subW) + glyphW;
      const bh = nameSize * 1.12 + (sub ? subSize * 1.75 : 0);
      const weight = reduced ? smoothstep(ig, ig + 250, t) : easeInOutCubic(span(t, ig + 40, 420));
      items.push({ id, entry: a.entry, a, star: { x: pr.x, y: pr.y, z: vz }, orderStar: { x: po.x, y: po.y }, orderY: po.y, side: (po.x < camOrder.cx ? -1 : 1) as -1 | 1, w: bw, h: bh, weight, nameW, subW, sub, box: { x: 0, y: 0, w: bw, h: bh }, nameFont, subFont, subTracking, nameSize, subSize, glyphW });
    }
    // Balance the columns if one side is much fuller (move the stars nearest the middle across).
    const left = items.filter((c) => c.side < 0);
    const right = items.filter((c) => c.side > 0);
    const move = (from: Callout[], to: -1 | 1, n: number) => {
      from
        .slice()
        .sort((p, q) => Math.abs(p.star.x - camOrder.cx) - Math.abs(q.star.x - camOrder.cx) || (p.id < q.id ? -1 : 1))
        .slice(0, n)
        .forEach((c) => (c.side = to));
    };
    if (left.length - right.length > 3) move(left, 1, Math.floor((left.length - right.length) / 2));
    if (right.length - left.length > 3) move(right, -1, Math.floor((right.length - left.length) / 2));
    const colGap = 30 * u;
    const top = 74 * u;
    const bottom = h - 64 * u;
    const colX = (side: number, c: Callout, cm: Camera) => (side > 0 ? cm.cx + cm.scale * 1.22 + colGap : cm.cx - cm.scale * 1.22 - colGap - c.w);
    // Where a star "wants" its label: on the ray from the sphere centre through the star, where it
    // meets the column. Leaders then fan out like the spokes of a wheel and rarely cross.
    const fanY = (c: Callout, sx: number, sy: number, cm: Camera) => {
      const inner = c.side > 0 ? cm.cx + cm.scale * 1.22 + colGap : cm.cx - cm.scale * 1.22 - colGap;
      const dx = Math.max(cm.scale * 0.32, Math.abs(sx - cm.cx));
      return clamp(cm.cy + ((sy - cm.cy) * Math.abs(inner - cm.cx)) / dx, top, bottom);
    };
    const stack = (col: Callout[], want: (c: Callout) => number, weight: (c: Callout) => number) => {
      let prevBottom = top;
      for (const c of col) {
        const wgt = weight(c);
        c.box.y = Math.max(want(c) - c.nameSize * 0.6, prevBottom + gap * wgt);
        prevBottom = c.box.y + c.h * wgt;
      }
      let nextTop = bottom;
      for (let i = col.length - 1; i >= 0; i--) {
        const c = col[i];
        const wgt = weight(c);
        c.box.y = Math.min(c.box.y, nextTop - c.h * wgt);
        nextTop = c.box.y - gap * wgt;
      }
      if (col.length && col[0].box.y < top) {
        let y = top;
        for (const c of col) {
          c.box.y = y;
          y += (c.h + gap) * weight(c);
        }
      }
    };
    const crosses = (a: Callout, b: Callout, ax: number, ay: number, bx: number, by: number) => {
      // Leader of a: (ax, ay) -> elbow at its label; same for b. Proper segment intersection.
      const ea = [a.side > 0 ? a.box.x - 18 * u : a.box.x + a.w + 18 * u, a.box.y + a.nameSize * 0.52];
      const eb = [b.side > 0 ? b.box.x - 18 * u : b.box.x + b.w + 18 * u, b.box.y + b.nameSize * 0.52];
      const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
      return o(ax, ay, ea[0], ea[1], bx, by) !== o(ax, ay, ea[0], ea[1], eb[0], eb[1]) && o(bx, by, eb[0], eb[1], ax, ay) !== o(bx, by, eb[0], eb[1], ea[0], ea[1]);
    };
    for (const side of [-1, 1] as const) {
      const col = items.filter((c) => c.side === side);
      // Order: fixed from the scan-time geometry (by fan position), then untangled by swapping
      // neighbours whose leaders cross. Frozen while the sky turns, so labels never jump.
      const at = new Map(col.map((c) => [c.id, c.orderStar]));
      col.sort((p, q) => fanY(p, at.get(p.id)!.x, at.get(p.id)!.y, camOrder) - fanY(q, at.get(q.id)!.x, at.get(q.id)!.y, camOrder) || (p.id < q.id ? -1 : 1));
      for (const c of col) c.box.x = colX(side, c, camOrder);
      for (let pass = 0; pass < col.length; pass++) {
        stack(col, (c) => fanY(c, at.get(c.id)!.x, at.get(c.id)!.y, camOrder), () => 1);
        let swapped = false;
        for (let i = 0; i + 1 < col.length; i++) {
          const a = col[i];
          const b = col[i + 1];
          const pa = at.get(a.id)!;
          const pb = at.get(b.id)!;
          if (crosses(a, b, pa.x, pa.y, pb.x, pb.y)) {
            col[i] = b;
            col[i + 1] = a;
            swapped = true;
          }
        }
        if (!swapped) break;
      }
      // Now the real layout at t, in that order, with each label growing in as its star ignites.
      for (const c of col) c.box.x = colX(side, c, cam);
      stack(col, (c) => fanY(c, c.star.x, c.star.y, cam), (c) => c.weight);
    }
    return items;
  }

  private calloutTexts(t: number, items: Callout[], hu: number, exitU: number): TextDraw[] {
    const out: TextDraw[] = [];
    const reduced = this.cfg.reducedMotion;
    const u = uiScale(this.cfg.w, this.cfg.h);
    let fade = 1;
    if (hu >= 0) fade *= 1 - smoothstep(0, 450, hu);
    if (exitU >= 0) fade *= 1 - smoothstep(0, 300, exitU);
    for (const c of items) {
      const ig = c.a.igniteAt!;
      const alpha = c.weight * fade * (0.45 + 0.55 * smoothstep(-0.2, 0.25, c.star.z));
      if (alpha <= 0.002) continue;
      const right = c.side > 0;
      const { x, y, w } = c.box;
      const nameY = y + c.nameSize * 0.86;
      const inner = right ? x : x + w;
      // Leader: from the star's rim to an elbow, then a short tail level with the name.
      const midY = y + c.nameSize * 0.52;
      const elbowX = inner - c.side * 18 * u;
      const dx = elbowX - c.star.x;
      const dy = midY - c.star.y;
      const dl = Math.hypot(dx, dy) || 1;
      const r0 = 13 * u;
      const pts: Array<[number, number]> = [
        [c.star.x + (dx / dl) * r0, c.star.y + (dy / dl) * r0],
        [elbowX, midY],
        [inner - c.side * 5 * u, midY],
      ];
      const leaderP = reduced ? 1 : easeOutCubic(span(t, ig + 60, 460));
      const reveal = reduced ? 1 : easeOutCubic(span(t, ig + 380, 520));
      const subReveal = reduced ? 1 : easeOutCubic(span(t, ig + 640, 420));
      out.push({
        id: "n:" + c.id,
        text: c.entry.name,
        style: "label",
        font: c.nameFont,
        tracking: 0,
        x: right ? x + c.glyphW : x + w - c.glyphW,
        y: nameY,
        align: right ? "left" : "right",
        color: C.star,
        alpha,
        reveal,
        glyph: c.entry.family,
        glyphSide: right ? "left" : "right",
        leader: { pts, progress: leaderP, alpha: alpha * 0.6 },
      });
      if (c.sub) {
        out.push({
          id: "s:" + c.id,
          text: c.sub.text.toUpperCase(),
          style: c.sub.error ? "error" : "sublabel",
          font: c.subFont,
          tracking: c.subTracking,
          x: right ? x + c.glyphW : x + w - c.glyphW,
          y: y + c.nameSize * 1.12 + c.subSize * 1.2,
          align: right ? "left" : "right",
          color: c.sub.error ? C.vermilion : C.dust,
          alpha: alpha * subReveal,
          reveal: 1,
        });
      }
    }
    return out;
  }

  private labelSpecs(tk: number): { specs: LabelSpec[]; obstacles: Obstacle[] } {
    const s = this.schedule();
    const { w, h, reducedMotion: reduced } = this.cfg;
    const u = uiScale(w, h);
    const cam = cameraAt({ w, h, t: tk, consentAt: s.consentAt, handoffAt: s.handoffAt, reduced });
    const spin = this.spinAt(tk);
    const specs: LabelSpec[] = [];
    const obstacles: Obstacle[] = [];
    const ti = introTime(s, tk);
    const inHandoff = s.handoffAt !== undefined && tk >= s.handoffAt;
    const exiting = s.exitAt !== undefined && tk >= s.exitAt;

    // Ring numerals (fixed on their band; the solver keeps only those that are clear).
    if (!inHandoff && !exiting) {
      const inst = evaluateInstrument(ti, spin, reduced);
      for (const r of inst.rings) for (const n of numeralPlacements(r, cam, u, inst.rings)) specs.push(n);
    }
    // Callout boxes, their leaders and every found star are obstacles for everything else, so a
    // constellation name never sits on a leader (names give way; leaders keep their straight path).
    for (const c of this.callouts(tk, cam, spin)) {
      if (c.weight > 0.05) {
        obstacles.push({ kind: "rect", x: c.box.x - 4, y: c.box.y - 2, w: c.box.w + 8, h: c.box.h * c.weight + 4 });
        const ex = c.side > 0 ? c.box.x - 18 * u : c.box.x + c.w + 18 * u;
        const ey = c.box.y + c.nameSize * 0.52;
        const len = Math.hypot(ex - c.star.x, ey - c.star.y);
        for (let d = 14 * u; d < len; d += 9 * u) {
          const k = d / len;
          obstacles.push({ kind: "circle", cx: c.star.x + (ex - c.star.x) * k, cy: c.star.y + (ey - c.star.y) * k, r: 3 * u });
        }
      }
      obstacles.push({ kind: "circle", cx: c.star.x, cy: c.star.y, r: 12 * u });
    }
    // Constellation names along an edge of their own figure.
    if (!inHandoff && !exiting) {
      const cSize = 13 * u;
      const cFont = `600 ${cSize.toFixed(2)}px ${FONT.display}`;
      const cTracking = 0.28 * cSize;
      for (const c of s.constellations) {
        if (tk < c.nameAt - LABEL_KEY || !c.edges.length) continue;
        const text = c.name.toUpperCase();
        const tw = this.cfg.measure(cFont, text, cTracking);
        const geo = (key: string, at: number) => this.edgeLabelGeometry(c, key, at, tw, cSize);
        const extra: Array<{ x: number; y: number; key: string; leader: boolean }> = [];
        const keys = this.edgeKeys(c, tk);
        for (const key of keys) {
          const g = geo(key, tk);
          if (g) extra.push({ x: g.box.x, y: g.box.y, key, leader: false });
        }
        if (!extra.length) continue;
        const first = geo(keys[0], tk)!;
        const nameAt = c.nameAt;
        specs.push({
          req: { id: "c:" + c.root, anchor: { x: first.cx, y: first.cy }, w: first.box.w, h: first.box.h, priority: PRIORITY.constellation, anchorRadius: 0.5, mode: "centered", onlyExtra: true, allowLeader: false, extra },
          draw: () => [],
          slotBox: (key) => geo(key.replace(/^x:/, ""), tk)?.box ?? null,
          drawKey: (key, alpha) => {
            const g = geo(key.replace(/^x:/, ""), this.lastT);
            if (!g) return [];
            return [
              {
                id: "c:" + c.root,
                text,
                style: "constellation",
                font: cFont,
                tracking: cTracking,
                x: g.cx,
                y: g.cy,
                align: "center",
                color: C.giltSoft,
                alpha,
                reveal: reduced ? 1 : easeOutCubic(span(this.lastT, nameAt, CONST.nameDur)),
                transform: [Math.cos(g.angle), Math.sin(g.angle), -Math.sin(g.angle), Math.cos(g.angle)],
              },
            ];
          },
        });
      }
    }
    // Title (while it shows) and the cartouche are fixed chrome.
    this.titleTexts(ti, tk, s, u, [], obstacles, inHandoff ? 0 : -1);
    const cart = this.cartoucheAt(tk, s, u, inHandoff ? 0 : -1);
    if (cart.alpha > 0) {
      const cw = 300 * u;
      const ch = 92 * u;
      obstacles.push({ kind: "rect", x: cart.x - cw / 2, y: cart.y - ch / 2, w: cw, h: ch });
    }
    return { specs, obstacles };
  }

  /**
   * Candidate slots for a constellation's name: along its shallow edges (three positions, two
   * offsets, both sides), then level slots around the figure's centroid as a fallback.
   */
  private edgeKeys(c: ConstellationSched, t: number): string[] {
    const lens = c.edges.map(([a, b], i) => {
      const pa = this.screenOf(a, t);
      const pb = this.screenOf(b, t);
      if (!pa || !pb) return { i, len: 0, steep: true };
      const ang = Math.abs(Math.atan2(pb.y - pa.y, pb.x - pa.x));
      const tilt = Math.min(ang, Math.PI - ang);
      return { i, len: Math.hypot(pb.x - pa.x, pb.y - pa.y), steep: tilt > (38 * Math.PI) / 180 };
    });
    lens.sort((p, q) => q.len - p.len || p.i - q.i);
    const keys: string[] = [];
    for (const { i, steep } of lens) {
      if (steep) continue;
      for (const o of ["1", "2"]) for (const f of ["50", "30", "70"]) keys.push(`e:${i}:${f}:+:${o}`, `e:${i}:${f}:-:${o}`);
    }
    for (const dy of [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5]) for (const dx of [0, -1, 1, -2, 2]) keys.push(`h:${dx}:${dy}`);
    return keys;
  }

  /** Where a constellation name sits for slot `key` at time t. */
  private edgeLabelGeometry(c: ConstellationSched, key: string, t: number, tw: number, size: number): { cx: number; cy: number; angle: number; box: Rect } | null {
    const parts = key.split(":");
    const hw = tw / 2 + 3;
    const hh = size * 0.62;
    if (parts[0] === "h") {
      // Level, around the centroid of the figure.
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (const m of c.members) {
        const p = this.screenOf(m, t);
        if (!p) continue;
        sx += p.x;
        sy += p.y;
        n++;
      }
      if (!n) return null;
      const cx = sx / n + Number(parts[1]) * (hw + 12);
      const cy = sy / n + Number(parts[2]) * size * 1.9;
      return { cx, cy, angle: 0, box: { x: cx - hw, y: cy - hh, w: 2 * hw, h: 2 * hh } };
    }
    const [, is, fs, side, os] = parts;
    const e = c.edges[Number(is)];
    if (!e) return null;
    const f = Number(fs) / 100;
    const pa = this.screenOf(e[0], t);
    const pb = this.screenOf(e[1], t);
    if (!pa || !pb) return null;
    let angle = Math.atan2(pb.y - pa.y, pb.x - pa.x);
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle < -Math.PI / 2) angle += Math.PI;
    const nx = -Math.sin(angle);
    const ny = Math.cos(angle);
    const off = (side === "+" ? 1 : -1) * size * (os === "2" ? 1.9 : 1.05);
    const cx = pa.x + (pb.x - pa.x) * f + nx * off;
    const cy = pa.y + (pb.y - pa.y) * f + ny * off;
    const ca = Math.abs(Math.cos(angle));
    const sa = Math.abs(Math.sin(angle));
    const bw = 2 * (hw * ca + hh * sa);
    const bh = 2 * (hw * sa + hh * ca);
    return { cx, cy, angle, box: { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh } };
  }

  private screenOf(id: string, t: number): { x: number; y: number } | null {
    const pl = this.placement.get(id);
    if (!pl) return null;
    const s = this.schedule();
    const { w, h, reducedMotion: reduced } = this.cfg;
    const cam = cameraAt({ w, h, t, consentAt: s.consentAt, handoffAt: s.handoffAt, reduced });
    const p = project(cam, starAt(pl, this.spinAt(t)));
    return { x: p.x, y: p.y };
  }

  /** The t of the evaluate call in progress (label draw closures read it for reveal timing). */
  private lastT = 0;

  private solveKey(k: number): LabelSolve {
    const hit = this.labelCache.get(k);
    if (hit) return hit;
    const s = this.schedule();
    const same = (i: number) => i > 0 && segmentIndex(s, i * LABEL_KEY) === segmentIndex(s, (i - 1) * LABEL_KEY);
    // Hints come only from the previous keyframe of the same segment, so the result never depends
    // on what happens to be cached. Walk back to the segment start (or a cached keyframe), then forward.
    let j = k;
    while (same(j) && !this.labelCache.has(j - 1)) j--;
    for (let i = j; i <= k; i++) {
      if (this.labelCache.has(i)) continue;
      this.labelCache.set(i, this.solveFresh(i, same(i) ? this.labelCache.get(i - 1) : undefined));
    }
    if (this.labelCache.size > 900) {
      const keys = [...this.labelCache.keys()].sort((a, b) => a - b);
      for (let i = 0; i < keys.length - 600; i++) if (keys[i] < k - 2) this.labelCache.delete(keys[i]);
    }
    return this.labelCache.get(k)!;
  }

  private solveFresh(k: number, prev: LabelSolve | undefined): LabelSolve {
    const tk = k * LABEL_KEY;
    const { w, h } = this.cfg;
    const { specs, obstacles } = this.labelSpecs(tk);
    const bounds: Rect = { x: 0, y: 0, w, h };
    const placed = new Map<string, PlacedLabel>();
    const anchors = new Map<string, { x: number; y: number }>();
    // Names already engraved keep their slot as the sky turns (they move with their figure and are
    // never re-placed); they are reserved first, as obstacles for everything else.
    const obs = obstacles.slice();
    const fresh: LabelSpec[] = [];
    for (const sp of specs) {
      const was = prev?.placed.get(sp.req.id);
      const slot = was && sp.slotBox ? sp.slotBox(was.candidate) : null;
      if (was && slot) {
        placed.set(sp.req.id, { id: sp.req.id, x: slot.x, y: slot.y, w: slot.w, h: slot.h, candidate: was.candidate, leader: null, priority: sp.req.priority });
        anchors.set(sp.req.id, sp.req.anchor);
        obs.push({ kind: "rect", ...slot });
      } else fresh.push(sp);
    }
    const reqs = fresh.map((sp) => ({ ...sp.req, hint: prev?.placed.get(sp.req.id)?.candidate }));
    const main = solveLabels(reqs, obs, bounds);
    for (const p of main.placed) placed.set(p.id, p);
    for (const sp of fresh) anchors.set(sp.req.id, sp.req.anchor);
    return { placed, anchors };
  }

  private labelTexts(t: number, out: TextDraw[], cam: Camera, spin: number, hu: number, exitU: number): void {
    this.lastT = t;
    out.push(...this.calloutTexts(t, this.callouts(t, cam, spin), hu, exitU));
    const k = Math.floor(t / LABEL_KEY);
    const s0 = easeInOutCubic((t - k * LABEL_KEY) / LABEL_KEY);
    const A = k > 0 ? this.solveKey(k - 1) : undefined;
    const B = this.solveKey(k);
    const { specs } = this.labelSpecs(t);
    for (const sp of specs) {
      const id = sp.req.id;
      const pa = A?.placed.get(id);
      const pb = B.placed.get(id);
      if (!pa && !pb) continue;
      if (sp.drawKey) {
        // Keyed placements (names along an edge): redraw the chosen slot at t; cross-fade a change.
        if (pa && pb && pa.candidate === pb.candidate) out.push(...sp.drawKey(pb.candidate, 1));
        else {
          if (pa) out.push(...sp.drawKey(pa.candidate, 1 - s0));
          if (pb) out.push(...sp.drawKey(pb.candidate, s0));
        }
        continue;
      }
      const anchor = sp.req.anchor;
      const off = (p: PlacedLabel, sol: LabelSolve) => {
        const an = sol.anchors.get(id) ?? anchor;
        return { x: p.x - an.x, y: p.y - an.y };
      };
      const oa = pa && A ? off(pa, A) : undefined;
      const ob = pb ? off(pb, B) : undefined;
      const o = oa && ob ? { x: mix(oa.x, ob.x, s0), y: mix(oa.y, ob.y, s0) } : (ob ?? oa)!;
      const alpha = mix(pa ? 1 : 0, pb ? 1 : 0, s0);
      if (alpha <= 0.001) continue;
      out.push(...sp.draw(anchor.x + o.x, anchor.y + o.y, alpha));
    }
  }

  private sunTexts(hu: number, target: HandoffTarget, suns: SunDraw[], out: TextDraw[], u: number, reduced: boolean): void {
    // The project name engraved on the Orrery's own plate position (600 13px Cormorant, tracked 1.6).
    for (const sd of suns) {
      const sun = target.suns.find((x) => x.id === sd.id);
      if (!sun) continue;
      const i = target.suns.indexOf(sun);
      const st = 1450 + i * 90;
      const reveal = reduced ? 1 : easeOutCubic(span(hu, st, 620));
      if (reveal <= 0) continue;
      const cy = sun.nameY ?? sun.y - sun.r - 22;
      out.push({
        id: "sun:" + sun.id,
        text: sun.name.toUpperCase(),
        style: "sun",
        font: `600 13px ${FONT.display}`,
        tracking: 1.6,
        x: sun.x,
        y: cy + 4.5,
        align: "center",
        color: C.gilt,
        alpha: sd.alpha,
        reveal,
      });
    }
    void u;
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers

function subLabel(a: Schedule["agents"] extends Map<string, infer V> ? V : never, t: number): { text: string; error: boolean } | null {
  if (a.errorAt !== undefined && t >= a.errorAt && a.error) {
    const reason = a.error.length > 52 ? a.error.slice(0, 51).trimEnd() + "…" : a.error;
    return { text: reason, error: true };
  }
  if (!a.history) return { text: "detected", error: false };
  if (a.finishedAt !== undefined && t >= a.finishedAt) return { text: a.imported === 1 ? "1 session" : `${a.imported} sessions`, error: false };
  if (a.importStartAt !== undefined && t >= a.importStartAt) return { text: "gathering history", error: false };
  return null;
}

/** Placement filter: keep catalogue stars off the front ring bands, the polar axis and the globe. */
function blockedForPlacement(vp: V3): boolean {
  const x = vp[0] * STAR_RADIUS;
  const y = vp[1] * STAR_RADIUS;
  if (Math.hypot(x, y) < 0.14) return true;
  // Polar axis in view space.
  const ax = mulMV(PLACEMENT_VIEW, AXIS_DIR);
  const al = Math.hypot(ax[0], ax[1]) || 1;
  const distAxis = Math.abs(x * (ax[1] / al) - y * (ax[0] / al));
  if (distAxis < 0.05) return true;
  for (const spec of RINGS) {
    const pose = restPose(spec.id, 0);
    const r = { ...pose, spec };
    const half = (spec.profile === "strip" ? spec.width : spec.width) / 2 + 0.045;
    for (let i = 0; i < 96; i++) {
      const th = (i / 96) * Math.PI * 2;
      const p = mulMV(PLACEMENT_VIEW, ringPoint(r, th));
      if (p[2] < -0.05) continue;
      if (Math.hypot(p[0] - x, p[1] - y) < half) return true;
    }
  }
  return false;
}

/** Numerals etched on a ring band, as fixed-position labels with an affine along the band. */
function numeralPlacements(r: RingState, cam: Camera, u: number, rings: RingState[]): LabelSpec[] {
  const spec = r.spec;
  if (!spec.numerals || r.numerals <= 0 || r.alpha <= 0.05) return [];
  const out: LabelSpec[] = [];
  const bandPx = spec.width * cam.scale;
  const size = clamp(bandPx * 0.5, 7.5 * u, 15 * u);
  const font = `700 ${size.toFixed(2)}px ${FONT.display}`;
  for (const n of ringNumerals(spec)) {
    // Inside the drawn arc and behind the etch front.
    const rel = (((n.theta - r.drawFrom) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (rel > r.draw * 2 * Math.PI) continue;
    const etchA = clamp((r.etch * 2 * Math.PI - rel) / 0.6);
    if (etchA <= 0) continue;
    const R = ringRadial(r, n.theta);
    const Tn = ringTangent(r, n.theta);
    // The graduated face and its across-band direction.
    let faceN: V3;
    let across: V3;
    let P: V3;
    if (spec.profile === "washer") {
      const toCam = mulMV(cam.view, r.N)[2] >= 0 ? 1 : -1;
      faceN = vscale(r.N, toCam);
      across = R;
      P = add(ringPoint(r, n.theta), vscale(faceN, spec.thickness / 2));
    } else {
      faceN = R;
      across = r.N;
      P = ringPoint(r, n.theta, spec.thickness / 2);
    }
    const nz = mulMV(cam.view, faceN)[2];
    if (nz < 0.4) continue;
    const pv = mulMV(cam.view, P);
    if (pv[2] < -0.05 && spec.profile !== "washer") continue;
    const p0 = project(cam, P);
    const eps = 0.01;
    const pT = project(cam, add(P, vscale(Tn, eps)));
    const pU = project(cam, add(P, vscale(across, eps)));
    const nominal = cam.scale * p0.p * eps;
    let ax = (pT.x - p0.x) / nominal;
    let ay = (pT.y - p0.y) / nominal;
    let bx = -(pU.x - p0.x) / nominal; // text "down" points inward (against `across`)
    let by = -(pU.y - p0.y) / nominal;
    let det = ax * by - ay * bx;
    if (det < 0) {
      // Mirrored: read the other way round.
      ax = -ax;
      ay = -ay;
      det = -det;
    }
    if (by < 0 && Math.abs(by) > Math.abs(bx) * 0.3) {
      // Upside down on screen: turn the numeral half a turn.
      ax = -ax;
      ay = -ay;
      bx = -bx;
      by = -by;
    }
    if (det < 0.42) continue;
    // Hidden under a nearer front band of another ring?
    let covered = false;
    for (const o of rings) {
      if (o === r || o.alpha < 0.3) continue;
      const half = (o.spec.width / 2) * cam.scale + 4 * u;
      for (let i = 0; i < 72 && !covered; i++) {
        const th = (i / 72) * Math.PI * 2;
        const q = ringPoint(o, th);
        const qv = mulMV(cam.view, q);
        if (qv[2] <= pv[2]) continue;
        const qs = project(cam, q);
        if (Math.hypot(qs.x - p0.x, qs.y - p0.y) < half) covered = true;
      }
      if (covered) break;
    }
    if (covered) continue;
    const id = `num:${spec.id}:${n.text}:${n.theta.toFixed(3)}`;
    const wPx = size * (0.62 * n.text.length + 0.2);
    const hPx = size * 0.9;
    // Axis-aligned box of the transformed text, for the solver.
    const corners = [
      [-wPx / 2, -hPx / 2],
      [wPx / 2, -hPx / 2],
      [-wPx / 2, hPx / 2],
      [wPx / 2, hPx / 2],
    ].map(([cx, cy]) => [ax * cx + bx * cy, ay * cx + by * cy]);
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const bw = Math.max(...xs) - Math.min(...xs);
    const bh = Math.max(...ys) - Math.min(...ys);
    const alpha = r.numerals * etchA * r.alpha;
    const text = n.text;
    const tf: [number, number, number, number] = [ax, ay, bx, by];
    out.push({
      req: { id, anchor: { x: p0.x, y: p0.y }, w: bw, h: bh, priority: PRIORITY.numeral, anchorRadius: 0, mode: "fixed" },
      draw: (x, y, a) => [
        { id, text, style: "numeral", font, tracking: 0, x: x + bw / 2, y: y + bh / 2, align: "center", color: C.engraveInk, alpha: a * alpha, reveal: 1, transform: tf },
      ],
    });
  }
  return out;
}

/** When the app could not be measured: suns on a gentle arc across the window, no planets. */
function fallbackTarget(w: number, h: number, s: Schedule): HandoffTarget {
  const cons = s.constellations.length ? s.constellations : [];
  const n = Math.max(1, cons.length);
  const suns = cons.map((c, i) => {
    const f = n === 1 ? 0.5 : 0.22 + (0.56 * i) / (n - 1);
    return { id: "fallback-" + i, name: c.name, root: c.root, x: w * f, y: h * (0.5 + 0.1 * Math.sin(f * Math.PI * 2)), r: 24 };
  });
  return { stage: { x: 0, y: 0, w, h }, theme: "dark", suns, planets: [], frame: { outerInset: 10, innerInset: 24, minorTickDeg: 2, midTickDeg: 10, majorTickDeg: 30 } };
}

export function textStyleIsEngraved(s: TextStyle): boolean {
  return s === "title" || s === "label" || s === "constellation" || s === "sun";
}

