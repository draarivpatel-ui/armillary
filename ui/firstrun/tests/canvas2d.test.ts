import { describe, expect, it } from "vitest";
import { Canvas2DSkyRenderer } from "../src/render/canvas2d";
import { buildField } from "../src/scene/sky";
import type { Frame } from "../src/scene/types";
import { makeScene, scripted, TARGET } from "./helpers";

const W = 1440;
const H = 900;

/** A recording 2D-context stub: every call and property write goes to one shared log. */
function recorder(): { log: string[]; createCanvas: (w: number, h: number) => HTMLCanvasElement; main: HTMLCanvasElement } {
  const log: string[] = [];
  const r = (v: unknown) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : typeof v === "object" ? "obj" : v);
  const makeCtx = () => {
    const target: Record<string, unknown> = {};
    const grad = { addColorStop: (o: number, c: string) => log.push(`stop ${r(o)} ${c}`) };
    return new Proxy(target, {
      get(_t, prop: string) {
        if (prop === "measureText") return (s: string) => ({ width: s.length * 7 });
        if (prop === "createLinearGradient" || prop === "createRadialGradient")
          return (...a: number[]) => {
            log.push(`${prop} ${a.map(r).join(",")}`);
            return grad;
          };
        if (prop === "createImageData" || prop === "getImageData")
          return (w: number, h: number) => {
            log.push(`${prop}(${w},${h})`);
            return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
          };
        if (prop === "createPattern") return () => ({});
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
  };
  const createCanvas = (w = 0, h = 0) => ({ width: w, height: h, getContext: () => makeCtx() }) as unknown as HTMLCanvasElement;
  return { log, createCanvas, main: createCanvas() };
}

function setup() {
  const rec = recorder();
  const field = buildField();
  const renderer = new Canvas2DSkyRenderer(rec.main, field, {
    createCanvas: rec.createCanvas,
    onPhase: (l) => rec.log.push(`#${l}`),
  });
  renderer.resize(W, H, 2);
  rec.log.length = 0;
  return { renderer, log: rec.log };
}

function frames(times: number[]): Map<number, Frame> {
  const s = makeScene();
  s.setInputs(scripted(9600, [{ kind: "target", at: 0, target: TARGET }]));
  return new Map(times.map((t) => [t, s.evaluate(t)]));
}

const count = (log: string[], re: RegExp) => log.filter((l) => re.test(l)).length;
const fills = (log: string[]) => count(log, /^(fill|fillRect)\(/);
const strokes = (log: string[]) => count(log, /^(stroke|strokeRect)\(/);

describe("Canvas2DSkyRenderer", () => {
  it("draws identical call logs for the same frame, in any order and on a fresh renderer", () => {
    const times = [6000, 13300, 26000];
    const fr = frames(times);
    const run = (order: number[]) => {
      const { renderer, log } = setup();
      const out = new Map<number, string>();
      for (const t of order) {
        log.length = 0;
        renderer.render(fr.get(t)!);
        out.set(t, log.join("\n"));
      }
      return times.map((t) => out.get(t)!);
    };
    const fwd = run(times);
    const rev = run(times.slice().reverse());
    expect(rev).toEqual(fwd);
    // Rendering the same frame twice on one renderer is identical too.
    const { renderer, log } = setup();
    renderer.render(frames([13300]).get(13300)!);
    const a = log.slice();
    log.length = 0;
    renderer.render(frames([13300]).get(13300)!);
    expect(log).toEqual(a);
    expect(fwd[0].length).toBeGreaterThan(1000);
  });

  it("renders every phase without throwing", () => {
    const times = [3000, 9000, 12000, 20000, 26000];
    const fr = frames(times);
    const { renderer, log } = setup();
    for (const t of times) {
      log.length = 0;
      expect(() => renderer.render(fr.get(t)!), `t=${t}`).not.toThrow();
      expect(log.length, `t=${t}`).toBeGreaterThan(20);
    }
  });

  it("draws the assembled instrument in both passes", () => {
    const f = frames([8000]).get(8000)!;
    const { renderer, log } = setup();
    renderer.render(f);
    const iBack = log.indexOf("#back");
    const iContents = log.indexOf("#contents");
    const iFront = log.indexOf("#front");
    expect(iBack).toBeGreaterThan(-1);
    expect(iContents).toBeGreaterThan(iBack);
    expect(iFront).toBeGreaterThan(iContents);
    const back = log.slice(iBack, iContents);
    const front = log.slice(iFront);
    expect(fills(back)).toBeGreaterThan(3);
    expect(fills(front)).toBeGreaterThan(3);
    expect(fills(log) + count(log, /^lineTo\(/)).toBeGreaterThanOrEqual(40);
  });

  it("paints the back pass, then stars, then the front pass", () => {
    const f = frames([14000]).get(14000)!;
    expect(f.stars.length).toBeGreaterThan(0);
    const { renderer, log } = setup();
    renderer.render(f);
    const order = log.filter((l) => l.startsWith("#"));
    expect(order).toEqual(["#background", "#field", "#back", "#contents", "#stars", "#front"]);
    const iBack = log.indexOf("#back");
    const iStars = log.indexOf("#stars");
    const iFront = log.indexOf("#front");
    const lastBackFill = log.map((l, i) => (i > iBack && i < log.indexOf("#contents") && /^fill\(/.test(l) ? i : -1)).reduce((m, i) => Math.max(m, i), -1);
    const firstFrontFill = log.findIndex((l, i) => i > iFront && /^fill\(/.test(l));
    expect(lastBackFill).toBeGreaterThan(iBack);
    expect(firstFrontFill).toBeGreaterThan(lastBackFill);
    expect(iStars).toBeGreaterThan(iBack);
    expect(iFront).toBeGreaterThan(iStars);
    expect(firstFrontFill).toBeGreaterThan(iStars);
  });

  it("batches: a scan frame issues fewer than 400 fills", () => {
    const times = [5000, 12000, 21500];
    const fr = frames(times);
    const { renderer, log } = setup();
    for (const t of times) {
      log.length = 0;
      renderer.render(fr.get(t)!);
      const nf = fills(log);
      const ns = strokes(log);
      console.log(`c2d t=${t} fills=${nf} strokes=${ns} drawImage=${count(log, /^drawImage\(/)} calls=${log.length}`);
      expect(nf, `t=${t}`).toBeLessThan(400);
    }
  });

  it("never writes NaN or Infinity, including with reduced motion and odd sizes", () => {
    const times = [0, 1500, 4300, 8000, 12000, 21500, 26000, 28500];
    const fr = frames(times);
    const reduced = (() => {
      const s = makeScene({ reducedMotion: true });
      s.setInputs(scripted(9600, [{ kind: "target", at: 0, target: TARGET }]));
      return times.map((t) => s.evaluate(t));
    })();
    for (const [w, h, dpr] of [[W, H, 2], [320, 240, 1], [1920, 1080, 1.5]] as const) {
      const rec = recorder();
      const renderer = new Canvas2DSkyRenderer(rec.main, buildField(), { createCanvas: rec.createCanvas });
      renderer.resize(w, h, dpr);
      rec.log.length = 0;
      for (const f of [...fr.values(), ...reduced]) {
        renderer.render(f);
      }
      const bad = rec.log.filter((l) => /NaN|Infinity|undefined/.test(l));
      expect(bad.slice(0, 5), `${w}x${h}`).toEqual([]);
    }
  });

  it("rebuilds its offscreen caches on resize", () => {
    const rec = recorder();
    const renderer = new Canvas2DSkyRenderer(rec.main, buildField(), { createCanvas: rec.createCanvas });
    renderer.resize(W, H, 2);
    const nBuild = rec.log.length;
    expect(nBuild).toBeGreaterThan(500);
    rec.log.length = 0;
    renderer.render(frames([12000]).get(12000)!);
    expect(count(rec.log, /^createImageData/)).toBe(0);
    rec.log.length = 0;
    renderer.resize(800, 600, 1);
    expect(rec.log.length).toBeGreaterThan(500);
  });
});
