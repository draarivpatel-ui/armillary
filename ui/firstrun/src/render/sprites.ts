/**
 * Pre-rendered sprites and the nebula for the Canvas 2D fallback. Everything here is built once per
 * canvas size (never per frame) and is a pure function of its arguments: no clocks, no Math.random,
 * noise comes from the seeded prng. A sprite is null when the 2D context is unavailable (jsdom), in
 * which case the caller simply skips the drawImage.
 */
import { clamp, mix, prng, smoothstep } from "../math/ease";
import { css } from "../scene/palette";
import type { RGB } from "../scene/types";

export type MakeCanvas = (w: number, h: number) => HTMLCanvasElement;
export type Sprite = HTMLCanvasElement | null;

const TAU = Math.PI * 2;

function surface(make: MakeCanvas, w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } | null {
  const c = make(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const g = c.getContext("2d");
  return g ? { c, g } : null;
}

/** A soft round sprite: alpha(rho) = exp(-k rho^2), rho = r / (size / 2), forced to 0 at the rim. */
export function gaussianSprite(make: MakeCanvas, size: number, rgb: RGB, k: number): Sprite {
  const s = surface(make, size, size);
  if (!s) return null;
  const r = size / 2;
  const edge = Math.exp(-k);
  const g = s.g.createRadialGradient(r, r, 0, r, r, r);
  const N = 14;
  for (let i = 0; i <= N; i++) {
    const rho = i / N;
    g.addColorStop(rho, css(rgb, i === N ? 0 : (Math.exp(-k * rho * rho) - edge) / (1 - edge)));
  }
  s.g.fillStyle = g;
  s.g.fillRect(0, 0, size, size);
  return s.c;
}

/** The saturated corona of a star: a plateau out to 1/6 of the half-size, then a gaussian falloff. */
export function coronaSprite(make: MakeCanvas, size: number, rgb: RGB): Sprite {
  const s = surface(make, size, size);
  if (!s) return null;
  const r = size / 2;
  const g = s.g.createRadialGradient(r, r, 0, r, r, r);
  const N = 16;
  for (let i = 0; i <= N; i++) {
    const rho = i / N;
    const u = (3 * rho - 0.5) / 0.95;
    g.addColorStop(rho, css(rgb, i === N ? 0 : rho <= 1 / 6 ? 1 : Math.exp(-u * u)));
  }
  s.g.fillStyle = g;
  s.g.fillRect(0, 0, size, size);
  return s.c;
}

/** A horizontal diffraction spike spanning -1..1, tapering with pow(1 - |x|, 2.2) and thin across. */
export function spikeSprite(make: MakeCanvas, rgb: RGB): Sprite {
  const W = 256;
  const H = 8;
  const s = surface(make, W, H);
  if (!s) return null;
  const along = s.g.createLinearGradient(0, 0, W, 0);
  const N = 20;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    along.addColorStop(t, css(rgb, Math.pow(Math.max(1 - Math.abs(2 * t - 1), 0), 2.2)));
  }
  s.g.fillStyle = along;
  s.g.fillRect(0, 0, W, H);
  s.g.globalCompositeOperation = "destination-in";
  const across = s.g.createLinearGradient(0, 0, 0, H);
  const edge = Math.exp(-2.6);
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    across.addColorStop(t, css([1, 1, 1], i === 0 || i === 8 ? 0 : (Math.exp(-Math.abs(2 * t - 1) * 2.6) - edge) / (1 - edge)));
  }
  s.g.fillStyle = across;
  s.g.fillRect(0, 0, W, H);
  s.g.globalCompositeOperation = "source-over";
  return s.c;
}

/** A small gilt ball (finial): a lit sphere with the highlight toward the upper left. */
export function ballSprite(make: MakeCanvas, size: number): Sprite {
  const s = surface(make, size, size);
  if (!s) return null;
  const r = size / 2;
  const g = s.g.createRadialGradient(size * 0.38, size * 0.33, size * 0.03, r, r, r);
  g.addColorStop(0, css([1, 0.94, 0.74]));
  g.addColorStop(0.28, css([0.95, 0.75, 0.36]));
  g.addColorStop(0.7, css([0.55, 0.38, 0.14]));
  g.addColorStop(1, css([0.16, 0.1, 0.04]));
  s.g.fillStyle = g;
  s.g.beginPath();
  s.g.arc(r, r, r - 0.75, 0, TAU);
  s.g.fill();
  return s.c;
}

/**
 * The beam as an image of the wedge itself: row v (0 at the pivot .. 1 at the far end) holds the
 * cross profile of angle / spread (about 1.8 u / v), so a scale of (length * tan(1.8 spread), length)
 * reproduces BEAM_FS. Alpha is normalised to its 0.13 peak; the caller multiplies by 0.13 * alpha.
 */
export function beamSprite(make: MakeCanvas): Sprite {
  const W = 96;
  const H = 160;
  const s = surface(make, W, H);
  if (!s) return null;
  const img = s.g.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    const fall = smoothstep(0, 0.25, v) * (1 - smoothstep(0.55, 1, v));
    for (let x = 0; x < W; x++) {
      const u = ((x + 0.5) / W) * 2 - 1;
      const ratio = (1.8 * Math.abs(u)) / Math.max(v, 0.02);
      const val = ((Math.exp(-ratio * ratio * 1.6) * 0.07 + Math.exp(-(ratio / 0.22) * (ratio / 0.22)) * 0.06) / 0.13) * fall;
      const i = (y * W + x) * 4;
      img.data[i] = 237;
      img.data[i + 1] = 214;
      img.data[i + 2] = 158;
      img.data[i + 3] = Math.round(clamp(val) * 255);
    }
  }
  s.g.putImageData(img, 0, 0);
  return s.c;
}

/** Seeded value noise on a 128 x 128 lattice (the shader's hash noise, made deterministic). */
function makeNoise(seed: number): (x: number, y: number) => number {
  const rand = prng(seed);
  const tbl = new Float32Array(128 * 128);
  for (let i = 0; i < tbl.length; i++) tbl[i] = rand();
  const at = (i: number, j: number) => tbl[(i & 127) + ((j & 127) << 7)];
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    return mix(mix(at(xi, yi), at(xi + 1, yi), ux), mix(at(xi, yi + 1), at(xi + 1, yi + 1), ux), uy);
  };
}

/**
 * The faint cold milky band (BG_FS): a diagonal along y = 0.18 + 0.62 x with dust lanes and a
 * touch of violet haze, at quarter resolution. Alpha holds the strength, colour its hue; the
 * renderer scales it by sky.nebula and stretches it over the viewport.
 */
export function nebulaSprite(make: MakeCanvas, cssW: number, cssH: number): Sprite {
  const W = Math.max(8, Math.ceil(cssW / 4));
  const H = Math.max(8, Math.ceil(cssH / 4));
  const s = surface(make, W, H);
  if (!s) return null;
  const noise = makeNoise(0x4e45);
  const fbm = (x: number, y: number) => {
    let v = 0;
    let a = 0.5;
    for (let i = 0; i < 4; i++) {
      v += a * noise(x, y);
      x *= 2.03;
      y *= 2.03;
      a *= 0.5;
    }
    return v;
  };
  const img = s.g.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const d = (v - (0.18 + u * 0.62)) / 0.16;
      const band = Math.exp(-d * d);
      const n = fbm(u * 5 + 3.1, v * 3 + 3.1);
      const lanes = smoothstep(0.45, 0.75, fbm(u * 9 + 11, v * 9 + 11));
      const k1 = band * (0.55 + 0.45 * n) * (1 - 0.6 * lanes);
      const k2 = smoothstep(0.55, 0.9, fbm(u * 2.2 + 7.7, v * 2.2 + 7.7)) * 0.6;
      const r = 0.05 * k1 + 0.04 * k2;
      const g = 0.06 * k1 + 0.025 * k2;
      const b = 0.1 * k1 + 0.045 * k2;
      const a = clamp(Math.max(r, g, b) * 1.15 * 1.0, 0, 1);
      const i = (y * W + x) * 4;
      const m = Math.max(r, g, b, 1e-6);
      img.data[i] = Math.round(clamp(r / m) * 255);
      img.data[i + 1] = Math.round(clamp(g / m) * 255);
      img.data[i + 2] = Math.round(clamp(b / m) * 255);
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  s.g.putImageData(img, 0, 0);
  return s.c;
}
