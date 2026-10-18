/**
 * WebGL2 renderer: draws a Frame (the scene's pure description). Owns no clock; the frame carries
 * every time-dependent value. Text and the window rule are drawn by the shared 2D overlay.
 */
import { mulMV, type M3 } from "../math/vec";
import { AXIS_DIR, RINGS, type RingSpec } from "../scene/instrument";
import { C } from "../scene/palette";
import type { FieldLayer } from "../scene/sky";
import type { Frame } from "../scene/types";
import { buildAxisMesh, buildGlobeMesh, buildRingMesh, LATHE_STRIDE, RING_STRIDE } from "./geometry";
import {
  BEAM_FS,
  BG_FS,
  FIELD_FS,
  FIELD_VS,
  FULLSCREEN_VS,
  LATHE_FS,
  LATHE_VS,
  LINE_FS,
  LINE_VS,
  RING_FS,
  RING_VS,
  STAR_FS,
  STAR_VS,
} from "./shaders";

export interface SkyRenderer {
  readonly kind: "webgl2" | "canvas2d";
  resize(cssW: number, cssH: number, dpr: number): void;
  render(frame: Frame): void;
  dispose(): void;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

interface Program {
  prog: WebGLProgram;
  u: Uniforms;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error("shader compile failed: " + log);
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string, names: string[]): Program {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error("program link failed: " + gl.getProgramInfoLog(p));
  const u: Uniforms = {};
  for (const n of names) u[n] = gl.getUniformLocation(p, n);
  return { prog: p, u };
}

const COMMON = ["uView", "uCam", "uRes", "uGlint", "uBack", "uDpr"];

interface RingGpu {
  spec: RingSpec;
  vao: WebGLVertexArrayObject;
  count: number;
}

const transpose = (m: M3): Float32Array => new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);

/** Rotation taking +y to the polar axis (Rodrigues about z, since the axis lies in the xy plane). */
function axisModel(): M3 {
  const a = Math.atan2(AXIS_DIR[0], AXIS_DIR[1]); // angle from +y toward +x
  const c = Math.cos(-a);
  const s = Math.sin(-a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

export class WebGLSkyRenderer implements SkyRenderer {
  readonly kind = "webgl2" as const;
  private gl: WebGL2RenderingContext;
  private dpr = 1;
  private w = 1;
  private h = 1;
  private pRing: Program;
  private pLathe: Program;
  private pBg: Program;
  private pField: Program;
  private pStar: Program;
  private pLine: Program;
  private pBeam: Program;
  private rings: RingGpu[] = [];
  private axisVao: WebGLVertexArrayObject;
  private axisCount: number;
  private globeVao: WebGLVertexArrayObject;
  private globeCount: number;
  private emptyVao: WebGLVertexArrayObject;
  private fieldVaos: Array<{ vao: WebGLVertexArrayObject; count: number; depth: number }> = [];
  private starVao: WebGLVertexArrayObject;
  private starBuf: WebGLBuffer;
  private starData = new Float32Array(0);
  private lineVao: WebGLVertexArrayObject;
  private lineBuf: WebGLBuffer;
  private lineData = new Float32Array(0);

  static create(canvas: HTMLCanvasElement, field: FieldLayer[]): WebGLSkyRenderer | null {
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      alpha: false,
      depth: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    }) as WebGL2RenderingContext | null;
    if (!gl) return null;
    try {
      return new WebGLSkyRenderer(gl, field);
    } catch {
      return null;
    }
  }

  private constructor(gl: WebGL2RenderingContext, field: FieldLayer[]) {
    this.gl = gl;
    this.pRing = program(gl, RING_VS, RING_FS, [...COMMON, "uU", "uV", "uN", "uOffset", "uRadius", "uDraw", "uEtch", "uAlpha", "uTip", "uRadiusPx", "uTicks", "uWasher"]);
    this.pLathe = program(gl, LATHE_VS, LATHE_FS, [...COMMON, "uModel", "uExtent", "uFinial", "uRodLen", "uScale", "uAlpha", "uSplit"]);
    this.pBg = program(gl, FULLSCREEN_VS, BG_FS, ["uRes", "uTime", "uNebula", "uParchment", "uZoom"]);
    this.pField = program(gl, FIELD_VS, FIELD_FS, ["uRes", "uTime", "uZoom", "uDepth", "uAlpha", "uDpr"]);
    this.pStar = program(gl, STAR_VS, STAR_FS, ["uRes", "uDpr"]);
    this.pLine = program(gl, LINE_VS, LINE_FS, ["uRes", "uDpr", "uColor"]);
    this.pBeam = program(gl, FULLSCREEN_VS, BEAM_FS, ["uRes", "uBeam", "uBeam2", "uSpot", "uTime"]);

    for (const spec of RINGS) {
      const m = buildRingMesh(spec);
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      const vb = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, m.data, gl.STATIC_DRAW);
      const st = RING_STRIDE * 4;
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 1, gl.FLOAT, false, st, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, st, 4);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, st, 12);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 1, gl.FLOAT, false, st, 20);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribPointer(4, 1, gl.FLOAT, false, st, 24);
      const ib = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
      this.rings.push({ spec, vao, count: m.indices.length });
    }
    gl.bindVertexArray(null);

    const lathe = (mesh: { data: Float32Array; indices: Uint32Array }) => {
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      const vb = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
      const st = LATHE_STRIDE * 4;
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, st, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, st, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, st, 24);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 2, gl.FLOAT, false, st, 28);
      const ib = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      return { vao, count: mesh.indices.length };
    };
    const ax = lathe(buildAxisMesh(1.32));
    this.axisVao = ax.vao;
    this.axisCount = ax.count;
    const gb = lathe(buildGlobeMesh(0.085));
    this.globeVao = gb.vao;
    this.globeCount = gb.count;

    this.emptyVao = gl.createVertexArray()!;

    for (const layer of field) {
      const n = layer.stars.length;
      const data = new Float32Array(n * 7);
      layer.stars.forEach((s, i) => data.set([s.x, s.y, s.size, s.mag, s.temp, s.phase, s.speed], i * 7));
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      const vb = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 28, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 8);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 24);
      this.fieldVaos.push({ vao, count: n, depth: layer.depth });
    }
    gl.bindVertexArray(null);

    // Quad corners shared by the instanced sprites and segments.
    const quad = (corners: number[]) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(corners), gl.STATIC_DRAW);
      return b;
    };
    this.starVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.starVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad([-1, -1, 1, -1, -1, 1, 1, 1]));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.starBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.starBuf);
    const sst = 18 * 4;
    const sAttr: Array<[number, number, number]> = [
      [1, 4, 0],
      [2, 4, 16],
      [3, 4, 32],
      [4, 4, 48],
      [5, 2, 64],
    ];
    for (const [loc, size, off] of sAttr) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, sst, off);
      gl.vertexAttribDivisor(loc, 1);
    }
    this.lineVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad([0, -1, 1, -1, 0, 1, 1, 1]));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.lineBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.w = cssW;
    this.h = cssH;
    this.dpr = dpr;
    const c = this.gl.canvas as HTMLCanvasElement;
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (c.width !== bw) c.width = bw;
    if (c.height !== bh) c.height = bh;
  }

  dispose(): void {
    const ext = this.gl.getExtension("WEBGL_lose_context");
    ext?.loseContext();
  }

  private setCommon(p: Program, f: Frame, back: boolean): void {
    const gl = this.gl;
    gl.uniformMatrix3fv(p.u.uView, false, transpose(f.cam.view));
    gl.uniform4f(p.u.uCam, f.cam.cx, f.cam.cy, f.cam.scale, f.cam.dist);
    gl.uniform2f(p.u.uRes, this.w, this.h);
    const g = mulMV(f.cam.view, f.glint);
    gl.uniform3f(p.u.uGlint, g[0], g[1], g[2]);
    gl.uniform1f(p.u.uBack, back ? 1 : 0);
    gl.uniform1f(p.u.uDpr, this.dpr);
  }

  private drawRings(f: Frame, back: boolean): void {
    const gl = this.gl;
    const p = this.pRing;
    gl.useProgram(p.prog);
    this.setCommon(p, f, back);
    for (const g of this.rings) {
      const r = f.rings.find((x) => x.spec.id === g.spec.id);
      if (!r || r.alpha <= 0.002 || r.draw <= 0) continue;
      const alpha = r.alpha * f.instrumentAlpha;
      if (alpha <= 0.002) continue;
      gl.uniform3f(p.u.uU, r.U[0], r.U[1], r.U[2]);
      gl.uniform3f(p.u.uV, r.V[0], r.V[1], r.V[2]);
      gl.uniform3f(p.u.uN, r.N[0], r.N[1], r.N[2]);
      gl.uniform3f(p.u.uOffset, r.offset[0], r.offset[1], r.offset[2]);
      gl.uniform1f(p.u.uRadius, r.spec.radius * r.grow);
      gl.uniform2f(p.u.uDraw, r.drawFrom, r.draw * Math.PI * 2);
      gl.uniform1f(p.u.uEtch, r.etch * Math.PI * 2);
      gl.uniform1f(p.u.uAlpha, alpha);
      gl.uniform1f(p.u.uTip, r.tip);
      gl.uniform1f(p.u.uRadiusPx, r.spec.radius * r.grow * f.cam.scale * this.dpr);
      gl.uniform2f(p.u.uTicks, (r.spec.minorDeg * Math.PI) / 180, r.spec.majorEvery);
      gl.uniform1f(p.u.uWasher, r.spec.profile === "washer" ? 1 : 0);
      gl.bindVertexArray(g.vao);
      gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);
    }
  }

  private drawLathe(f: Frame, back: boolean): void {
    const gl = this.gl;
    const p = this.pLathe;
    const alpha = f.axis.alpha * f.instrumentAlpha;
    gl.useProgram(p.prog);
    this.setCommon(p, f, back);
    if (alpha > 0.002 && f.axis.extent > 0) {
      gl.uniformMatrix3fv(p.u.uModel, false, transpose(axisModel()));
      gl.uniform1f(p.u.uExtent, Math.max(0.001, f.axis.extent));
      gl.uniform1f(p.u.uFinial, Math.max(0, f.axis.finials));
      gl.uniform1f(p.u.uRodLen, f.axis.length);
      gl.uniform1f(p.u.uScale, 1);
      gl.uniform1f(p.u.uAlpha, alpha);
      gl.uniform1f(p.u.uSplit, 1);
      gl.bindVertexArray(this.axisVao);
      gl.drawElements(gl.TRIANGLES, this.axisCount, gl.UNSIGNED_INT, 0);
    }
    if (!back && f.globe > 0.001 && f.instrumentAlpha > 0.002) {
      gl.uniformMatrix3fv(p.u.uModel, false, transpose(axisModel()));
      gl.uniform1f(p.u.uScale, Math.max(0.001, f.globe));
      gl.uniform1f(p.u.uAlpha, Math.min(1, f.globe) * f.instrumentAlpha);
      gl.uniform1f(p.u.uSplit, 0);
      gl.bindVertexArray(this.globeVao);
      gl.drawElements(gl.TRIANGLES, this.globeCount, gl.UNSIGNED_INT, 0);
    }
  }

  render(f: Frame): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.clearColor(C.ink0[0], C.ink0[1], C.ink0[2], 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Background
    gl.useProgram(this.pBg.prog);
    gl.uniform2f(this.pBg.u.uRes, this.w, this.h);
    gl.uniform1f(this.pBg.u.uTime, f.sky.time);
    gl.uniform1f(this.pBg.u.uNebula, f.sky.nebula);
    gl.uniform1f(this.pBg.u.uParchment, f.sky.parchment);
    gl.uniform1f(this.pBg.u.uZoom, f.sky.zoom);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // Star field (fades under the parchment)
    gl.useProgram(this.pField.prog);
    gl.uniform2f(this.pField.u.uRes, this.w, this.h);
    gl.uniform1f(this.pField.u.uTime, f.sky.time);
    gl.uniform1f(this.pField.u.uZoom, f.sky.zoom);
    gl.uniform1f(this.pField.u.uDpr, this.dpr);
    this.fieldVaos.forEach((L, i) => {
      const a = f.sky.layers[i] * (1 - f.sky.parchment);
      if (a <= 0.002) return;
      gl.uniform1f(this.pField.u.uDepth, L.depth);
      gl.uniform1f(this.pField.u.uAlpha, a);
      gl.bindVertexArray(L.vao);
      gl.drawArrays(gl.POINTS, 0, L.count);
    });

    // Far halves of the instrument
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    this.drawRings(f, true);
    this.drawLathe(f, true);

    // Contents: constellation lines, beam, stars
    gl.disable(gl.DEPTH_TEST);
    this.drawLines(f);
    this.drawBeam(f);
    this.drawStars(f);

    // Near halves
    gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    this.drawRings(f, false);
    this.drawLathe(f, false);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }

  private drawLines(f: Frame): void {
    if (!f.links.length) return;
    const gl = this.gl;
    const n = f.links.length;
    if (this.lineData.length < n * 8) this.lineData = new Float32Array(n * 8);
    f.links.forEach((l, i) => this.lineData.set([l.x1, l.y1, l.x2, l.y2, l.progress, l.alpha, 1.7, l.tip], i * 8));
    gl.useProgram(this.pLine.prog);
    gl.uniform2f(this.pLine.u.uRes, this.w, this.h);
    gl.uniform1f(this.pLine.u.uDpr, this.dpr);
    gl.uniform3f(this.pLine.u.uColor, (C.gilt[0] + C.giltSoft[0]) / 2, (C.gilt[1] + C.giltSoft[1]) / 2, (C.gilt[2] + C.giltSoft[2]) / 2);
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.lineData.subarray(0, n * 8), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
  }

  private drawBeam(f: Frame): void {
    const b = f.beam;
    if (!b || b.alpha <= 0.002) return;
    const gl = this.gl;
    gl.useProgram(this.pBeam.prog);
    gl.uniform2f(this.pBeam.u.uRes, this.w, this.h);
    gl.uniform4f(this.pBeam.u.uBeam, b.x, b.y, b.angle, b.spread);
    gl.uniform2f(this.pBeam.u.uBeam2, b.length, b.alpha);
    gl.uniform4f(this.pBeam.u.uSpot, b.spot?.x ?? 0, b.spot?.y ?? 0, b.spot?.r ?? 1, b.spot?.alpha ?? 0);
    gl.uniform1f(this.pBeam.u.uTime, f.sky.time);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private drawStars(f: Frame): void {
    const vis = f.stars.filter((s) => s.alpha > 0.003);
    if (!vis.length) return;
    const gl = this.gl;
    const n = vis.length;
    if (this.starData.length < n * 18) this.starData = new Float32Array(n * 18);
    vis.forEach((s, i) => {
      const half = Math.max(s.core + 2, s.spikes + 2, s.bloom * 1.8, s.arcAlpha > 0 ? s.arcRadius + 22 : 0, s.pulse > 0 ? s.arcRadius + 20 : 0) + 2;
      this.starData.set(
        [s.x, s.y, half, s.alpha, s.color[0], s.color[1], s.color[2], s.flare, s.core, s.spikes, s.spikeAlpha, s.bloom, s.bloomAlpha, s.arc, s.arcAlpha, s.arcRadius, s.pulse, s.error ? 1 : 0],
        i * 18,
      );
    });
    gl.useProgram(this.pStar.prog);
    gl.uniform2f(this.pStar.u.uRes, this.w, this.h);
    gl.uniform1f(this.pStar.u.uDpr, this.dpr);
    gl.bindVertexArray(this.starVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.starBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.starData.subarray(0, n * 18), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
  }
}
