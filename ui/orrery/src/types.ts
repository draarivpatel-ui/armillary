export type AgentFamily =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'github'
  | 'cursor'
  | 'open-source'
  | 'chinese'
  | 'other';

export type LiveState = 'working' | 'waiting' | 'idle' | 'done';

export interface Project {
  id: string;
  name: string;
  root: string;
}

export interface Session {
  id: string;
  agent_id: string;
  family: AgentFamily;
  project_root: string;
  title: string;
  turns: number;
  activity: number; // 0.0 to 1.0
  state: LiveState;
  waiting_since?: number; // Unix ms
  parent_id?: string; // Subagent parent session ID
}

export interface OrrerySun {
  id: string;
  project: Project;
  x: number;
  y: number;
  radius: number;
}

export interface OrreryMoon {
  id: string;
  session: Session;
  parentPlanetId: string;
  orbitRadius: number;
  angle: number;
  startAngle?: number;
  x: number;
  y: number;
  radius: number;
}

export interface OrreryPlanet {
  id: string;
  session: Session;
  sunId: string;
  orbitSemiMajor: number;
  orbitSemiMinor: number;
  orbitTilt: number;
  angle: number;
  startAngle: number;
  targetAngle: number;
  transitionProgress: number; // 0 to 1
  currentX: number;
  currentY: number;
  radius: number;
  isFront: boolean;
  isDoneRing: boolean;
  haloProgress: number;
  bellGlint: boolean;
  /** Milliseconds this session has needed the user, derived from the clock (see animation.ts). */
  waitingElapsedMs: number;
  /** Controller time t (ms) at which the needs-you swing began. Same timebase as renderAt(t). */
  transitionStartTime?: number;
  /** True for a subagent whose parent session is absent: drawn as a top-level planet. */
  isOrphan?: boolean;
  moons: OrreryMoon[];
  labelLayout?: WaitingLabelLayout;
}

export interface WaitingLabelLayout {
  planetId: string;
  labelText: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDisplaced: boolean;
  leaderLine?: {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
  };
}

export interface OrreryLayout {
  suns: OrrerySun[];
  planets: OrreryPlanet[];
  labels?: WaitingLabelLayout[];
}

export type OrreryTheme = 'dark' | 'light';

export interface OrreryOptions {
  width: number;
  height: number;
  /** Cap on paints per second while planets move; omitted means every host frame (no judder). */
  maxFps?: number;
  theme?: OrreryTheme;
  reducedMotion?: boolean;
  paused?: boolean;
  seed?: number | string;
  /**
   * Unix ms that corresponds to animation time t = 0. Wall time at t is wallEpochMs + t.
   * Used only for "needs you for 2m" text. Defaults to 0 (tests, capture).
   */
  wallEpochMs?: number;
  onSelectSession?: (session: Session) => void;
  onHoverSession?: (session: Session | null) => void;
  onSelectSun?: (project: Project) => void;
}

export interface HitTestResult {
  type: 'planet' | 'moon' | 'sun';
  planet?: OrreryPlanet;
  moon?: OrreryMoon;
  sun?: OrrerySun;
}
