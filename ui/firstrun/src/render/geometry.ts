/**
 * Geometry for the WebGL2 renderer, built once: ring bands as a chamfered rectangular section swept
 * around the circle (flat-shaded faces so the chamfers read as bevel highlights), and lathe-turned
 * parts (polar axis with finials, the small central globe).
 */
import type { RingSpec } from "../scene/instrument";

export interface RingMesh {
  /** Interleaved: theta, rho, nu, nRho, nNu, across, graduated (7 floats). */
  data: Float32Array;
  indices: Uint32Array;
}

export const RING_STRIDE = 7;
const SEGMENTS = 360;

/** Cross-section corners (rho, nu), counter-clockwise, chamfered. */
function section(spec: RingSpec): Array<[number, number]> {
  const hr = spec.profile === "washer" ? spec.width / 2 : spec.thickness / 2;
  const hn = spec.profile === "washer" ? spec.thickness / 2 : spec.width / 2;
  const c = Math.min(hr, hn) * 0.55;
  return [
    [hr, -hn + c],
    [hr, hn - c],
    [hr - c, hn],
    [-hr + c, hn],
    [-hr, hn - c],
    [-hr, -hn + c],
    [-hr + c, -hn],
    [hr - c, -hn],
  ];
}

export function buildRingMesh(spec: RingSpec): RingMesh {
  const pts = section(spec);
  const verts: number[] = [];
  const idx: number[] = [];
  const hr = spec.profile === "washer" ? spec.width / 2 : spec.thickness / 2;
  const hn = spec.profile === "washer" ? spec.thickness / 2 : spec.width / 2;
  for (let e = 0; e < pts.length; e++) {
    const a = pts[e];
    const b = pts[(e + 1) % pts.length];
    // Outward normal of the edge a->b in (rho, nu) for a CCW polygon.
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey) || 1;
    const nr = ey / len;
    const nn = -ex / len;
    // Graduated faces: the broad faces of the profile.
    let graduated = 0;
    if (spec.profile === "washer" && Math.abs(nn) > 0.99) graduated = 1;
    if (spec.profile === "strip" && nr > 0.99) graduated = 1;
    const base = verts.length / RING_STRIDE;
    for (let i = 0; i <= SEGMENTS; i++) {
      const th = (i / SEGMENTS) * Math.PI * 2;
      for (const p of [a, b]) {
        const across = spec.profile === "washer" ? p[0] / hr : p[1] / hn;
        verts.push(th, p[0], p[1], nr, nn, across, graduated);
      }
    }
    for (let i = 0; i < SEGMENTS; i++) {
      const v = base + i * 2;
      idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    }
  }
  return { data: new Float32Array(verts), indices: new Uint32Array(idx) };
}

export interface LatheMesh {
  /** Interleaved: x, y, z, nx, ny, nz, part (0 rod, 1 finial, 2 globe), u, v (9 floats). Axis along +y. */
  data: Float32Array;
  indices: Uint32Array;
}

export const LATHE_STRIDE = 9;

function revolve(profile: Array<[number, number]>, part: number, segs: number, verts: number[], idx: number[]): void {
  // profile: (y, r) from bottom to top.
  const base = verts.length / LATHE_STRIDE;
  const n = profile.length;
  for (let i = 0; i < n; i++) {
    const [y, r] = profile[i];
    const prev = profile[Math.max(0, i - 1)];
    const next = profile[Math.min(n - 1, i + 1)];
    const dy = next[0] - prev[0];
    const dr = next[1] - prev[1];
    const l = Math.hypot(dy, dr) || 1;
    // Normal of the profile curve in (r, y): perpendicular to its tangent, pointing outward.
    let nr = dy / l;
    let ny = -dr / l;
    if (nr < 0) {
      nr = -nr;
      ny = -ny;
    }
    for (let j = 0; j <= segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      verts.push(r * c, y, r * s, nr * c, ny, nr * s, part, j / segs, i / (n - 1));
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const a = base + i * (segs + 1) + j;
      const b = a + segs + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
}

/** The polar axis rod with turned finials at both ends; length L is the rod half-length. */
export function buildAxisMesh(L: number): LatheMesh {
  const verts: number[] = [];
  const idx: number[] = [];
  const rod = 0.0105;
  revolve(
    [
      [-L, rod],
      [L, rod],
    ],
    0,
    20,
    verts,
    idx,
  );
  // Finial profile measured outward from the rod end (s = distance beyond L).
  const fin: Array<[number, number]> = [
    [0, rod * 1.6],
    [0.006, 0.024],
    [0.014, 0.024],
    [0.018, 0.016],
    [0.024, 0.02],
  ];
  const ball = 0.032;
  const bc = 0.024 + ball;
  for (let i = 0; i <= 14; i++) {
    // The ball sits on the collar (start part-way round, not at its pinched pole).
    const a = -Math.PI / 2 + 0.6 + (i / 14) * (Math.PI - 0.6);
    fin.push([bc + Math.sin(a) * ball, Math.cos(a) * ball + 0.0001]);
  }
  fin.push([bc + ball + 0.004, 0.009], [bc + ball + 0.07, 0.0015], [bc + ball + 0.074, 0.0]);
  const top = fin.map(([s, r]) => [L + s, r] as [number, number]);
  revolve(top, 1, 24, verts, idx);
  const bottom = fin
    .map(([s, r]) => [-L - s, r] as [number, number])
    .reverse();
  revolve(bottom, 1, 24, verts, idx);
  return { data: new Float32Array(verts), indices: new Uint32Array(idx) };
}

export function buildGlobeMesh(radius: number): LatheMesh {
  const verts: number[] = [];
  const idx: number[] = [];
  const prof: Array<[number, number]> = [];
  for (let i = 0; i <= 24; i++) {
    const a = -Math.PI / 2 + (i / 24) * Math.PI;
    prof.push([Math.sin(a) * radius, Math.max(0.00001, Math.cos(a) * radius)]);
  }
  revolve(prof, 2, 32, verts, idx);
  return { data: new Float32Array(verts), indices: new Uint32Array(idx) };
}
