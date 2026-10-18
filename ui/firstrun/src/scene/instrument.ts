/**
 * The armillary sphere: ring definitions in instrument space and the assembly choreography.
 *
 * Instrument space: y is the zenith, the horizon ring lies in the xz plane, the meridian ring in the
 * xy plane (it contains the polar axis). The polar axis is tilted from the zenith toward +x by
 * POLE_TILT. The equatorial rings (equator, ecliptic, colures) turn with the sky about the axis.
 */
import { clamp, easeBurin, easeHeavy, easeOutCubic, easeOutBack, mix, span, spring, smoothstep } from "../math/ease";
import { cross, normalize, rotateAbout, type V3 } from "../math/vec";

export const POLE_TILT = (23.5 * Math.PI) / 180;
export const OBLIQUITY = (23.44 * Math.PI) / 180;

/** Star sphere radius (agents sit on it), inside the rings. */
export const STAR_RADIUS = 0.9;

export type RingId = "meridian" | "horizon" | "equator" | "ecliptic" | "colureEq" | "colureSol";
/** washer: a flat annulus (graduated face lies in the ring plane). strip: a cylindrical band (face points outward). */
export type RingProfile = "washer" | "strip";
export type NumeralSet = "latitude" | "hours" | "compass" | null;

export interface RingSpec {
  id: RingId;
  profile: RingProfile;
  /** Centre-line radius in sphere radii. */
  radius: number;
  /** Width of the graduated face. */
  width: number;
  /** Thickness across the face. */
  thickness: number;
  /** Rotates with the sky about the polar axis. */
  equatorial: boolean;
  numerals: NumeralSet;
  /** Graduation: degrees between minor ticks, and every how many minors a major tick falls. */
  minorDeg: number;
  majorEvery: number;
}

export const RINGS: readonly RingSpec[] = [
  { id: "horizon", profile: "washer", radius: 1.17, width: 0.115, thickness: 0.022, equatorial: false, numerals: "compass", minorDeg: 2, majorEvery: 5 },
  { id: "meridian", profile: "washer", radius: 1.075, width: 0.075, thickness: 0.026, equatorial: false, numerals: "latitude", minorDeg: 2, majorEvery: 5 },
  { id: "equator", profile: "strip", radius: 1.0, width: 0.06, thickness: 0.018, equatorial: true, numerals: "hours", minorDeg: 3.75, majorEvery: 4 },
  { id: "ecliptic", profile: "strip", radius: 0.985, width: 0.105, thickness: 0.016, equatorial: true, numerals: null, minorDeg: 2, majorEvery: 15 },
  { id: "colureEq", profile: "strip", radius: 0.965, width: 0.028, thickness: 0.012, equatorial: true, numerals: null, minorDeg: 10, majorEvery: 3 },
  { id: "colureSol", profile: "strip", radius: 0.965, width: 0.028, thickness: 0.012, equatorial: true, numerals: null, minorDeg: 10, majorEvery: 3 },
];

export const AXIS_DIR: V3 = [Math.sin(POLE_TILT), Math.cos(POLE_TILT), 0];
/** Equatorial basis at spin 0: E1 lies in the meridian plane, E2 points toward the viewer side (+z). */
export const EQ_E1: V3 = [Math.cos(POLE_TILT), -Math.sin(POLE_TILT), 0];
export const EQ_E2: V3 = [0, 0, 1];

/** A ring's placement this frame: the circle is c(theta) = radius * (cos(theta) U + sin(theta) V), normal N = U x V. */
export interface RingPose {
  U: V3;
  V: V3;
  N: V3;
  /** Extra offset of the ring centre (used by the settling horizon). */
  offset: V3;
  /** Uniform scale of the radius (settling). */
  grow: number;
}

export interface RingState extends RingPose {
  spec: RingSpec;
  /** Drawn arc: theta in [drawFrom, drawFrom + 2 pi * draw]. */
  drawFrom: number;
  draw: number;
  /** Ticks and grooves revealed along the arc, 0..1 (follows the draw). */
  etch: number;
  /** 0..1 numeral engraving. */
  numerals: number;
  alpha: number;
  /** The burin's bright tip while the ring draws, 0..1. */
  tip: number;
}

export interface AxisState {
  /** 0..1 extension of the rod from the centre outward. */
  extent: number;
  finials: number;
  alpha: number;
  /** Rod half-length in sphere radii. */
  length: number;
}

export interface InstrumentState {
  rings: RingState[];
  axis: AxisState;
  globe: number;
  /** 0..1 the whole instrument has assembled (used to gate later effects). */
  assembled: number;
}

/** Times (ms, on the intro clock) of the assembly. Shared with the title and the frame rule. */
export const T = {
  skyFar: [0, 1700],
  skyMid: [350, 1700],
  skyNear: [750, 1650],
  ruleDraw: [250, 2000],
  ruleKeys: [1050, 1500],
  ruleNumerals: [1900, 700],
  equator: [2500, 950],
  meridian: [2950, 1350],
  ecliptic: [3550, 1250],
  horizon: [4050, 1350],
  axis: [4550, 900],
  colures: [4950, 900],
  globe: [5150, 700],
  title: [5450, 125, 420],
  subtitle: [6750, 700],
  plaque: [7300, 1150],
} as const;

/** The intro (night falls, assembly, title, plaque lowered) is complete at this intro-clock time. */
export const INTRO_END = T.plaque[0] + T.plaque[1];
/** The plaque accepts input once it has mostly settled. */
export const PLAQUE_INTERACTIVE = T.plaque[0] + 750;

function equatorialBasis(spin: number): { A: V3; E1: V3; E2: V3 } {
  return { A: AXIS_DIR, E1: rotateAbout(EQ_E1, AXIS_DIR, spin), E2: rotateAbout(EQ_E2, AXIS_DIR, spin) };
}

/** The resting pose of each ring for a given sky spin. */
export function restPose(id: RingId, spin: number): RingPose {
  const { A, E1, E2 } = equatorialBasis(spin);
  const z: V3 = [0, 0, 0];
  switch (id) {
    case "meridian":
      return { U: [1, 0, 0], V: [0, 1, 0], N: [0, 0, 1], offset: z, grow: 1 };
    case "horizon":
      return { U: [1, 0, 0], V: [0, 0, -1], N: [0, 1, 0], offset: z, grow: 1 };
    case "equator":
      return { U: E1, V: E2, N: A, offset: z, grow: 1 };
    case "ecliptic": {
      const V = normalize(rotateAbout(E2, E1, OBLIQUITY));
      return { U: E1, V, N: normalize(cross(E1, V)), offset: z, grow: 1 };
    }
    case "colureEq":
      return { U: E1, V: A, N: normalize(cross(E1, A)), offset: z, grow: 1 };
    case "colureSol":
      return { U: E2, V: A, N: normalize(cross(E2, A)), offset: z, grow: 1 };
  }
}

function poseFromUV(U: V3, V: V3, offset: V3 = [0, 0, 0], grow = 1): RingPose {
  return { U, V, N: normalize(cross(U, V)), offset, grow };
}

/**
 * Evaluate the instrument at intro time `ti` (ms) with sky spin `spin` (rad).
 * `reduced` replaces every movement with a short cross-fade at the same moments.
 */
export function evaluateInstrument(ti: number, spin: number, reduced: boolean): InstrumentState {
  const rings: RingState[] = [];
  for (const spec of RINGS) {
    const rest = restPose(spec.id, spin);
    let pose: RingPose = rest;
    let draw = 1;
    let drawFrom = 0;
    let alpha = 1;
    let tip = 0;
    let start = 0;
    let dur = 0;
    switch (spec.id) {
      case "equator": {
        [start, dur] = T.equator;
        const p = span(ti, start, dur);
        draw = easeBurin(p);
        drawFrom = Math.PI * 0.62;
        alpha = smoothstep(0, 0.08, p);
        tip = p > 0 && p < 1 ? 1 : 0;
        break;
      }
      case "meridian": {
        [start, dur] = T.meridian;
        const p = span(ti, start, dur);
        // Swings in about the zenith (its own vertical diameter) from edge-on, with a damped overshoot.
        const s = spring(p * 1.25, 1.15, 0.38);
        const ang = (1 - s) * (Math.PI * 0.5);
        const U = rotateAbout(rest.U, [0, 1, 0], ang);
        pose = poseFromUV(U, rest.V);
        alpha = smoothstep(0, 0.18, p);
        break;
      }
      case "ecliptic": {
        [start, dur] = T.ecliptic;
        const p = span(ti, start, dur);
        // Lifts off the equator and tilts to the obliquity, overshooting slightly.
        const eq = restPose("equator", spin);
        const s = clamp(easeOutBack(easeHeavy(p), 1.15), 0, 1.2);
        const ang = OBLIQUITY * s;
        const V = normalize(rotateAbout(eq.V, eq.U, ang));
        pose = poseFromUV(eq.U, V);
        alpha = smoothstep(0, 0.12, p);
        break;
      }
      case "horizon": {
        [start, dur] = T.horizon;
        const p = span(ti, start, dur);
        // Descends from above and settles with a small bounce; grows from slightly larger.
        const s = spring(p * 1.3, 1.0, 0.5);
        pose = { ...rest, offset: [0, (1 - s) * 0.42, 0], grow: mix(1.06, 1, s) };
        alpha = smoothstep(0, 0.25, p);
        break;
      }
      case "colureEq":
      case "colureSol": {
        [start, dur] = T.colures;
        const lag = spec.id === "colureSol" ? 160 : 0;
        const p = span(ti, start + lag, dur);
        draw = easeBurin(p);
        drawFrom = Math.PI * 0.5;
        alpha = smoothstep(0, 0.1, p) * 0.9;
        tip = p > 0 && p < 1 ? 1 : 0;
        break;
      }
    }
    // Ticks etch along the arc shortly after the band is in place; numerals follow the etch.
    const settled = start + dur * (spec.id === "equator" || spec.id.startsWith("colure") ? 0.6 : 0.75);
    const etch = easeOutCubic(span(ti, settled, 900));
    const numerals = span(ti, settled + 500, 700);
    if (reduced) {
      pose = rest;
      draw = 1;
      tip = 0;
      alpha = smoothstep(start, start + 450, ti);
    }
    rings.push({
      spec,
      ...pose,
      drawFrom,
      draw,
      etch: reduced ? alpha : etch,
      numerals: reduced ? alpha : numerals,
      alpha: alpha * (spec.id.startsWith("colure") ? 0.9 : 1),
      tip,
    });
  }
  const pa = span(ti, T.axis[0], T.axis[1]);
  const axis: AxisState = {
    extent: reduced ? 1 : easeOutCubic(pa),
    finials: reduced ? smoothstep(T.axis[0], T.axis[0] + 450, ti) : easeOutBack(span(ti, T.axis[0] + T.axis[1] * 0.55, 500), 2.2),
    alpha: reduced ? smoothstep(T.axis[0], T.axis[0] + 450, ti) : smoothstep(0, 0.15, pa),
    length: 1.32,
  };
  const globe = reduced ? smoothstep(T.globe[0], T.globe[0] + 450, ti) : easeOutBack(span(ti, T.globe[0], T.globe[1]), 1.8);
  const assembled = span(ti, T.equator[0], T.globe[0] + T.globe[1] - T.equator[0]);
  return { rings, axis, globe, assembled };
}

/** Point on a ring's centre line, instrument space. */
export function ringPoint(r: RingPose & { spec: RingSpec }, theta: number, radialOffset = 0, axialOffset = 0): V3 {
  const rad = r.spec.radius * r.grow + radialOffset;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [
    r.offset[0] + rad * (c * r.U[0] + s * r.V[0]) + axialOffset * r.N[0],
    r.offset[1] + rad * (c * r.U[1] + s * r.V[1]) + axialOffset * r.N[1],
    r.offset[2] + rad * (c * r.U[2] + s * r.V[2]) + axialOffset * r.N[2],
  ];
}

/** Outward radial unit vector at theta. */
export function ringRadial(r: RingPose, theta: number): V3 {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [c * r.U[0] + s * r.V[0], c * r.U[1] + s * r.V[1], c * r.U[2] + s * r.V[2]];
}

/** Unit tangent (direction of increasing theta). */
export function ringTangent(r: RingPose, theta: number): V3 {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [-s * r.U[0] + c * r.V[0], -s * r.U[1] + c * r.V[1], -s * r.U[2] + c * r.V[2]];
}

/** Numeral angles and strings for a ring (theta measured in the ring's own U/V frame). */
export function ringNumerals(spec: RingSpec): Array<{ theta: number; text: string }> {
  const out: Array<{ theta: number; text: string }> = [];
  if (spec.numerals === "hours") {
    const roman = ["XII", "II", "IV", "VI", "VIII", "X", "XII", "II", "IV", "VI", "VIII", "X"];
    for (let i = 0; i < 12; i++) out.push({ theta: (i * Math.PI) / 6 + Math.PI / 12, text: roman[i] });
  } else if (spec.numerals === "latitude") {
    // Graduated in latitude from the equator: 0 on the equator, 90 at the poles (the poles carry
    // the axis, so they get no numeral). The north pole sits at (90 deg - tilt) in the U/V frame.
    const thetaPole = Math.PI / 2 - POLE_TILT;
    for (let k = 1; k < 12; k++) {
      if (k === 6) continue;
      const lat = Math.abs(90 - ((k * 30) % 180));
      out.push({ theta: thetaPole - (k * 30 * Math.PI) / 180, text: String(lat) });
    }
  } else if (spec.numerals === "compass") {
    const pts = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];
    for (let i = 0; i < 8; i++) out.push({ theta: (i * Math.PI) / 4, text: pts[i] });
  }
  return out;
}
