import { describe, expect, it } from "vitest";
import { rectsOverlap } from "../src/labels/solver";
import { Overlay } from "../src/render/overlay";
import { LABEL_KEY } from "../src/scene/scene";
import type { SceneInput } from "../src/scene/types";
import { makeScene, scripted, snapshot, TARGET } from "./helpers";

const TIMES = [800, 2700, 3900, 4600, 6100, 8800, 10400, 11900, 13300, 16900, 19000, 22000, 25200, 27000];

describe("determinism", () => {
  it("the same t gives the same frame, in any seek order and across fresh scenes", () => {
    const inputs = scripted(9600, [{ kind: "target", at: 0, target: TARGET }]);
    const a = makeScene();
    a.setInputs(inputs);
    const first = TIMES.map((t) => snapshot(a.evaluate(t)));
    // Seek around in reverse and at random, then come back.
    for (const t of TIMES.slice().reverse()) a.evaluate(t + 17);
    const second = TIMES.map((t) => snapshot(a.evaluate(t)));
    // Inputs handed over in reverse time order are sorted by time (events that share a millisecond
    // keep their emission order, which is meaningful: the catalogue precedes its agents).
    const b = makeScene();
    const byTime = new Map<number, typeof inputs>();
    for (const i of inputs) byTime.set(i.at, [...(byTime.get(i.at) ?? []), i]);
    b.setInputs([...byTime.keys()].sort((x, y) => y - x).flatMap((at) => byTime.get(at)!));
    const third = TIMES.map((t) => snapshot(b.evaluate(t)));
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("is causal: an input at time `at` never changes any frame before `at`", () => {
    const base = scripted(9600);
    const full = makeScene();
    full.setInputs(base);
    const sc = full.schedule();
    // Cut the log at several points and compare frames strictly before each cut.
    const cuts = [9700, 11000, sc.doneAt!, sc.scanEndAt! + 300];
    for (const cut of cuts) {
      const partial = makeScene();
      partial.setInputs(base.filter((i: SceneInput) => i.at < cut));
      for (const t of [cut - 600, cut - 250, cut - 1]) {
        if (t < 0) continue;
        expect(snapshot(partial.evaluate(t)), `t=${t} cut=${cut}`).toBe(snapshot(full.evaluate(t)));
      }
    }
  });

  it("live appends give the same frames as a log known in advance", () => {
    const inputs = scripted(9600);
    const known = makeScene();
    known.setInputs(inputs);
    const live = makeScene();
    const sorted = inputs.slice().sort((x, y) => x.at - y.at);
    let i = 0;
    for (let t = 0; t < 20000; t += 50) {
      while (i < sorted.length && sorted[i].at <= t) live.push(sorted[i++]);
      if (t % 1000 === 0) expect(snapshot(live.evaluate(t)), `t=${t}`).toBe(snapshot(known.evaluate(t)));
      else live.evaluate(t);
    }
  });

  it("renders identical overlay draw calls for the same t (canvas stub)", () => {
    const inputs = scripted(9600, [{ kind: "target", at: 0, target: TARGET }]);
    const run = (order: number[]) => {
      const s = makeScene();
      s.setInputs(inputs);
      const { canvas, log } = recordingCanvas();
      const o = new Overlay(canvas);
      o.resize(1440, 900, 2);
      const out: string[] = [];
      for (const t of order) {
        log.length = 0;
        o.render(s.evaluate(t));
        out.push(log.join("\n"));
      }
      return out;
    };
    const fwd = run([6000, 13300, 26000]);
    const rev = run([26000, 13300, 6000]).reverse();
    expect(rev).toEqual(fwd);
    expect(fwd[0].length).toBeGreaterThan(100);
  });
});

describe("labels in frames", () => {
  it("found-agent labels never overlap each other or the cartouche at keyframes", () => {
    const s = makeScene();
    s.setInputs(scripted(9600));
    const sc = s.schedule();
    for (let t = 9600; t < sc.handoffAt!; t += LABEL_KEY * 3) {
      const tk = Math.ceil(t / LABEL_KEY) * LABEL_KEY + 1; // just after a keyframe: positions equal the solved ones
      const f = s.evaluate(tk);
      const boxes = f.texts
        .filter((x) => x.id.startsWith("n:") && x.alpha > 0.99)
        .map((x) => ({ id: x.id, x: x.x - 16, y: x.y - 15, w: 16 + x.text.length * 17 * 0.56, h: 18 }));
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) expect(rectsOverlap(boxes[i], boxes[j], 0), `${boxes[i].id} vs ${boxes[j].id} at ${tk}`).toBe(false);
    }
  });

  it("only engraves numerals that face the viewer", () => {
    const s = makeScene();
    s.setInputs([]);
    const f = s.evaluate(8000);
    const numerals = f.texts.filter((x) => x.style === "numeral");
    expect(numerals.length).toBeGreaterThan(3);
    for (const n of numerals) {
      const [a, b, c, d] = n.transform!;
      expect(a * d - b * c).toBeGreaterThan(0.42); // legible: not edge-on, not mirrored
    }
  });
});

/** A 2D context stub that records every call and property write. */
function recordingCanvas(): { canvas: HTMLCanvasElement; log: string[] } {
  const log: string[] = [];
  const r = (v: unknown) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : typeof v === "object" ? "obj" : v);
  const grad = { addColorStop: (o: number, c: string) => log.push(`stop ${r(o)} ${c}`) };
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(_t, prop: string) {
      if (prop === "measureText") return (s: string) => ({ width: s.length * 7 });
      if (prop === "createLinearGradient" || prop === "createRadialGradient")
        return (...a: number[]) => {
          log.push(`${prop} ${a.map(r).join(",")}`);
          return grad;
        };
      if (prop in target) return target[prop];
      return (...a: unknown[]) => {
        log.push(`${prop}(${a.map(r).join(",")})`);
      };
    },
    set(_t, prop: string, v: unknown) {
      target[prop] = v;
      log.push(`${prop}=${r(v)}`);
      return true;
    },
  });
  const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  return { canvas, log };
}
