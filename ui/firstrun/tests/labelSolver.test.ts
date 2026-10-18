import { describe, it, expect } from "vitest";
import {
  solveLabels,
  rectsOverlap,
  segmentIntersectsRect,
  PRIORITY,
  type LabelRequest,
  type Obstacle,
  type PlacedLabel,
  type Rect,
} from "../src/labels/solver";

// ---------- seeded PRNG + scene generation ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BOUNDS: Rect = { x: 0, y: 0, w: 1440, h: 900 };
const EPS = 1e-6;
const PAD = 3; // default padding

const PRIORITIES = [PRIORITY.found, PRIORITY.constellation, PRIORITY.chrome, PRIORITY.numeral, PRIORITY.missing];

function makeScene(seed: number, nReq: number, nObs: number) {
  const rnd = mulberry32(seed);
  const between = (lo: number, hi: number) => lo + rnd() * (hi - lo);
  const obstacles: Obstacle[] = [];
  for (let i = 0; i < nObs; i++) {
    if (rnd() < 0.5) {
      obstacles.push({ kind: "rect", x: between(0, 1300), y: between(0, 800), w: between(20, 200), h: between(10, 120) });
    } else {
      obstacles.push({ kind: "circle", cx: between(0, 1440), cy: between(0, 900), r: between(10, 60) });
    }
  }
  const requests: LabelRequest[] = [];
  for (let i = 0; i < nReq; i++) {
    const m = rnd();
    const mode: LabelRequest["mode"] = m < 0.6 ? "around" : m < 0.85 ? "centered" : "fixed";
    requests.push({
      id: "L" + String(i).padStart(3, "0"),
      anchor: { x: between(0, 1440), y: between(0, 900) },
      w: between(30, 120),
      h: between(12, 24),
      priority: PRIORITIES[Math.floor(rnd() * PRIORITIES.length)] + Math.floor(rnd() * 20),
      anchorRadius: mode === "around" ? between(3, 10) : between(0, 4),
      mode,
      allowLeader: rnd() < 0.8,
    });
  }
  return { requests, obstacles };
}

// ---------- independent geometry (does not use the module's helpers) ----------

function isDisplaced(candidate: string): boolean {
  return !(candidate.startsWith("r0:") || candidate === "c" || candidate === "fixed");
}

function boxesSeparated(a: Rect, b: Rect, pad: number): boolean {
  return (
    a.x + a.w + pad <= b.x + EPS ||
    b.x + b.w + pad <= a.x + EPS ||
    a.y + a.h + pad <= b.y + EPS ||
    b.y + b.h + pad <= a.y + EPS
  );
}

function circleRectDist(cx: number, cy: number, r: Rect): number {
  const qx = Math.min(Math.max(cx, r.x), r.x + r.w);
  const qy = Math.min(Math.max(cy, r.y), r.y + r.h);
  return Math.hypot(cx - qx, cy - qy);
}

function segCircleDist(x1: number, y1: number, x2: number, y2: number, cx: number, cy: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((cx - x1) * dx + (cy - y1) * dy) / len2;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(cx - (x1 + t * dx), cy - (y1 + t * dy));
}

function strictRectOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w - EPS && a.x + a.w > b.x + EPS && a.y < b.y + b.h - EPS && a.y + a.h > b.y + EPS;
}

function onBoundary(px: number, py: number, r: Rect): boolean {
  const inX = px >= r.x - EPS && px <= r.x + r.w + EPS;
  const inY = py >= r.y - EPS && py <= r.y + r.h + EPS;
  const onX = Math.abs(px - r.x) < EPS || Math.abs(px - (r.x + r.w)) < EPS;
  const onY = Math.abs(py - r.y) < EPS || Math.abs(py - (r.y + r.h)) < EPS;
  return inX && inY && (onX || onY);
}

const box = (p: PlacedLabel): Rect => ({ x: p.x, y: p.y, w: p.w, h: p.h });

/** Full invariant check of one solve result. Collects violations (plain checks, one expect at the end: thousands of expect() calls are slow). Returns placed count. */
function checkInvariants(requests: LabelRequest[], obstacles: Obstacle[], bounds: Rect, res: { placed: PlacedLabel[]; dropped: string[] }) {
  const bad: string[] = [];
  const chk = (cond: boolean, msg: string) => { if (!cond) bad.push(msg); };
  const byId = new Map(requests.map((r) => [r.id, r]));
  // every request is either placed or dropped, exactly once
  const seen = new Set<string>();
  for (const p of res.placed) { chk(!seen.has(p.id), "dup " + p.id); seen.add(p.id); }
  for (const d of res.dropped) { chk(!seen.has(d), "dup " + d); seen.add(d); }
  chk(seen.size === requests.length, "placed+dropped != requests");

  for (let i = 0; i < res.placed.length; i++) {
    const p = res.placed[i];
    const req = byId.get(p.id)!;
    const b = box(p);
    const tag = p.id + "/" + p.candidate;
    chk(p.w === req.w && p.h === req.h && p.priority === req.priority, tag + " size/priority changed");
    // inside bounds
    chk(b.x >= bounds.x - EPS && b.y >= bounds.y - EPS && b.x + b.w <= bounds.x + bounds.w + EPS && b.y + b.h <= bounds.y + bounds.h + EPS, tag + " out of bounds");
    // obstacles
    for (const o of obstacles) {
      if (o.kind === "rect") chk(!strictRectOverlap(b, o), tag + " hits rect obstacle");
      else chk(circleRectDist(o.cx, o.cy, b) >= o.r - EPS, tag + " hits circle obstacle");
    }
    // anchor circles (radius + 1) of every request; own anchor exempt only for the undisplaced centred / fixed slot
    const displaced = isDisplaced(p.candidate);
    for (const other of requests) {
      if (other.id === p.id && !displaced && (req.mode === "centered" || req.mode === "fixed")) continue;
      chk(circleRectDist(other.anchor.x, other.anchor.y, b) >= other.anchorRadius + 1 - EPS, tag + " covers anchor of " + other.id);
    }
    // pairwise, with padding
    for (let j = i + 1; j < res.placed.length; j++) {
      chk(boxesSeparated(b, box(res.placed[j]), PAD), tag + " overlaps " + res.placed[j].id);
    }
    // leader iff displaced
    if (displaced) {
      chk(req.mode !== "fixed" && req.allowLeader !== false, tag + " displaced although not allowed");
      chk(p.leader !== null, tag + " displaced without leader");
      const L = p.leader;
      if (L) {
        chk(Math.abs(Math.hypot(L.x1 - req.anchor.x, L.y1 - req.anchor.y) - req.anchorRadius) <= 0.5, tag + " leader start off anchor edge");
        chk(onBoundary(L.x2, L.y2, b), tag + " leader end off box boundary");
        for (const q of res.placed) {
          if (q.id === p.id) continue;
          chk(!segmentIntersectsRect(L.x1, L.y1, L.x2, L.y2, box(q)), tag + " leader crosses box " + q.id);
        }
        for (const other of requests) {
          if (other.id === p.id) continue;
          chk(segCircleDist(L.x1, L.y1, L.x2, L.y2, other.anchor.x, other.anchor.y) >= other.anchorRadius + 1 - EPS, tag + " leader crosses anchor of " + other.id);
        }
      }
    } else {
      chk(p.leader === null, tag + " undisplaced with leader");
    }
  }
  expect(bad.slice(0, 5)).toEqual([]);
  return res.placed.length;
}

// ---------- helper functions ----------

describe("geometry helpers", () => {
  it("rectsOverlap respects padding", () => {
    const a: Rect = { x: 0, y: 0, w: 10, h: 10 };
    expect(rectsOverlap(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(rectsOverlap(a, { x: 10, y: 0, w: 10, h: 10 })).toBe(false); // touching is not overlap
    expect(rectsOverlap(a, { x: 12, y: 0, w: 10, h: 10 })).toBe(false);
    expect(rectsOverlap(a, { x: 12, y: 0, w: 10, h: 10 }, 3)).toBe(true); // gap 2 < padding 3
    expect(rectsOverlap(a, { x: 13, y: 0, w: 10, h: 10 }, 3)).toBe(false); // gap 3 == padding is fine
    expect(rectsOverlap(a, { x: 0, y: 40, w: 10, h: 10 }, 3)).toBe(false);
  });

  it("segmentIntersectsRect handles through, inside, miss and touch cases", () => {
    const r: Rect = { x: 10, y: 10, w: 20, h: 20 };
    expect(segmentIntersectsRect(0, 20, 40, 20, r)).toBe(true); // straight through
    expect(segmentIntersectsRect(15, 15, 25, 25, r)).toBe(true); // fully inside
    expect(segmentIntersectsRect(0, 0, 5, 5, r)).toBe(false); // short of it
    expect(segmentIntersectsRect(0, 0, 40, 0, r)).toBe(false); // parallel miss
    expect(segmentIntersectsRect(0, 40, 40, 0, r)).toBe(true); // diagonal through the corner area
    expect(segmentIntersectsRect(0, 5, 40, 5, r)).toBe(false);
    expect(segmentIntersectsRect(20, 0, 20, 10, r)).toBe(true); // touches the top edge
  });
});

// ---------- 1. no overlaps ----------

describe("solveLabels invariants", () => {
  it("1. 300 random scenes: no overlaps, in bounds, off obstacles/anchors, leaders only when displaced", () => {
    let requested = 0;
    let placedTotal = 0;
    let leaders = 0;
    for (let s = 0; s < 300; s++) {
      const rnd = mulberry32(1000 + s);
      const nReq = 20 + Math.floor(rnd() * 131); // 20..150
      const nObs = Math.floor(rnd() * 31);
      const { requests, obstacles } = makeScene(5000 + s, nReq, nObs);
      const res = solveLabels(requests, obstacles, BOUNDS);
      requested += nReq;
      placedTotal += checkInvariants(requests, obstacles, BOUNDS, res);
      leaders += res.placed.filter((p) => p.leader).length;
    }
    // the solver has to actually place things (an empty result would pass every pairwise check)
    expect(placedTotal / requested).toBeGreaterThan(0.6);
    expect(leaders).toBeGreaterThan(0); // the displacement path was exercised
  });

  // ---------- 2. priorities ----------

  it("2. higher priority wins the only available space, whatever the input order", () => {
    // Bounds so tight that the east slot of ring 0 is the one and only valid candidate.
    const bounds: Rect = { x: 0, y: 0, w: 80, h: 20 };
    const base = { anchor: { x: 10, y: 10 }, w: 60, h: 16, anchorRadius: 2, mode: "around" as const };
    const hi: LabelRequest = { ...base, id: "hi", priority: PRIORITY.found };
    const lo: LabelRequest = { ...base, id: "lo", priority: PRIORITY.missing };
    for (const order of [[hi, lo], [lo, hi]]) {
      const res = solveLabels(order, [], bounds);
      expect(res.placed.map((p) => p.id)).toEqual(["hi"]);
      expect(res.placed[0].candidate).toBe("r0:E");
      expect(res.dropped).toEqual(["lo"]);
    }
  });

  it("2b. overlapping fixed labels: the highest priority survives; ties break by id ascending", () => {
    // Anchors are placed so that no box covers another label's anchor, but all three boxes overlap each other.
    const spots = [{ id: "a", x: 200, y: 200 }, { id: "b", x: 245, y: 200 }, { id: "c", x: 222, y: 215 }];
    const mk = (prio: Record<string, number>) =>
      spots.map((s) => ({ id: s.id, anchor: { x: s.x, y: s.y }, w: 80, h: 20, priority: prio[s.id], anchorRadius: 0, mode: "fixed" as const }));
    const res = solveLabels(mk({ a: 100, b: 300, c: 200 }), [], BOUNDS);
    expect(res.placed.map((p) => p.id)).toEqual(["b"]);
    expect(res.dropped).toEqual(["c", "a"]);

    const res2 = solveLabels(mk({ a: 300, b: 300, c: 300 }).reverse(), [], BOUNDS);
    expect(res2.placed.map((p) => p.id)).toEqual(["a"]);
    expect(res2.dropped.sort()).toEqual(["b", "c"]);
  });

  // ---------- 3. ring 0 ----------

  it("3. isolated around label sits at r0:E with no leader; prefer reorders ring 0", () => {
    const req: LabelRequest = { id: "x", anchor: { x: 700, y: 400 }, w: 80, h: 20, priority: 300, anchorRadius: 6, mode: "around" };
    const res = solveLabels([req], [], BOUNDS);
    expect(res.dropped).toEqual([]);
    expect(res.placed).toHaveLength(1);
    const p = res.placed[0];
    expect(p.candidate).toBe("r0:E");
    expect(p.leader).toBeNull();
    expect(p.x).toBeCloseTo(700 + 6 + 6, 6); // anchor + radius + default gap
    expect(p.y).toBeCloseTo(400 - 10, 6); // vertically centred on the anchor
    expect(p.priority).toBe(300);

    const resW = solveLabels([{ ...req, prefer: ["W"] }], [], BOUNDS);
    expect(resW.placed[0].candidate).toBe("r0:W");
    expect(resW.placed[0].leader).toBeNull();
    expect(resW.placed[0].x).toBeCloseTo(700 - 12 - 80, 6);

    const resN = solveLabels([{ ...req, prefer: ["N", "S"] }], [], BOUNDS);
    expect(resN.placed[0].candidate).toBe("r0:N");
    expect(resN.placed[0].y).toBeCloseTo(400 - 12 - 20, 6);
  });

  // ---------- 4 / 5. displacement ----------

  // A disc obstacle around the anchor that swallows every ring-0 slot but leaves ring 1 free.
  const blockRing0: Obstacle[] = [{ kind: "circle", cx: 700, cy: 400, r: 6 + 6 + 4 }];

  it("4. with ring 0 blocked the label lands on ring >= 1 with a leader from the anchor edge to the box", () => {
    const req: LabelRequest = { id: "x", anchor: { x: 700, y: 400 }, w: 80, h: 20, priority: 300, anchorRadius: 6, mode: "around" };
    const res = solveLabels([req], blockRing0, BOUNDS);
    expect(res.dropped).toEqual([]);
    const p = res.placed[0];
    const ring = Number(/^r(\d):/.exec(p.candidate)![1]);
    expect(ring).toBeGreaterThanOrEqual(1);
    expect(p.leader).not.toBeNull();
    const L = p.leader!;
    expect(Math.abs(Math.hypot(L.x1 - 700, L.y1 - 400) - 6)).toBeLessThanOrEqual(0.5);
    expect(onBoundary(L.x2, L.y2, box(p))).toBe(true);
    // the leader is a real line, not a point
    expect(Math.hypot(L.x2 - L.x1, L.y2 - L.y1)).toBeGreaterThan(1);
  });

  it("5. allowLeader false with the same blocked scene: dropped", () => {
    const req: LabelRequest = { id: "x", anchor: { x: 700, y: 400 }, w: 80, h: 20, priority: 300, anchorRadius: 6, mode: "around", allowLeader: false };
    const res = solveLabels([req], blockRing0, BOUNDS);
    expect(res.placed).toEqual([]);
    expect(res.dropped).toEqual(["x"]);
    // centred mode too: blocked centred slot, no leader allowed -> dropped
    const c: LabelRequest = { id: "c", anchor: { x: 700, y: 400 }, w: 80, h: 20, priority: 300, anchorRadius: 0, mode: "centered", allowLeader: false };
    const cres = solveLabels([c], [{ kind: "rect", x: 690, y: 395, w: 20, h: 10 }], BOUNDS);
    expect(cres.dropped).toEqual(["c"]);
    // ... but with leaders allowed it is displaced
    const cres2 = solveLabels([{ ...c, allowLeader: true }], [{ kind: "rect", x: 690, y: 395, w: 20, h: 10 }], BOUNDS);
    expect(cres2.placed).toHaveLength(1);
    expect(cres2.placed[0].candidate).toMatch(/^c:\d:\d$/);
    expect(cres2.placed[0].leader).not.toBeNull();
  });

  // ---------- 6. fixed ----------

  it("6. fixed mode: centred on the anchor when it fits; dropped when a higher-priority label holds the spot", () => {
    const f: LabelRequest = { id: "title", anchor: { x: 720, y: 60 }, w: 300, h: 40, priority: PRIORITY.chrome, anchorRadius: 0, mode: "fixed" };
    const res = solveLabels([f], [], BOUNDS);
    expect(res.placed).toHaveLength(1);
    expect(res.placed[0].candidate).toBe("fixed");
    expect(res.placed[0].leader).toBeNull();
    expect(res.placed[0].x).toBeCloseTo(720 - 150, 6);
    expect(res.placed[0].y).toBeCloseTo(60 - 20, 6);

    const blocker: LabelRequest = { id: "found", anchor: { x: 720, y: 88 }, w: 100, h: 20, priority: PRIORITY.found, anchorRadius: 0, mode: "fixed" };
    const res2 = solveLabels([f, blocker], [], BOUNDS);
    expect(res2.placed.map((p) => p.id)).toEqual(["found"]);
    expect(res2.dropped).toEqual(["title"]);

    // outside the bounds: dropped
    const edge = solveLabels([{ ...f, anchor: { x: 10, y: 60 } }], [], BOUNDS);
    expect(edge.dropped).toEqual(["title"]);
  });

  // ---------- 7. hint ----------

  it("7. a valid hint wins even if earlier candidates are valid; an invalid hint falls back to normal order", () => {
    const req: LabelRequest = { id: "x", anchor: { x: 700, y: 400 }, w: 80, h: 20, priority: 300, anchorRadius: 6, mode: "around" };
    const w = solveLabels([{ ...req, hint: "r0:W" }], [], BOUNDS);
    expect(w.placed[0].candidate).toBe("r0:W");

    const ring2 = solveLabels([{ ...req, hint: "r2:5" }], [], BOUNDS);
    expect(ring2.placed[0].candidate).toBe("r2:5");
    expect(ring2.placed[0].leader).not.toBeNull();

    // block the W slot (box x 608..688, y 390..410) -> the hint is invalid -> normal order gives E
    const blockW: Obstacle[] = [{ kind: "rect", x: 600, y: 385, w: 90, h: 30 }];
    const fallback = solveLabels([{ ...req, hint: "r0:W" }], blockW, BOUNDS);
    expect(fallback.placed[0].candidate).toBe("r0:E");
    expect(fallback.placed[0].leader).toBeNull();

    // junk hint is ignored
    const junk = solveLabels([{ ...req, hint: "nope" }], [], BOUNDS);
    expect(junk.placed[0].candidate).toBe("r0:E");

    // a hint cannot smuggle in a leader candidate when leaders are not allowed
    const noLeader = solveLabels([{ ...req, hint: "r1:0", allowLeader: false }], [], BOUNDS);
    expect(noLeader.placed[0].candidate).toBe("r0:E");

    // a hint cannot override a higher-priority label that already holds the spot
    const holder: LabelRequest = { id: "holder", anchor: { x: 700, y: 400 }, w: 80, h: 20, priority: 900, anchorRadius: 6, mode: "around", prefer: ["W"] };
    const contested = solveLabels([holder, { ...req, hint: "r0:W" }], [], BOUNDS);
    const mine = contested.placed.find((p) => p.id === "x")!;
    expect(mine.candidate).not.toBe("r0:W");
    expect(contested.placed.find((p) => p.id === "holder")!.candidate).toBe("r0:W");
  });

  // ---------- 8. determinism ----------

  it("8. same input twice is deep-equal, input is not mutated, and input order does not matter", () => {
    for (let s = 0; s < 20; s++) {
      const { requests, obstacles } = makeScene(9000 + s, 80, 20);
      const snapshot = JSON.stringify({ requests, obstacles });
      const a = solveLabels(requests, obstacles, BOUNDS);
      const b = solveLabels(requests, obstacles, BOUNDS);
      expect(a.placed.length).toBeGreaterThan(20); // not vacuous
      expect(b).toEqual(a);
      expect(JSON.stringify({ requests, obstacles })).toBe(snapshot);

      const rnd = mulberry32(777 + s);
      const shuffled = requests.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const shuffledObs = obstacles.slice().reverse();
      const c = solveLabels(shuffled, shuffledObs, BOUNDS);
      expect(c).toEqual(a);
    }
  });

  // ---------- 9. performance ----------

  it("9. performance smoke: 200 requests + 30 obstacles solve in well under 25 ms", () => {
    const { requests, obstacles } = makeScene(424242, 200, 30);
    for (let i = 0; i < 5; i++) solveLabels(requests, obstacles, BOUNDS); // warm-up (JIT)
    expect(solveLabels(requests, obstacles, BOUNDS).placed.length).toBeGreaterThan(100); // doing real work
    const times: number[] = [];
    for (let i = 0; i < 25; i++) {
      const t0 = performance.now();
      solveLabels(requests, obstacles, BOUNDS);
      times.push(performance.now() - t0);
    }
    times.sort((x, y) => x - y);
    const median = times[Math.floor(times.length / 2)];
    // eslint-disable-next-line no-console
    console.log(`[labelSolver perf] 200 req + 30 obs: median ${median.toFixed(3)} ms, min ${times[0].toFixed(3)} ms, max ${times[times.length - 1].toFixed(3)} ms`);
    expect(median).toBeLessThan(25);
  });
});

describe("far candidates (extra)", () => {
  it("places a label in an explicit far slot with a leader when every built-in slot is blocked", () => {
    const anchor = { x: 400, y: 300 };
    const block: Obstacle[] = [{ kind: "rect", x: 300, y: 200, w: 200, h: 200 }];
    const req: LabelRequest = {
      id: "c:p",
      anchor,
      w: 120,
      h: 18,
      priority: PRIORITY.constellation,
      anchorRadius: 1,
      mode: "centered",
      extra: [
        { x: 340, y: 210, key: "inside" },
        { x: 560, y: 291, key: "R0" },
      ],
    };
    const { placed, dropped } = solveLabels([req], block, { x: 0, y: 0, w: 1000, h: 800 });
    expect(dropped).toEqual([]);
    expect(placed[0].candidate).toBe("x:R0");
    expect(placed[0].x).toBe(560);
    expect(placed[0].leader).not.toBeNull();
  });

  it("ignores extra candidates when leaders are not allowed", () => {
    const req: LabelRequest = {
      id: "c:q",
      anchor: { x: 400, y: 300 },
      w: 120,
      h: 18,
      priority: PRIORITY.constellation,
      anchorRadius: 1,
      mode: "centered",
      allowLeader: false,
      extra: [{ x: 560, y: 291, key: "R0" }],
    };
    const { placed } = solveLabels([req], [{ kind: "rect", x: 300, y: 200, w: 200, h: 200 }], { x: 0, y: 0, w: 1000, h: 800 });
    expect(placed).toHaveLength(0);
  });
});

describe("extra candidates without leaders", () => {
  it("onlyExtra uses just the given slots, and leader:false slots need no leader", () => {
    const req: LabelRequest = {
      id: "c:edge",
      anchor: { x: 400, y: 300 },
      w: 100,
      h: 16,
      priority: PRIORITY.constellation,
      anchorRadius: 1,
      mode: "centered",
      onlyExtra: true,
      allowLeader: false,
      extra: [
        { x: 350, y: 292, key: "covers-anchor", leader: false },
        { x: 350, y: 320, key: "below", leader: false },
        { x: 600, y: 300, key: "far", leader: true },
      ],
    };
    const { placed } = solveLabels([req], [{ kind: "rect", x: 340, y: 285, w: 130, h: 30 }], { x: 0, y: 0, w: 1000, h: 800 });
    expect(placed[0].candidate).toBe("x:below");
    expect(placed[0].leader).toBeNull();
  });
});
