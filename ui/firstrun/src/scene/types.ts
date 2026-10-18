import type { CoreEvent, FamilyKey, FirstRunPlan } from "../events";
import type { Camera, V3 } from "../math/vec";
import type { AxisState, RingState } from "./instrument";

/**
 * Everything the scene reacts to, stamped with the scene clock (ms since the first run began).
 * The scene is a pure function of (inputs, t): appending an input at time `at` never changes the
 * frame at any t < at.
 */
export type SceneInput =
  | { kind: "plan"; at: number; plan: FirstRunPlan }
  | { kind: "consent"; at: number }
  | { kind: "decline"; at: number }
  /** Escape or the Skip button. Before consent it fast-forwards to the plaque; after, it exits. */
  | { kind: "skip"; at: number }
  | { kind: "core"; at: number; event: CoreEvent }
  | { kind: "coreError"; at: number; message: string }
  | { kind: "target"; at: number; target: HandoffTarget };

export interface HandoffSun {
  id: string;
  name: string;
  root: string;
  /** Window CSS px. */
  x: number;
  y: number;
  r: number;
  /** Centre of the Orrery's name plate above the sun (window px), from its own plaque geometry. */
  nameY?: number;
}

export interface HandoffPlanet {
  id: string;
  sunId: string;
  /** Window CSS px at the moment the first run hands over. */
  x: number;
  y: number;
  r: number;
  color: string;
  /** Orbit ellipse in window px (centre, semi-axes, tilt in radians). */
  orbit: { cx: number; cy: number; a: number; b: number; tilt: number };
  /** Angle on the orbit at hand-over. */
  angle: number;
  done: boolean;
  /** The session's agent family (glyph) and live state (idle planets are drawn dimmer), as the Orrery draws them. */
  family?: string;
  state?: string;
}

/** Where the live Orrery draws things, measured from the app underneath (window CSS px). */
export interface HandoffTarget {
  stage: { x: number; y: number; w: number; h: number };
  theme: "dark" | "light";
  suns: HandoffSun[];
  planets: HandoffPlanet[];
  /**
   * The Orrery frame inside the stage (DS's seam): an outer hairline at outerInset, an inner rule at
   * innerInset, and top and bottom degree scales between them (ticks every minorTickDeg, longer every
   * midTickDeg and majorTickDeg), so the rule and its keys land on it.
   */
  frame: { outerInset: number; innerInset: number; minorTickDeg: number; midTickDeg: number; majorTickDeg: number };
}

export type Phase = "intro" | "consent" | "scan" | "constellations" | "handoff" | "exit" | "complete";

export interface SceneConfig {
  /** Viewport, CSS px. */
  w: number;
  h: number;
  reducedMotion: boolean;
  /** Measures text width in CSS px for a CSS font string (and letter spacing in px). Injected so the scene stays pure. */
  measure: (font: string, text: string, tracking: number) => number;
}

export type RGB = [number, number, number];

export interface SkyState {
  /** Per-layer reveal (far, mid, near), 0..1. */
  layers: [number, number, number];
  /** Time in seconds for twinkle (the renderer's shader input). */
  time: number;
  /** Dolly zoom of the field around the screen centre (1 = none). */
  zoom: number;
  /** 0..1 cross to the parchment tone (light-theme hand-over). */
  parchment: number;
  /** 0..1 milky band and nebula visibility. */
  nebula: number;
}

/** The gilt rule around the window: hairlines, a band of alternating keys, numerals. */
export interface RuleState {
  rect: { x: number; y: number; w: number; h: number };
  /** Hairline path drawn, 0..1 (from the top centre both ways). */
  draw: number;
  /** Keys filled in sequence, 0..1. */
  keys: number;
  numerals: number;
  /** Band width between the two hairlines, CSS px. */
  band: number;
  alpha: number;
  /** The Orrery's degree scale fading in on the inner rule during the hand-over (null before). */
  scale: { alpha: number; minorTickDeg: number; midTickDeg: number; majorTickDeg: number } | null;
}

export interface BeamState {
  /** Pivot (below the sphere) and direction angle (radians from straight up, positive to the right). */
  x: number;
  y: number;
  angle: number;
  length: number;
  /** Half-angle of the cone, radians. */
  spread: number;
  alpha: number;
  /** Where the beam's spot rests (the star being found), or null. */
  spot: { x: number; y: number; r: number; alpha: number } | null;
}

export interface StarDraw {
  id: string;
  x: number;
  y: number;
  /** View-space depth; positive faces the viewer. */
  z: number;
  found: boolean;
  family: FamilyKey;
  color: RGB;
  /** Overall opacity. */
  alpha: number;
  /** Core radius, CSS px. */
  core: number;
  /** Extra brightness of the ignition flare, 0..1. */
  flare: number;
  /** Diffraction spike half-length, CSS px, and opacity. */
  spikes: number;
  spikeAlpha: number;
  /** Soft bloom radius, CSS px, and opacity. */
  bloom: number;
  bloomAlpha: number;
  /** Import arc: fraction filled 0..1 and its opacity (0 = no arc). */
  arc: number;
  arcAlpha: number;
  arcRadius: number;
  /** Completion pulse progress 0..1 (0 = none). */
  pulse: number;
  error: boolean;
}

export interface LinkDraw {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Drawn fraction from (x1, y1). */
  progress: number;
  alpha: number;
  /** Bright burin tip while drawing. */
  tip: number;
}

/** A project sun forming in the Orrery's engraved design (each part 0..1 as it etches in). */
export interface SunDraw {
  id: string;
  x: number;
  y: number;
  r: number;
  alpha: number;
  /** Ignition flash 0..1. */
  flash: number;
  /** Rays in splendour grown out. */
  rays: number;
  /** The graduated ring drawn round and its ticks cut. */
  ring: number;
  /** The medallion's engraved rings, hatching and boss. */
  face: number;
}

export interface OrbitDraw {
  cx: number;
  cy: number;
  a: number;
  b: number;
  tilt: number;
  draw: number;
  alpha: number;
  done: boolean;
}

export interface PlanetDraw {
  id: string;
  x: number;
  y: number;
  r: number;
  color: string;
  alpha: number;
  family?: string;
  state?: string;
  /** Its sun, for the shading toward the light. */
  sunX: number;
  sunY: number;
}

export type TextStyle = "title" | "subtitle" | "label" | "sublabel" | "error" | "constellation" | "numeral" | "rule" | "missing" | "counter" | "counterSmall" | "sun";

export interface TextDraw {
  id: string;
  text: string;
  style: TextStyle;
  font: string;
  /** Letter spacing in px. */
  tracking: number;
  /** Anchor point; meaning set by align (left/centre/right of the baseline). */
  x: number;
  y: number;
  align: "left" | "center" | "right";
  color: RGB;
  alpha: number;
  /** Engraving progress 0..1 (letters cut left to right with a bright burin point). */
  reveal: number;
  /** Optional affine (a, b, c, d) applied around (x, y): etched along a ring band, or along a line. */
  transform?: [number, number, number, number];
  /** A fine gilt leader drawn from the star to the label, `progress` 0..1 along its points. */
  leader?: { pts: Array<[number, number]>; progress: number; alpha: number };
  /** Optional engraved family glyph beside the text, on the side facing the star. */
  glyph?: FamilyKey;
  glyphSide?: "left" | "right";
}

export interface PlaqueState {
  /** Mounted at all. */
  visible: boolean;
  /** Vertical offset, CSS px (0 = rest; negative = above). */
  offsetY: number;
  /** Small pendulum swing, radians. */
  swing: number;
  alpha: number;
  interactive: boolean;
}

export interface CartoucheState {
  alpha: number;
  found: number;
  catalogue: number;
  sessions: number;
  /** 0..1 reveal of the sessions line. */
  sessionsAlpha: number;
  x: number;
  y: number;
}

export interface Frame {
  t: number;
  w: number;
  h: number;
  phase: Phase;
  reducedMotion: boolean;
  sky: SkyState;
  rule: RuleState;
  cam: Camera;
  /** Sky spin about the polar axis, radians. */
  spin: number;
  rings: RingState[];
  axis: AxisState;
  globe: number;
  /** Overall instrument opacity (fades during the hand-over). */
  instrumentAlpha: number;
  /** Direction (instrument space) of the travelling glint light. */
  glint: V3;
  beam: BeamState | null;
  stars: StarDraw[];
  links: LinkDraw[];
  suns: SunDraw[];
  orbits: OrbitDraw[];
  planets: PlanetDraw[];
  texts: TextDraw[];
  cartouche: CartoucheState;
  plaque: PlaqueState;
  /** Opacity of the first-run canvases (the final cross-fade lowers it). */
  canvasAlpha: number;
  /** Opacity the gate should give the app underneath. */
  appAlpha: number;
  /** Show the Skip control. */
  skipVisible: boolean;
}
