/**
 * Folds the scene inputs into a schedule: when each star ignites, how each import arc steps, when
 * each scene starts and ends. Causal by construction: every derived time is at or after the input
 * that caused it, so evaluating at t only ever uses inputs with `at <= t` and seeking is exact.
 */
import type { CatalogueEntry, Constellation, DonePayload, FirstRunPlan } from "../events";
import { FIRSTRUN_EVENT } from "../events";
import type { V3 } from "../math/vec";
import { INTRO_END, PLAQUE_INTERACTIVE } from "./instrument";
import type { CatalogueStar } from "./sky";
import type { HandoffTarget, SceneInput } from "./types";

/** Fast-forward factor for an Escape before consent (the intro rushes to the plaque). */
export const SKIP_FF = 9;

export const SCAN = {
  /** Earliest first ignition after consent. */
  firstIgnite: 1550,
  /** Chart dots begin to appear after consent (and after the catalogue arrives). */
  dotsFrom: 650,
  dotsSweep: 1100,
  /** Arc steps wait this long after their star ignites. */
  arcDelay: 480,
  /** Arc smoothing rate (per ms). */
  arcRate: 1 / 230,
  /** The completion pulse fires this long after the finishing step. */
  pulseAfter: 700,
} as const;

export const CONST = {
  lead: 500,
  stagger: 950,
  edgeStagger: 240,
  edgeDur: 560,
  nameDelay: 260,
  nameDur: 700,
  hold: 1900,
  minDur: 4600,
  maxConstellations: 5,
  maxMembers: 6,
  /** Peak sky spin, radians per ms, and its ramp. */
  spinRate: (-7 * Math.PI) / 180 / 1000,
  spinRamp: 1800,
} as const;

export const HANDOFF = { dur: 3700, fade: 750, reducedDur: 900 } as const;
export const EXIT = { dur: 650, plaqueRise: 650 } as const;

export function igniteSpacing(alreadyIgnited: number): number {
  return alreadyIgnited < 10 ? 270 : alreadyIgnited < 20 ? 190 : 110;
}

export interface ArcStep {
  t: number;
  v: number;
}

export interface AgentSched {
  entry: CatalogueEntry;
  /** When the agent event arrived. */
  detectedAt?: number;
  found: boolean;
  igniteAt?: number;
  history: boolean;
  importStartAt?: number;
  steps: ArcStep[];
  /** Latest real counts. */
  imported: number;
  known: number;
  finishedAt?: number;
  pulseAt?: number;
  error?: string;
  errorAt?: number;
  projects: string[];
}

export interface ConstellationSched {
  name: string;
  root: string;
  members: string[];
  /** Edges as pairs of member ids, in drawing order (a spanning tree). */
  edges: Array<[string, string]>;
  startAt: number;
  nameAt: number;
}

export interface Schedule {
  plan?: FirstRunPlan;
  skipAt?: number;
  consentAt?: number;
  declineAt?: number;
  exitAt?: number;
  catalogueAt?: number;
  catalogue: CatalogueEntry[];
  agents: Map<string, AgentSched>;
  ignitions: string[];
  doneAt?: number;
  done?: DonePayload;
  coreError?: string;
  scanEndAt?: number;
  constellations: ConstellationSched[];
  constEndAt?: number;
  handoffAt?: number;
  completeAt?: number;
  target?: HandoffTarget;
  targetAt?: number;
}

/** Intro clock: real time, or fast-forwarded after a pre-consent skip. */
export function introTime(s: Schedule, t: number): number {
  if (s.skipAt === undefined || t <= s.skipAt) return t;
  return Math.min(Math.max(t, INTRO_END), s.skipAt + (t - s.skipAt) * SKIP_FF);
}

/** Scene-clock time at which the intro clock reaches `ti` (inverse of introTime). */
export function sceneTimeOfIntro(s: Schedule, ti: number): number {
  if (s.skipAt === undefined || ti <= s.skipAt) return ti;
  return s.skipAt + (ti - s.skipAt) / SKIP_FF;
}

export interface ScheduleDeps {
  /** Places the catalogue on the sphere (memoised by the caller). */
  place: (ids: string[]) => CatalogueStar[];
  /** Instrument-space position of a catalogue star at spin 0. */
  starPos?: (id: string) => V3 | undefined;
}

function mst(members: string[], pos: (id: string) => V3 | undefined): Array<[string, string]> {
  const pts = members.map((m) => pos(m));
  if (members.length < 2 || pts.some((p) => !p)) return [];
  const inTree = new Array(members.length).fill(false);
  const best = new Array(members.length).fill(Infinity);
  const from = new Array(members.length).fill(-1);
  inTree[0] = true;
  for (let i = 1; i < members.length; i++) {
    const a = pts[0]!;
    const b = pts[i]!;
    best[i] = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    from[i] = 0;
  }
  const edges: Array<[string, string]> = [];
  for (let k = 1; k < members.length; k++) {
    let pick = -1;
    for (let i = 0; i < members.length; i++) if (!inTree[i] && (pick < 0 || best[i] < best[pick])) pick = i;
    inTree[pick] = true;
    edges.push([members[from[pick]], members[pick]]);
    for (let i = 0; i < members.length; i++) {
      if (inTree[i]) continue;
      const a = pts[pick]!;
      const b = pts[i]!;
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d < best[i]) {
        best[i] = d;
        from[i] = pick;
      }
    }
  }
  return edges;
}

function pickConstellations(done: DonePayload, agents: Map<string, AgentSched>): Array<{ c: Constellation; members: string[] }> {
  const out: Array<{ c: Constellation; members: string[] }> = [];
  const sorted = done.constellations.slice().sort((a, b) => b.sessions - a.sessions || (a.name < b.name ? -1 : 1));
  for (const c of sorted) {
    const members = (c.members.length ? c.members : c.agents.map((a) => ({ agentId: a, sessions: 0 })))
      .filter((m) => agents.get(m.agentId)?.igniteAt !== undefined)
      .slice()
      .sort((a, b) => b.sessions - a.sessions || (a.agentId < b.agentId ? -1 : 1))
      .slice(0, CONST.maxMembers)
      .map((m) => m.agentId);
    if (members.length === 0) continue;
    // Projects whose core agents are identical would draw the same figure twice: keep the one with
    // the most sessions (sorted first); the others still get their own suns in the Orrery.
    const key = members.slice().sort().join("|");
    if (out.some((o) => o.members.slice().sort().join("|") === key)) continue;
    out.push({ c, members });
    if (out.length >= CONST.maxConstellations) break;
  }
  return out;
}

export function buildSchedule(inputs: readonly SceneInput[], deps: ScheduleDeps): Schedule {
  const s: Schedule = { catalogue: [], agents: new Map(), ignitions: [], constellations: [] };
  const sorted = inputs.slice().sort((a, b) => a.at - b.at);
  let lastIgnite = -Infinity;
  for (const inp of sorted) {
    switch (inp.kind) {
      case "plan":
        if (!s.plan) s.plan = inp.plan;
        break;
      case "skip": {
        if (s.consentAt === undefined && s.declineAt === undefined) {
          if (s.skipAt === undefined && inp.at < INTRO_END) s.skipAt = inp.at;
        } else if (s.exitAt === undefined && s.completeAt === undefined) {
          s.exitAt = inp.at;
          s.completeAt = inp.at + EXIT.dur;
        }
        break;
      }
      case "consent": {
        // Consent only counts once the plaque is interactive and nothing else has resolved it.
        if (s.consentAt !== undefined || s.declineAt !== undefined) break;
        const ready = sceneTimeOfIntro(s, PLAQUE_INTERACTIVE);
        if (inp.at + 1e-6 < ready) break;
        s.consentAt = inp.at;
        break;
      }
      case "decline": {
        if (s.consentAt !== undefined || s.declineAt !== undefined) break;
        s.declineAt = inp.at;
        s.exitAt = inp.at + EXIT.plaqueRise;
        s.completeAt = s.exitAt + EXIT.dur;
        break;
      }
      case "target":
        s.target = inp.target;
        s.targetAt = inp.at;
        break;
      case "coreError":
        if (s.consentAt === undefined || s.doneAt !== undefined) break;
        s.coreError = inp.message;
        s.doneAt = inp.at;
        s.done = { constellations: [], liveSessions: 0, sessionsImported: 0, agentsFound: 0, catalogueSize: s.catalogue.length, errors: 1 };
        break;
      case "core": {
        if (s.consentAt === undefined || inp.at < s.consentAt) break; // nothing is scanned before consent
        const ev = inp.event;
        if (ev.name === FIRSTRUN_EVENT.catalogue) {
          if (s.catalogueAt !== undefined) break;
          s.catalogueAt = inp.at;
          s.catalogue = ev.payload.entries;
          for (const e of s.catalogue) s.agents.set(e.id, { entry: e, found: false, history: e.history, steps: [], imported: 0, known: 0, projects: [] });
          deps.place(s.catalogue.map((e) => e.id));
        } else if (ev.name === FIRSTRUN_EVENT.agent) {
          const a = s.agents.get(ev.payload.id);
          if (!a || a.detectedAt !== undefined) break;
          a.detectedAt = inp.at;
          a.found = ev.payload.found;
          a.history = ev.payload.history;
          if (a.found) {
            const earliest = s.consentAt + SCAN.firstIgnite;
            const ig = Math.max(inp.at, earliest, lastIgnite + igniteSpacing(s.ignitions.length));
            a.igniteAt = ig;
            lastIgnite = ig;
            s.ignitions.push(a.entry.id);
          }
        } else if (ev.name === FIRSTRUN_EVENT.import) {
          const p = ev.payload;
          const a = s.agents.get(p.agentId);
          if (!a || a.igniteAt === undefined || a.finishedAt !== undefined || a.errorAt !== undefined) break;
          const te = Math.max(inp.at, a.igniteAt + SCAN.arcDelay);
          if (p.phase === "started") {
            a.importStartAt = te;
            a.steps.push({ t: te, v: 0 });
          } else {
            if (a.importStartAt === undefined) {
              a.importStartAt = te;
              a.steps.push({ t: te, v: 0 });
            }
            a.imported = p.sessionsImported;
            a.known = Math.max(p.sessionsKnown, p.sessionsImported);
            const frac = a.known > 0 ? a.imported / a.known : 0;
            if (p.phase === "finished") {
              a.steps.push({ t: te, v: 1 });
              a.finishedAt = te;
              a.pulseAt = te + SCAN.pulseAfter;
              a.projects = p.projects;
              if (p.error) {
                a.error = p.error;
                a.errorAt = te;
              }
            } else if (p.phase === "error") {
              a.steps.push({ t: te, v: frac });
              a.error = p.error ?? "import failed";
              a.errorAt = te;
            } else {
              a.steps.push({ t: te, v: frac });
              if (p.error && !a.error) {
                a.error = p.error;
              }
            }
          }
        } else if (ev.name === FIRSTRUN_EVENT.done) {
          if (s.doneAt !== undefined) break;
          s.doneAt = inp.at;
          s.done = ev.payload;
        }
        break;
      }
    }
  }

  // Scene boundaries after the scan (all derivable at doneAt, so still causal).
  if (s.doneAt !== undefined && s.done && s.exitAt === undefined) {
    let end = s.doneAt + 300;
    if (s.ignitions.length) end = Math.max(end, lastIgnite + 1500);
    for (const a of s.agents.values()) {
      if (a.pulseAt !== undefined) end = Math.max(end, a.pulseAt + 500);
      if (a.errorAt !== undefined) end = Math.max(end, a.errorAt + 1200);
    }
    s.scanEndAt = end;
    const picks = pickConstellations(s.done, s.agents);
    let t0 = end + CONST.lead;
    let lastName = end;
    picks.forEach(({ c, members }, k) => {
      const startAt = t0 + k * CONST.stagger;
      const edges = deps.starPos ? mst(members, deps.starPos) : [];
      const nameAt = startAt + Math.max(0, edges.length - 1) * CONST.edgeStagger + (edges.length ? CONST.edgeDur : 0) + CONST.nameDelay;
      lastName = Math.max(lastName, nameAt + CONST.nameDur);
      s.constellations.push({ name: c.name, root: c.root, members, edges, startAt, nameAt });
    });
    s.constEndAt = picks.length ? Math.max(lastName + CONST.hold, end + CONST.minDur) : end + 1200;
    s.handoffAt = s.constEndAt;
    if (s.completeAt === undefined) s.completeAt = s.handoffAt + HANDOFF.dur;
    t0 = 0;
  }
  // A skip during the hand-over or the constellations exits immediately.
  if (s.exitAt !== undefined && s.declineAt === undefined && s.completeAt !== undefined) {
    s.completeAt = Math.min(s.completeAt, s.exitAt + EXIT.dur);
  }
  return s;
}
