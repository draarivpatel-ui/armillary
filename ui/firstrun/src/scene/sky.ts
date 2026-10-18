/**
 * The sky: a static three-layer background field, and the deterministic place of every catalogue
 * agent on the celestial sphere.
 */
import { hash01, hashString, prng } from "../math/ease";
import { mulMV, normalize, rotateAbout, type M3, type V3 } from "../math/vec";
import { AXIS_DIR, STAR_RADIUS } from "./instrument";

export interface FieldStar {
  /** Normalised screen position, 0..1 (wraps under parallax). */
  x: number;
  y: number;
  /** Radius in CSS px at zoom 1. */
  size: number;
  /** Base brightness 0..1. */
  mag: number;
  /** Colour temperature -1 (blue) .. 1 (warm). */
  temp: number;
  /** Twinkle phase and speed (cycles per second). */
  phase: number;
  speed: number;
}

export interface FieldLayer {
  stars: FieldStar[];
  /** Parallax depth: 0 far .. 1 near. Near layers move more under the dolly. */
  depth: number;
}

const LAYER_COUNTS = [1500, 460, 70] as const;

export function buildField(seed = 1729): FieldLayer[] {
  const layers: FieldLayer[] = [];
  for (let L = 0; L < 3; L++) {
    const rand = prng(seed + L * 7919);
    const stars: FieldStar[] = [];
    for (let i = 0; i < LAYER_COUNTS[L]; i++) {
      // Power-law brightness: most stars faint, a few bright.
      const u = rand();
      const mag = L === 0 ? 0.12 + Math.pow(u, 3.2) * 0.55 : L === 1 ? 0.22 + Math.pow(u, 2.4) * 0.65 : 0.55 + Math.pow(u, 1.6) * 0.45;
      const size = L === 0 ? 0.45 + Math.pow(rand(), 3) * 0.55 : L === 1 ? 0.7 + Math.pow(rand(), 2.2) * 0.8 : 1.1 + Math.pow(rand(), 1.5) * 1.1;
      // A faint galactic band: denser along a tilted diagonal for the far and mid layers.
      let x = rand();
      let y = rand();
      if (L < 2 && rand() < 0.38) {
        const s = rand();
        const off = (rand() + rand() + rand() - 1.5) * 0.11;
        x = s;
        y = 0.18 + s * 0.62 + off;
        if (y < 0 || y > 1) y = rand();
      }
      stars.push({ x, y, size, mag, temp: rand() * 2 - 1, phase: rand(), speed: 0.08 + rand() * (L === 2 ? 0.35 : 0.22) });
    }
    layers.push({ stars, depth: L / 2 });
  }
  return layers;
}

export interface CatalogueStar {
  id: string;
  /** Position on the star sphere at sky spin 0, instrument space. */
  p0: V3;
}

/**
 * Places every catalogue entry on the camera-facing cap of the star sphere, using a sunflower
 * spread in view space (even on screen), ordered by a hash of the id so families mix and the
 * layout is stable for a given catalogue. Candidates that would sit under a front ring band, on the
 * polar axis or on the small central globe are skipped.
 *
 * `view` is the camera rotation during the scan; `blocked(viewPoint)` returns true for points that
 * must stay clear (computed by the caller from the ring geometry).
 */
export function placeCatalogue(ids: string[], view: M3, blocked: (viewPoint: V3) => boolean): CatalogueStar[] {
  const n = ids.length;
  if (n === 0) return [];
  const order = ids.slice().sort((a, b) => hashString(a) - hashString(b) || (a < b ? -1 : 1));
  // Inverse of a rotation matrix is its transpose.
  const inv: M3 = [view[0], view[3], view[6], view[1], view[4], view[7], view[2], view[5], view[8]];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const capR = 0.9;
  const out: CatalogueStar[] = [];
  const pool = Math.ceil(n * 2.2) + 12;
  let k = 0;
  for (const id of order) {
    let placed: V3 | null = null;
    while (k < pool && !placed) {
      const i = k++;
      const r = capR * Math.sqrt((i + 0.5) / pool);
      const a = i * golden;
      const jr = (hash01(id, 1) - 0.5) * 0.035;
      const ja = (hash01(id, 2) - 0.5) * 0.12;
      const u = (r + jr) * Math.cos(a + ja);
      const v = (r + jr) * Math.sin(a + ja) * 0.92;
      const zz = Math.sqrt(Math.max(0, 1 - u * u - v * v));
      const vp: V3 = [u, v, zz];
      if (blocked(vp)) continue;
      placed = vp;
    }
    if (!placed) {
      // Pool exhausted (only for pathological blockers): fall back to the next spiral point.
      const i = k++;
      const r = capR * Math.sqrt(((i % pool) + 0.5) / pool);
      const a = i * golden;
      placed = [r * Math.cos(a), r * Math.sin(a), Math.sqrt(Math.max(0, 1 - r * r))];
    }
    const world = normalize(mulMV(inv, placed));
    out.push({ id, p0: [world[0] * STAR_RADIUS, world[1] * STAR_RADIUS, world[2] * STAR_RADIUS] });
  }
  // Restore catalogue order for callers.
  const byId = new Map(out.map((s) => [s.id, s]));
  return ids.map((id) => byId.get(id)!);
}

/** A catalogue star at sky spin `spin`. */
export function starAt(s: CatalogueStar, spin: number): V3 {
  return spin === 0 ? s.p0 : rotateAbout(s.p0, AXIS_DIR, spin);
}
