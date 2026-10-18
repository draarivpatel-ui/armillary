/** Small, allocation-light 3D helpers. Vectors are tuples; matrices are row-major 3x3 tuples. */

export type V3 = [number, number, number];
export type M3 = [number, number, number, number, number, number, number, number, number];

export const v3 = (x: number, y: number, z: number): V3 => [x, y, z];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: V3): V3 => {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export const IDENTITY: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const mulMV = (m: M3, v: V3): V3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

export const mulMM = (a: M3, b: M3): M3 => {
  const r = new Array(9).fill(0) as M3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
};

export const rotX = (a: number): M3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
};
export const rotY = (a: number): M3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
};
export const rotZ = (a: number): M3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};

/** Rodrigues rotation of v about unit axis k by angle a. */
export function rotateAbout(v: V3, k: V3, a: number): V3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}

/**
 * The camera: instrument space -> view space by `view`, then a mild perspective.
 * View space: x right, y up, z toward the viewer. `dist` is the eye distance in sphere radii.
 */
export interface Camera {
  cx: number;
  cy: number;
  /** CSS px per sphere radius at the sphere centre's depth. */
  scale: number;
  dist: number;
  view: M3;
}

export interface Projected {
  x: number;
  y: number;
  /** View-space depth (toward the viewer is positive). */
  z: number;
  /** Perspective factor at this depth (1 at the centre plane). */
  p: number;
}

export function project(cam: Camera, w: V3): Projected {
  const v = mulMV(cam.view, w);
  const p = cam.dist / (cam.dist - v[2]);
  return { x: cam.cx + v[0] * cam.scale * p, y: cam.cy - v[1] * cam.scale * p, z: v[2], p };
}

export function toView(cam: Camera, w: V3): V3 {
  return mulMV(cam.view, w);
}
