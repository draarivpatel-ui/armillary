// Deterministic greedy label solver. Pure: no clocks, no randomness, no mutation of inputs.
// Labels are placed in priority order (highest first, ties by id); each takes the first valid
// candidate from a fixed candidate list, or is dropped.

export interface Rect { x: number; y: number; w: number; h: number }
export interface Circle { cx: number; cy: number; r: number }
export type Obstacle = ({ kind: "rect" } & Rect) | ({ kind: "circle" } & Circle);

export const PRIORITY = { found: 500, constellation: 400, chrome: 300, numeral: 200, missing: 100 } as const;

export type Slot = "E" | "W" | "NE" | "SE" | "NW" | "SW" | "N" | "S";

export interface LabelRequest {
  id: string;
  anchor: { x: number; y: number };
  w: number; h: number;
  priority: number;
  anchorRadius: number;
  mode: "around" | "centered" | "fixed";
  prefer?: Slot[];
  allowLeader?: boolean;
  hint?: string;
  /**
   * Extra candidates (box top-left), tried after the built-in ones (or instead of them with
   * `onlyExtra`). Displaced with a leader unless the candidate says `leader: false`.
   */
  extra?: Array<{ x: number; y: number; key: string; leader?: boolean }>;
  onlyExtra?: boolean;
}
export interface PlacedLabel {
  id: string; x: number; y: number; w: number; h: number;
  candidate: string;
  leader: null | { x1: number; y1: number; x2: number; y2: number };
  priority: number;
}
export interface SolveOptions { gap?: number; step?: number; padding?: number }
export interface SolveResult { placed: PlacedLabel[]; dropped: string[] }

// ---------- public geometry helpers ----------

/** True when the boxes are closer than `padding` (touching with padding 0 is not an overlap). */
export function rectsOverlap(a: Rect, b: Rect, padding = 0): boolean {
  return (
    a.x < b.x + b.w + padding &&
    a.x + a.w + padding > b.x &&
    a.y < b.y + b.h + padding &&
    a.y + a.h + padding > b.y
  );
}

/** Closed-rectangle segment test (Liang-Barsky): touching an edge counts as intersecting. */
export function segmentIntersectsRect(x1: number, y1: number, x2: number, y2: number, r: Rect): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - r.x, r.x + r.w - x1, y1 - r.y, r.y + r.h - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return true;
}

// ---------- candidate tables ----------

const SLOTS: readonly Slot[] = ["E", "W", "NE", "SE", "NW", "SW", "N", "S"];
const DIR_X = [1, -1, 1, 1, -1, -1, 0, 0];
const DIR_Y = [0, 0, -1, 1, -1, 1, -1, 1];
const DEFAULT_ORDER: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7];

const RING_SLOTS = 16;
const MAX_RING = 3;
const CENTER_DISTANCES = 3;

const R0_KEYS = SLOTS.map((s) => "r0:" + s);
const RING_KEYS: string[][] = [];
for (let k = 1; k <= MAX_RING; k++) {
  const row: string[] = [];
  for (let i = 0; i < RING_SLOTS; i++) row.push("r" + k + ":" + i);
  RING_KEYS.push(row);
}
const C_KEYS: string[][] = [];
for (let k = 1; k <= CENTER_DISTANCES; k++) {
  const row: string[] = [];
  for (let d = 0; d < 8; d++) row.push("c:" + k + ":" + d);
  C_KEYS.push(row);
}

// Ring directions scaled so the larger component is 1: the box edge (or corner) then touches the
// ring point instead of the box centre sitting on it.
const RING_UX: number[] = [];
const RING_UY: number[] = [];
for (let i = 0; i < RING_SLOTS; i++) {
  const c = Math.cos((i * Math.PI * 2) / RING_SLOTS);
  const s = Math.sin((i * Math.PI * 2) / RING_SLOTS);
  const m = Math.max(Math.abs(c), Math.abs(s));
  RING_UX.push(Math.abs(c / m) > 1 - 1e-12 ? Math.sign(c) : c / m);
  RING_UY.push(Math.abs(s / m) > 1 - 1e-12 ? Math.sign(s) : s / m);
}

const AROUND_ALL = 8 + MAX_RING * RING_SLOTS;
const CENTERED_ALL = 1 + CENTER_DISTANCES * 8;

function ring0Order(prefer: Slot[] | undefined): readonly number[] {
  if (!prefer || prefer.length === 0) return DEFAULT_ORDER;
  const order: number[] = [];
  for (const s of prefer) {
    const i = SLOTS.indexOf(s);
    if (i >= 0 && order.indexOf(i) < 0) order.push(i);
  }
  for (const i of DEFAULT_ORDER) if (order.indexOf(i) < 0) order.push(i);
  return order;
}

// ---------- uniform grid ----------

class Grid {
  private cols: number;
  private rows: number;
  private cells: Array<number[] | undefined>;
  constructor(private bx: number, private by: number, bw: number, bh: number, private cell: number) {
    this.cols = Math.max(1, Math.ceil(bw / cell));
    this.rows = Math.max(1, Math.ceil(bh / cell));
    this.cells = new Array(this.cols * this.rows);
  }
  private cx(x: number): number {
    const c = Math.floor((x - this.bx) / this.cell);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }
  private cy(y: number): number {
    const c = Math.floor((y - this.by) / this.cell);
    return c < 0 ? 0 : c >= this.rows ? this.rows - 1 : c;
  }
  add(id: number, x0: number, y0: number, x1: number, y1: number): void {
    const a = this.cx(x0), b = this.cx(x1), c = this.cy(y0), d = this.cy(y1);
    for (let j = c; j <= d; j++) {
      for (let i = a; i <= b; i++) {
        const k = j * this.cols + i;
        const arr = this.cells[k];
        if (arr) arr.push(id);
        else this.cells[k] = [id];
      }
    }
  }
  /** True as soon as `pred` returns true for any item registered in the cells touched by the box. */
  some(x0: number, y0: number, x1: number, y1: number, pred: (id: number) => boolean): boolean {
    const a = this.cx(x0), b = this.cx(x1), c = this.cy(y0), d = this.cy(y1);
    for (let j = c; j <= d; j++) {
      for (let i = a; i <= b; i++) {
        const arr = this.cells[j * this.cols + i];
        if (arr) for (let n = 0; n < arr.length; n++) if (pred(arr[n])) return true;
      }
    }
    return false;
  }
}

const CELL = 64;

// ---------- solver ----------

interface Candidate { x: number; y: number; key: string; displaced: boolean }

function baseCount(req: LabelRequest): number {
  if (req.onlyExtra) return 0;
  const leaders = req.allowLeader !== false;
  if (req.mode === "fixed") return 1;
  if (req.mode === "centered") return leaders ? CENTERED_ALL : 1;
  return leaders ? AROUND_ALL : 8;
}

function candidateCount(req: LabelRequest): number {
  if (!req.extra) return baseCount(req);
  const usable = req.allowLeader !== false ? req.extra.length : req.extra.filter((e) => e.leader === false).length;
  return baseCount(req) + (req.allowLeader !== false ? usable : usable);
}

function candidateAt(req: LabelRequest, idx: number, order: readonly number[], gap: number, step: number): Candidate {
  const base = baseCount(req);
  if (idx >= base && req.extra) {
    const list = req.allowLeader !== false ? req.extra : req.extra.filter((x) => x.leader === false);
    const e = list[idx - base];
    return { x: e.x, y: e.y, key: "x:" + e.key, displaced: e.leader !== false };
  }
  const ax = req.anchor.x;
  const ay = req.anchor.y;
  const w = req.w;
  const h = req.h;
  if (req.mode === "fixed") {
    return { x: ax - w / 2, y: ay - h / 2, key: "fixed", displaced: false };
  }
  if (req.mode === "centered") {
    if (idx === 0) return { x: ax - w / 2, y: ay - h / 2, key: "c", displaced: false };
    const k = Math.floor((idx - 1) / 8) + 1;
    const d = (idx - 1) % 8;
    const m = req.anchorRadius + gap + (k - 1) * step;
    return {
      x: ax + DIR_X[d] * (w / 2 + m) - w / 2,
      y: ay + DIR_Y[d] * (h / 2 + m) - h / 2,
      key: C_KEYS[k - 1][d],
      displaced: true,
    };
  }
  // around
  if (idx < 8) {
    const s = order[idx];
    const dx = DIR_X[s];
    const dy = DIR_Y[s];
    const d0 = req.anchorRadius + gap;
    const o = dx !== 0 && dy !== 0 ? d0 * Math.SQRT1_2 : d0;
    const x = dx > 0 ? ax + o : dx < 0 ? ax - o - w : ax - w / 2;
    const y = dy > 0 ? ay + o : dy < 0 ? ay - o - h : ay - h / 2;
    return { x, y, key: R0_KEYS[s], displaced: false };
  }
  const k = Math.floor((idx - 8) / RING_SLOTS) + 1;
  const i = (idx - 8) % RING_SLOTS;
  const dist = req.anchorRadius + gap + k * step;
  const ux = RING_UX[i];
  const uy = RING_UY[i];
  const px = ax + dist * Math.cos((i * Math.PI * 2) / RING_SLOTS);
  const py = ay + dist * Math.sin((i * Math.PI * 2) / RING_SLOTS);
  return {
    x: px + ux * (w / 2) - w / 2,
    y: py + uy * (h / 2) - h / 2,
    key: RING_KEYS[k - 1][i],
    displaced: true,
  };
}

function compareRequests(a: LabelRequest, b: LabelRequest): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Static items: obstacles (kind 0 rect, 1 circle) and request anchors (kind 2, owner = request index).
interface StaticItem { kind: 0 | 1 | 2; a: number; b: number; c: number; d: number; owner: number }

function circleHitsRect(cx: number, cy: number, r: number, x: number, y: number, w: number, h: number): boolean {
  const qx = cx < x ? x : cx > x + w ? x + w : cx;
  const qy = cy < y ? y : cy > y + h ? y + h : cy;
  const dx = cx - qx;
  const dy = cy - qy;
  return dx * dx + dy * dy < r * r;
}

function segmentHitsCircle(x1: number, y1: number, x2: number, y2: number, cx: number, cy: number, r: number): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((cx - x1) * dx + (cy - y1) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = cx - (x1 + t * dx);
  const ey = cy - (y1 + t * dy);
  return ex * ex + ey * ey < r * r;
}

export function solveLabels(
  requests: LabelRequest[],
  obstacles: Obstacle[],
  bounds: Rect,
  options: SolveOptions = {},
): SolveResult {
  const gap = options.gap ?? 6;
  const step = options.step ?? 14;
  const padding = options.padding ?? 3;

  const sorted = requests.slice().sort(compareRequests);
  const n = sorted.length;

  // Static grid: obstacles and every request's anchor disc (radius + 1).
  const items: StaticItem[] = [];
  const staticGrid = new Grid(bounds.x, bounds.y, bounds.w, bounds.h, CELL);
  for (const o of obstacles) {
    if (o.kind === "rect") {
      items.push({ kind: 0, a: o.x, b: o.y, c: o.w, d: o.h, owner: -1 });
      staticGrid.add(items.length - 1, o.x, o.y, o.x + o.w, o.y + o.h);
    } else {
      items.push({ kind: 1, a: o.cx, b: o.cy, c: o.r, d: 0, owner: -1 });
      staticGrid.add(items.length - 1, o.cx - o.r, o.cy - o.r, o.cx + o.r, o.cy + o.r);
    }
  }
  for (let i = 0; i < n; i++) {
    const r = sorted[i];
    const rad = r.anchorRadius + 1;
    items.push({ kind: 2, a: r.anchor.x, b: r.anchor.y, c: rad, d: 0, owner: i });
    staticGrid.add(items.length - 1, r.anchor.x - rad, r.anchor.y - rad, r.anchor.x + rad, r.anchor.y + rad);
  }

  const placed: PlacedLabel[] = [];
  const dropped: string[] = [];
  const boxGrid = new Grid(bounds.x, bounds.y, bounds.w, bounds.h, CELL);
  const leaderGrid = new Grid(bounds.x, bounds.y, bounds.w, bounds.h, CELL);
  // Leaders of placed labels, indexed by placed index (null when none).
  const leaders: Array<{ x1: number; y1: number; x2: number; y2: number } | null> = [];

  const bx0 = bounds.x;
  const by0 = bounds.y;
  const bx1 = bounds.x + bounds.w;
  const by1 = bounds.y + bounds.h;

  for (let ri = 0; ri < n; ri++) {
    const req = sorted[ri];
    const order = req.mode === "around" ? ring0Order(req.prefer) : DEFAULT_ORDER;
    const count = candidateCount(req);
    const ownAnchorExempt = req.mode !== "around";

    const tryIdx = (idx: number): PlacedLabel | null => {
      const cand = candidateAt(req, idx, order, gap, step);
      const x = cand.x;
      const y = cand.y;
      const w = req.w;
      const h = req.h;
      const x1 = x + w;
      const y1 = y + h;
      if (x < bx0 || y < by0 || x1 > bx1 || y1 > by1) return null;

      // obstacles + anchor discs
      const exempt = ownAnchorExempt && !cand.displaced;
      if (
        staticGrid.some(x, y, x1, y1, (id) => {
          const it = items[id];
          if (it.kind === 0) return x < it.a + it.c && x1 > it.a && y < it.b + it.d && y1 > it.b;
          if (it.kind === 2 && exempt && it.owner === ri) return false;
          return circleHitsRect(it.a, it.b, it.c, x, y, w, h);
        })
      ) return null;

      // placed boxes, with padding
      const me: Rect = { x, y, w, h };
      if (
        boxGrid.some(x - padding, y - padding, x1 + padding, y1 + padding, (id) => rectsOverlap(me, placed[id], padding))
      ) return null;

      // already-placed leaders must not cross the new box
      if (
        leaderGrid.some(x, y, x1, y1, (id) => {
          const l = leaders[id]!;
          return segmentIntersectsRect(l.x1, l.y1, l.x2, l.y2, me);
        })
      ) return null;

      let leader: PlacedLabel["leader"] = null;
      if (cand.displaced) {
        const ax = req.anchor.x;
        const ay = req.anchor.y;
        const qx = ax < x ? x : ax > x1 ? x1 : ax;
        const qy = ay < y ? y : ay > y1 ? y1 : ay;
        const len = Math.hypot(qx - ax, qy - ay);
        if (len <= req.anchorRadius) return null; // anchor inside the box: nothing to point from
        const sx = ax + ((qx - ax) / len) * req.anchorRadius;
        const sy = ay + ((qy - ay) / len) * req.anchorRadius;
        leader = { x1: sx, y1: sy, x2: qx, y2: qy };
        const lx0 = Math.min(sx, qx), lx1 = Math.max(sx, qx);
        const ly0 = Math.min(sy, qy), ly1 = Math.max(sy, qy);
        // must not cross any placed box
        if (
          boxGrid.some(lx0, ly0, lx1, ly1, (id) => segmentIntersectsRect(sx, sy, qx, qy, placed[id]))
        ) return null;
        // must not cross any other request's anchor disc
        if (
          staticGrid.some(lx0, ly0, lx1, ly1, (id) => {
            const it = items[id];
            if (it.kind !== 2 || it.owner === ri) return false;
            return segmentHitsCircle(sx, sy, qx, qy, it.a, it.b, it.c);
          })
        ) return null;
      }
      return { id: req.id, x, y, w, h, candidate: cand.key, leader, priority: req.priority };
    };

    let result: PlacedLabel | null = null;
    let hintIdx = -1;
    if (req.hint !== undefined) {
      for (let i = 0; i < count; i++) {
        if (candidateAt(req, i, order, gap, step).key === req.hint) { hintIdx = i; break; }
      }
      if (hintIdx >= 0) result = tryIdx(hintIdx);
    }
    if (!result) {
      for (let i = 0; i < count; i++) {
        if (i === hintIdx) continue;
        result = tryIdx(i);
        if (result) break;
      }
    }

    if (result) {
      const id = placed.length;
      placed.push(result);
      leaders.push(result.leader);
      boxGrid.add(id, result.x, result.y, result.x + result.w, result.y + result.h);
      if (result.leader) {
        const l = result.leader;
        leaderGrid.add(id, Math.min(l.x1, l.x2), Math.min(l.y1, l.y2), Math.max(l.x1, l.x2), Math.max(l.y1, l.y2));
      }
    } else {
      dropped.push(req.id);
    }
  }

  return { placed, dropped };
}
