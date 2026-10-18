import type { OrreryLayout, Session } from "@orrery/orrery";
import { computeLayout, getPalette, getPlaqueRect, orbitAngularSpeed, ORRERY_FRAME, ORRERY_LAYOUT_SEED, wrapAngle } from "@orrery/orrery";
import type { HandoffPlanet, HandoffSun, HandoffTarget } from "@orrery/firstrun";
import type { LiveProject, LiveSession } from "../api/live";

/** The Orrery's frame geometry and layout seed come from DS's seam (ui/orrery/src/seam.ts). */
export { ORRERY_FRAME, ORRERY_LAYOUT_SEED };

/** What the Orrery stage element exposes once DS's seam is on main (stageEl.__armillaryOrrery). */
export interface OrreryStageHook {
  getLayout(): OrreryLayout;
  /** The layout with every planet placed at Orrery time t (ms). */
  layoutAt(t: number): OrreryLayout;
  /** The Orrery's own clock now (ms), the same timebase as layoutAt. */
  now(): number;
}

export interface HandoffTargetOptions {
  stageRect: { left: number; top: number; width: number; height: number };
  projects: LiveProject[];
  sessions: LiveSession[];
  /** Orrery time (ms since the Orrery canvas mounted) at the landing moment. */
  orreryElapsedMs: number;
  theme: "dark" | "light";
  /** The Orrery's own layout at the landing moment (layoutAt). When given it replaces the computed estimate. */
  layout?: OrreryLayout;
}

export function computeHandoffTarget(opts: HandoffTargetOptions): HandoffTarget | null {
  const { stageRect, projects, sessions, orreryElapsedMs, theme } = opts;
  const given = opts.layout;
  const layoutW = Math.max(600, Math.floor(stageRect.width || 1000));
  const layoutH = Math.max(480, Math.floor(stageRect.height || 540));
  const sx = (stageRect.width || layoutW) / layoutW;
  const sy = (stageRect.height || layoutH) / layoutH;
  const stage = { x: stageRect.left, y: stageRect.top, w: stageRect.width, h: stageRect.height };
  const frame = {
    outerInset: ORRERY_FRAME.outerInset,
    innerInset: ORRERY_FRAME.innerInset,
    minorTickDeg: ORRERY_FRAME.minorTickDeg,
    midTickDeg: ORRERY_FRAME.midTickDeg,
    majorTickDeg: ORRERY_FRAME.majorTickDeg,
  };
  if (!given && projects.length === 0) return { stage, theme, suns: [], planets: [], frame };

  const layout = given ?? computeLayout(projects, sessions as unknown as Session[], { width: layoutW, height: layoutH, seed: ORRERY_LAYOUT_SEED });
  const wx = (x: number) => stageRect.left + x * sx;
  const wy = (y: number) => stageRect.top + y * sy;
  const palette = getPalette(theme);

  const suns: HandoffSun[] = layout.suns.map((s) => {
    // The name plate exactly where the Orrery engraves it (its own plaque geometry).
    const plate = getPlaqueRect(s);
    return { id: s.id, name: s.project.name, root: s.project.root, x: wx(s.x), y: wy(s.y), r: s.radius, nameY: wy(plate.y + plate.height / 2) };
  });
  const sunById = new Map(layout.suns.map((s) => [s.id, s]));

  const planets: HandoffPlanet[] = [];
  for (const p of layout.planets) {
    const sun = sunById.get(p.sunId);
    if (!sun) continue;
    const angle = given
      ? p.angle
      : p.session.state === "waiting"
        ? p.targetAngle
        : p.isDoneRing || p.session.state === "done"
          ? p.angle
          : wrapAngle(p.startAngle + orbitAngularSpeed(p.session) * orreryElapsedMs);
    const ux = p.orbitSemiMajor * Math.cos(angle);
    const uy = p.orbitSemiMinor * Math.sin(angle);
    const c = Math.cos(p.orbitTilt);
    const s = Math.sin(p.orbitTilt);
    const px = given ? p.currentX : Math.round((sun.x + (ux * c - uy * s)) * 10) / 10;
    const py = given ? p.currentY : Math.round((sun.y + (ux * s + uy * c)) * 10) / 10;
    planets.push({
      id: p.id,
      sunId: p.sunId,
      x: wx(px),
      y: wy(py),
      r: p.radius,
      color: p.isDoneRing ? palette.verdigris : (palette.agents[p.session.family] ?? palette.agents.other),
      orbit: { cx: wx(sun.x), cy: wy(sun.y), a: p.orbitSemiMajor * sx, b: p.orbitSemiMinor * sy, tilt: p.orbitTilt },
      angle,
      done: p.isDoneRing,
      family: p.session.family,
      state: p.session.state,
    });
  }
  return { stage, theme, suns, planets, frame };
}
