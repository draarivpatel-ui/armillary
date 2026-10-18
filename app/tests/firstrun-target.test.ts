import { describe, expect, it } from "vitest";
import type { Session } from "@orrery/orrery";
import { computeLayout as computeOrreryLayout, FALLBACK_DARK, FALLBACK_LIGHT, getPlaqueRect, orbitAngularSpeed, wrapAngle } from "@orrery/orrery";
import { getMockLiveList } from "../src/api/live";
import { computeHandoffTarget, ORRERY_FRAME, ORRERY_LAYOUT_SEED } from "../src/firstrun/target";

const data = getMockLiveList();

const EXPECTED_FRAME = { outerInset: 10, innerInset: 24, minorTickDeg: 2, midTickDeg: 10, majorTickDeg: 30 };

// The app's LiveSession can carry state "unknown", which the Orrery's own Session type does not list; the
// Orrery view passes sessions through untyped, and so does this helper.
const computeLayout = (projects: typeof data.projects, sessions: typeof data.sessions, o: Parameters<typeof computeOrreryLayout>[2]) =>
  computeOrreryLayout(projects, sessions as unknown as Session[], o);

const RECT_1X = { left: 100, top: 50, width: 1000, height: 640 }; // layout size equals the rect: scale 1
const RECT_SKEW = { left: 30, top: 20, width: 540, height: 400 }; // sx 0.9, sy 0.83: not uniform
const RECT_SMALL = { left: 30, top: 20, width: 500, height: 400 }; // clamped to 600x480 in the layout: scale < 1

function target(over: Partial<Parameters<typeof computeHandoffTarget>[0]> = {}) {
  return computeHandoffTarget({
    stageRect: RECT_1X,
    projects: data.projects,
    sessions: data.sessions,
    orreryElapsedMs: 0,
    theme: "dark",
    ...over,
  });
}

function directLayout(rect: { width: number; height: number }) {
  const w = Math.max(600, Math.floor(rect.width || 1000));
  const h = Math.max(480, Math.floor(rect.height || 540));
  return { w, h, layout: computeLayout(data.projects, data.sessions, { width: w, height: h, seed: ORRERY_LAYOUT_SEED }) };
}

/** The same ellipse maths as animation.ts updateAnimationState. */
function ellipsePoint(p: { orbitSemiMajor: number; orbitSemiMinor: number; orbitTilt: number }, sun: { x: number; y: number }, angle: number) {
  const ux = p.orbitSemiMajor * Math.cos(angle);
  const uy = p.orbitSemiMinor * Math.sin(angle);
  const c = Math.cos(p.orbitTilt);
  const s = Math.sin(p.orbitTilt);
  return { x: sun.x + (ux * c - uy * s), y: sun.y + (ux * s + uy * c) };
}

describe("computeHandoffTarget", () => {
  it("uses the seed and frame numbers the Orrery draws with", () => {
    expect(ORRERY_LAYOUT_SEED).toBe(42);
    // DS's seam: the values the Orrery's renderer draws its frame with.
    expect(ORRERY_FRAME).toMatchObject({ outerInset: 10, innerInset: 24, scaleDegrees: 360, minorTickDeg: 2, midTickDeg: 10, majorTickDeg: 30, numeralDeg: 30 });
  });

  it("reports the stage rect, the theme and the Orrery frame", () => {
    const t = target({ theme: "light" });
    expect(t).not.toBeNull();
    expect(t!.stage).toEqual({ x: RECT_1X.left, y: RECT_1X.top, w: RECT_1X.width, h: RECT_1X.height });
    expect(t!.theme).toBe("light");
    expect(t!.frame).toEqual(EXPECTED_FRAME);
  });

  it("puts every sun at the stage offset plus its layout position", () => {
    const t = target();
    const { layout } = directLayout(RECT_1X);
    expect(t).not.toBeNull();
    expect(t!.suns).toHaveLength(layout.suns.length);
    expect(layout.suns.length).toBe(data.projects.length);
    layout.suns.forEach((sun, i) => {
      const got = t!.suns[i];
      expect(got.id).toBe(sun.id);
      expect(got.name).toBe(sun.project.name);
      expect(got.root).toBe(sun.project.root);
      expect(got.r).toBe(sun.radius);
      expect(got.x).toBeCloseTo(RECT_1X.left + sun.x, 5);
      expect(got.y).toBeCloseTo(RECT_1X.top + sun.y, 5);
    });
  });

  it("scales suns by rect over layout size when the stage is smaller than the layout minimum", () => {
    const t = target({ stageRect: RECT_SMALL });
    const { w, h, layout } = directLayout(RECT_SMALL);
    expect(w).toBe(600);
    expect(h).toBe(480);
    expect(t).not.toBeNull();
    layout.suns.forEach((sun, i) => {
      expect(t!.suns[i].x).toBeCloseTo(RECT_SMALL.left + sun.x * (RECT_SMALL.width / w), 5);
      expect(t!.suns[i].y).toBeCloseTo(RECT_SMALL.top + sun.y * (RECT_SMALL.height / h), 5);
    });
  });

  it("falls back to the view's 1000 x 540 layout when the rect has no size", () => {
    const rect = { left: 0, top: 0, width: 0, height: 0 };
    const t = target({ stageRect: rect });
    const layout = computeLayout(data.projects, data.sessions, { width: 1000, height: 540, seed: ORRERY_LAYOUT_SEED });
    expect(t).not.toBeNull();
    expect(t!.suns).toHaveLength(layout.suns.length);
    t!.suns.forEach((s, i) => {
      expect(Number.isFinite(s.x)).toBe(true);
      expect(Number.isFinite(s.y)).toBe(true);
      expect(s.id).toBe(layout.suns[i].id);
    });
  });

  it("gives every top-level planet a placement, with its sun, radius and orbit", () => {
    const t = target();
    const { layout } = directLayout(RECT_1X);
    expect(t).not.toBeNull();
    expect(t!.planets).toHaveLength(layout.planets.length);
    expect(layout.planets.length).toBeGreaterThan(0);
    for (const planet of layout.planets) {
      const got = t!.planets.find((p) => p.id === planet.id)!;
      expect(got).toBeDefined();
      expect(got.sunId).toBe(planet.sunId);
      expect(got.r).toBe(planet.radius);
      expect(got.done).toBe(planet.isDoneRing);
      const sun = layout.suns.find((s) => s.id === planet.sunId)!;
      expect(got.orbit.cx).toBeCloseTo(RECT_1X.left + sun.x, 5);
      expect(got.orbit.cy).toBeCloseTo(RECT_1X.top + sun.y, 5);
      expect(got.orbit.a).toBeCloseTo(planet.orbitSemiMajor, 5);
      expect(got.orbit.b).toBeCloseTo(planet.orbitSemiMinor, 5);
      expect(got.orbit.tilt).toBeCloseTo(planet.orbitTilt, 5);
    }
  });

  it("advances working and idle planets by orbitAngularSpeed times the Orrery time", () => {
    const elapsed = 41_250;
    const t = target({ orreryElapsedMs: elapsed });
    const { layout } = directLayout(RECT_1X);
    const moving = layout.planets.filter((p) => p.session.state === "working" || p.session.state === "idle");
    expect(moving.length).toBeGreaterThan(0);
    for (const planet of moving) {
      const got = t!.planets.find((p) => p.id === planet.id)!;
      const expected = wrapAngle(planet.startAngle + orbitAngularSpeed(planet.session) * elapsed);
      expect(got.angle).toBeCloseTo(expected, 6);
      const sun = layout.suns.find((s) => s.id === planet.sunId)!;
      const at = ellipsePoint(planet, sun, expected);
      expect(Math.abs(got.x - (RECT_1X.left + at.x))).toBeLessThan(0.1);
      expect(Math.abs(got.y - (RECT_1X.top + at.y))).toBeLessThan(0.1);
    }
  });

  it("keeps waiting planets at their target angle whatever the Orrery time", () => {
    const { layout } = directLayout(RECT_1X);
    const waiting = layout.planets.filter((p) => p.session.state === "waiting");
    expect(waiting.length).toBeGreaterThan(0);
    for (const elapsed of [0, 7_000, 123_456]) {
      const t = target({ orreryElapsedMs: elapsed });
      for (const planet of waiting) {
        expect(t!.planets.find((p) => p.id === planet.id)!.angle).toBeCloseTo(planet.targetAngle, 6);
      }
    }
  });

  it("keeps done-ring planets where the layout put them", () => {
    const sessions = [
      ...data.sessions,
      { ...data.sessions[0], id: "sess-done-1", state: "done" as const, parent_id: undefined },
    ];
    const t = target({ sessions, orreryElapsedMs: 99_000 });
    const layout = computeLayout(data.projects, sessions, { width: 1000, height: 640, seed: ORRERY_LAYOUT_SEED });
    const done = layout.planets.filter((p) => p.isDoneRing);
    expect(done.length).toBeGreaterThan(0);
    for (const planet of done) {
      const got = t!.planets.find((p) => p.id === planet.id)!;
      expect(got.done).toBe(true);
      expect(got.angle).toBeCloseTo(planet.angle, 6);
    }
  });

  it("colours a planet with the Orrery's colour for its agent family, per theme", () => {
    const { layout } = directLayout(RECT_1X);
    const planet = layout.planets.find((p) => !p.isDoneRing)!;
    const dark = target({ theme: "dark" })!.planets.find((p) => p.id === planet.id)!;
    const light = target({ theme: "light" })!.planets.find((p) => p.id === planet.id)!;
    expect(dark.color).toBe(FALLBACK_DARK.agents[planet.session.family]);
    expect(light.color).toBe(FALLBACK_LIGHT.agents[planet.session.family]);
    expect(dark.color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("draws done-ring planets in the Orrery's verdigris, whatever their family", () => {
    const sessions = [...data.sessions, { ...data.sessions[0], id: "sess-done-2", state: "done" as const, parent_id: undefined }];
    const layout = computeLayout(data.projects, sessions, { width: 1000, height: 640, seed: ORRERY_LAYOUT_SEED });
    const done = layout.planets.filter((p) => p.isDoneRing);
    expect(done.length).toBeGreaterThan(0);
    const dark = target({ sessions, theme: "dark" })!;
    const light = target({ sessions, theme: "light" })!;
    for (const planet of done) {
      expect(dark.planets.find((p) => p.id === planet.id)!.color).toBe(FALLBACK_DARK.verdigris);
      expect(light.planets.find((p) => p.id === planet.id)!.color).toBe(FALLBACK_LIGHT.verdigris);
    }
  });

  it("scales a planet's orbit by sx on a and sy on b when the stage is smaller than the layout minimum", () => {
    const t = target({ stageRect: RECT_SKEW });
    const { w, h, layout } = directLayout(RECT_SKEW);
    const sx = RECT_SKEW.width / w;
    const sy = RECT_SKEW.height / h;
    expect(sx).not.toBeCloseTo(sy, 3);
    for (const planet of layout.planets) {
      const got = t!.planets.find((p) => p.id === planet.id)!;
      expect(got.orbit.a).toBeCloseTo(planet.orbitSemiMajor * sx, 5);
      expect(got.orbit.b).toBeCloseTo(planet.orbitSemiMinor * sy, 5);
      const sun = layout.suns.find((s) => s.id === planet.sunId)!;
      expect(got.orbit.cx).toBeCloseTo(RECT_SKEW.left + sun.x * sx, 5);
      expect(got.orbit.cy).toBeCloseTo(RECT_SKEW.top + sun.y * sy, 5);
      const at = ellipsePoint(planet, sun, got.angle);
      expect(Math.abs(got.x - (RECT_SKEW.left + at.x * sx))).toBeLessThan(0.1);
      expect(Math.abs(got.y - (RECT_SKEW.top + at.y * sy))).toBeLessThan(0.1);
    }
  });

  it("returns a stage and frame but no suns or planets when there are no projects", () => {
    const t = target({ projects: [], sessions: data.sessions });
    expect(t).not.toBeNull();
    expect(t!.suns).toEqual([]);
    expect(t!.planets).toEqual([]);
    expect(t!.stage).toEqual({ x: RECT_1X.left, y: RECT_1X.top, w: RECT_1X.width, h: RECT_1X.height });
    expect(t!.frame).toEqual(EXPECTED_FRAME);
  });

  it("uses the Orrery's own layout at the landing moment when it is given, instead of computing one", () => {
    const { layout } = directLayout(RECT_1X);
    const placed = {
      ...layout,
      planets: layout.planets.map((p, i) => ({ ...p, angle: 1 + i * 0.1, currentX: 321 + i, currentY: 222 + i })),
    };
    // projects and sessions are ignored on this path, even when empty
    const t = target({ projects: [], sessions: [], layout: placed });
    expect(t).not.toBeNull();
    expect(t!.suns).toHaveLength(layout.suns.length);
    expect(t!.planets).toHaveLength(layout.planets.length);
    placed.planets.forEach((p, i) => {
      const got = t!.planets.find((g) => g.id === p.id)!;
      expect(got.angle).toBeCloseTo(1 + i * 0.1, 6);
      expect(got.x).toBeCloseTo(RECT_1X.left + 321 + i, 5);
      expect(got.y).toBeCloseTo(RECT_1X.top + 222 + i, 5);
    });
    layout.suns.forEach((sun, i) => {
      expect(t!.suns[i].x).toBeCloseTo(RECT_1X.left + sun.x, 5);
      expect(t!.suns[i].name).toBe(sun.project.name);
    });
  });
});

describe("computeHandoffTarget: what the Orrery draws next", () => {
  it("puts each sun's name where the Orrery's own plaque geometry engraves it", () => {
    const t = target()!;
    const { layout } = directLayout(RECT_1X);
    for (const sun of layout.suns) {
      const plate = getPlaqueRect(sun);
      const got = t.suns.find((s) => s.id === sun.id)!;
      expect(got.nameY).toBeCloseTo(RECT_1X.top + plate.y + plate.height / 2, 6);
    }
  });

  it("carries each planet's family and live state, so the hand-over draws the same glyph and dimming", () => {
    const t = target()!;
    const { layout } = directLayout(RECT_1X);
    for (const p of layout.planets) {
      const got = t.planets.find((x) => x.id === p.id)!;
      expect(got.family).toBe(p.session.family);
      expect(got.state).toBe(p.session.state);
    }
  });
});
