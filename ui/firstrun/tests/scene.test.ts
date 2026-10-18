import { describe, expect, it } from "vitest";
import { INTRO_END, PLAQUE_INTERACTIVE, T } from "../src/scene/instrument";
import { CONST, HANDOFF, igniteSpacing, SCAN } from "../src/scene/schedule";
import { TITLE } from "../src/scene/scene";
import { LOG, makeScene, scripted, TARGET } from "./helpers";

describe("timeline: event-driven phases", () => {
  it("runs the intro on its own clock and waits at the plaque without consent", () => {
    const s = makeScene();
    s.setInputs([{ kind: "plan", at: 0, plan: LOG.plan }]);
    expect(s.phaseAt(1000)).toBe("intro");
    expect(s.phaseAt(T.plaque[0] + 10)).toBe("consent");
    // An hour later, still waiting: nothing advances without consent.
    expect(s.phaseAt(3_600_000)).toBe("consent");
    const f = s.evaluate(3_600_000);
    expect(f.plaque.visible).toBe(true);
    expect(f.plaque.interactive).toBe(true);
    expect(f.stars).toHaveLength(0);
  });

  it("ignores core events that arrive before consent (nothing is scanned before Continue)", () => {
    const s = makeScene();
    const early = scripted(20000).map((i) => (i.kind === "core" ? { ...i, at: i.at - 19000 } : i));
    s.setInputs(early.filter((i) => i.kind !== "consent"));
    expect(s.schedule().catalogue).toHaveLength(0);
    expect(s.schedule().ignitions).toHaveLength(0);
  });

  it("ignores a consent given before the plaque is interactive", () => {
    const s = makeScene();
    s.setInputs([{ kind: "consent", at: PLAQUE_INTERACTIVE - 200 }]);
    expect(s.schedule().consentAt).toBeUndefined();
  });

  it("moves through scan, constellations and hand-over from real events, then completes", () => {
    const s = makeScene();
    s.setInputs(scripted(9600, [{ kind: "target", at: 0, target: TARGET }]));
    const sc = s.schedule();
    expect(s.phaseAt(9700)).toBe("scan");
    expect(sc.scanEndAt).toBeDefined();
    expect(s.phaseAt(sc.scanEndAt! + 1)).toBe("constellations");
    expect(s.phaseAt(sc.handoffAt! + 1)).toBe("handoff");
    expect(sc.completeAt).toBe(sc.handoffAt! + HANDOFF.dur);
    expect(s.phaseAt(sc.completeAt!)).toBe("complete");
    const f = s.evaluate(sc.completeAt!);
    expect(f.canvasAlpha).toBe(0);
    expect(f.appAlpha).toBe(1);
  });

  it("ends the scan only after its last real event plus its choreography", () => {
    const s = makeScene();
    s.setInputs(scripted(9600));
    const sc = s.schedule();
    const lastEvent = Math.max(...LOG.events.map((e) => e.at)) + 9600;
    const lastIgnite = Math.max(...sc.ignitions.map((id) => sc.agents.get(id)!.igniteAt!));
    expect(sc.scanEndAt!).toBeGreaterThan(lastEvent);
    expect(sc.scanEndAt!).toBeGreaterThanOrEqual(lastIgnite + 1500);
    for (const a of sc.agents.values()) if (a.pulseAt !== undefined) expect(sc.scanEndAt!).toBeGreaterThanOrEqual(a.pulseAt + 500);
  });

  it("spaces star ignitions even when detection resolves all at once", () => {
    const s = makeScene();
    s.setInputs(scripted(9600));
    const sc = s.schedule();
    const times = sc.ignitions.map((id) => sc.agents.get(id)!.igniteAt!);
    expect(times.length).toBe(LOG.events.filter((e) => e.name === "firstrun:agent" && (e.payload as { found: boolean }).found).length);
    expect(times[0]).toBeGreaterThanOrEqual(9600 + SCAN.firstIgnite);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(igniteSpacing(i) - 1e-9);
  });

  it("eases each import arc toward the real fraction and reaches 1 only after the finished event", () => {
    const s = makeScene();
    s.setInputs(scripted(9600));
    const sc = s.schedule();
    const claude = sc.agents.get("claude-code")!;
    expect(claude.finishedAt).toBeDefined();
    const before = s.evaluate(claude.finishedAt! - 1).stars.find((x) => x.id === "claude-code")!;
    const after = s.evaluate(claude.finishedAt! + 2000).stars.find((x) => x.id === "claude-code")!;
    expect(before.arc).toBeLessThan(1);
    expect(after.arc).toBeGreaterThan(0.99);
    // The arc never runs ahead of the real count it is easing toward.
    for (let t = claude.importStartAt!; t < claude.finishedAt!; t += 37) {
      const star = s.evaluate(t).stars.find((x) => x.id === "claude-code")!;
      const realSoFar = Math.max(0, ...claude.steps.filter((st) => st.t <= t).map((st) => st.v));
      expect(star.arc).toBeLessThanOrEqual(realSoFar + 1e-9);
    }
  });

  it("names constellations after project folders, from the done payload", () => {
    const s = makeScene();
    s.setInputs(scripted(9600));
    const sc = s.schedule();
    expect(sc.constellations.length).toBeGreaterThan(0);
    expect(sc.constellations.length).toBeLessThanOrEqual(CONST.maxConstellations);
    const done = LOG.events.find((e) => e.name === "firstrun:done")!.payload as { constellations: Array<{ name: string }> };
    for (const c of sc.constellations) {
      expect(done.constellations.map((d) => d.name)).toContain(c.name);
      expect(c.name).not.toContain("/");
      for (const m of c.members) expect(sc.agents.get(m)!.igniteAt).toBeDefined();
      expect(c.edges.length).toBe(Math.max(0, c.members.length - 1));
    }
  });

  it("counts found agents from real events against the real catalogue size", () => {
    const s = makeScene();
    s.setInputs(scripted(9600));
    const sc = s.schedule();
    const f = s.evaluate(sc.scanEndAt!);
    const done = LOG.events.find((e) => e.name === "firstrun:done")!.payload as { agentsFound: number; catalogueSize: number };
    expect(f.cartouche.found).toBe(done.agentsFound);
    expect(f.cartouche.catalogue).toBe(done.catalogueSize);
  });
});

describe("skip and decline", () => {
  it("before consent, a skip fast-forwards the intro to the plaque (consent cannot be skipped)", () => {
    const s = makeScene();
    s.setInputs([{ kind: "skip", at: 1500 }]);
    const plaqueAt = 1500 + (PLAQUE_INTERACTIVE - 1500) / 9;
    expect(s.evaluate(plaqueAt + 50).plaque.interactive).toBe(true);
    expect(s.phaseAt(60_000)).toBe("consent");
    expect(s.schedule().consentAt).toBeUndefined();
  });

  it("after consent, a skip exits to the app while the import continues", () => {
    const s = makeScene();
    s.setInputs(scripted(9600, [{ kind: "skip", at: 11000 }]));
    const sc = s.schedule();
    expect(sc.exitAt).toBe(11000);
    expect(s.phaseAt(11001)).toBe("exit");
    expect(s.phaseAt(sc.completeAt!)).toBe("complete");
    expect(sc.completeAt! - 11000).toBeLessThan(1000);
  });

  it("Not now opens the app with nothing scanned", () => {
    const s = makeScene();
    s.setInputs([{ kind: "decline", at: INTRO_END + 500 }]);
    const sc = s.schedule();
    expect(sc.consentAt).toBeUndefined();
    expect(s.phaseAt(sc.completeAt!)).toBe("complete");
    expect(s.evaluate(sc.completeAt!).stars).toHaveLength(0);
  });
});

describe("reduced motion", () => {
  it("draws static frames: no flares, no beam, no camera moves, the title shown whole", () => {
    const s = makeScene({ reducedMotion: true });
    s.setInputs(scripted(9600, [{ kind: "target", at: 0, target: TARGET }]));
    const sc = s.schedule();
    const scan = s.evaluate(sc.ignitions.length ? sc.agents.get(sc.ignitions[0])!.igniteAt! + 50 : 12000);
    expect(scan.beam).toBeNull();
    for (const st of scan.stars) {
      expect(st.flare).toBe(0);
      expect(st.spikes).toBe(0);
    }
    expect(s.spinAt(sc.scanEndAt! + 4000)).toBe(0);
    const h0 = s.evaluate(sc.handoffAt! + 10).cam.scale;
    const h1 = s.evaluate(sc.handoffAt! + 800).cam.scale;
    expect(h1).toBe(h0);
    const intro = s.evaluate(T.title[0] + 500);
    const title = intro.texts.find((x) => x.id === "title");
    expect(title?.reveal).toBe(1);
    expect(title?.text).toBe(TITLE);
  });
});

describe("hand-over", () => {
  it("lands on the measured Orrery: suns at their exact positions, the rule on the stage frame", () => {
    const s = makeScene();
    s.setInputs(scripted(9600, [{ kind: "target", at: 0, target: TARGET }]));
    const sc = s.schedule();
    const end = s.evaluate(sc.handoffAt! + HANDOFF.dur - HANDOFF.fade - 10);
    for (const sun of TARGET.suns) {
      const d = end.suns.find((x) => x.id === sun.id)!;
      expect(d.x).toBe(sun.x);
      expect(d.y).toBe(sun.y);
      expect(d.r).toBeCloseTo(sun.r, 5);
    }
    const r = end.rule.rect;
    expect(r.x).toBeCloseTo(TARGET.stage.x + TARGET.frame.outerInset, 5);
    expect(r.y).toBeCloseTo(TARGET.stage.y + TARGET.frame.outerInset, 5);
    expect(r.w).toBeCloseTo(TARGET.stage.w - 2 * TARGET.frame.outerInset, 5);
    const p = end.planets.find((x) => x.id === "p1")!;
    expect(p.x).toBeCloseTo(TARGET.planets[0].x, 0);
    expect(p.y).toBeCloseTo(TARGET.planets[0].y, 0);
  });
});
