/**
 * Capture-only probes, reachable from a tour as `{ "op": "hook", "name": "__armillaryCapture.webglProbe" }`.
 * They exist to prove what the snapshot path does and does not photograph.
 */

const PROBE_ID = "armillary-capture-webgl-probe";

/**
 * Mounts a 480x320 WebGL canvas, fixed in the middle of the page, that draws a red, green and blue
 * triangle on a magenta clear colour (animated by the rAF timestamp, default context attributes,
 * so preserveDrawingBuffer is false: the hardest case for a snapshot). Returns "ok" or an error text.
 */
export function webglProbe(): string {
  document.getElementById(PROBE_ID)?.remove();
  const canvas = document.createElement("canvas");
  canvas.id = PROBE_ID;
  canvas.width = 480;
  canvas.height = 320;
  Object.assign(canvas.style, {
    position: "fixed",
    left: "50%",
    top: "50%",
    width: "480px",
    height: "320px",
    transform: "translate(-50%, -50%)",
    zIndex: "99999",
    border: "4px solid #fff",
  });
  document.body.appendChild(canvas);
  const gl = canvas.getContext("webgl");
  if (!gl) return "no webgl context";
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, "attribute vec2 p; attribute vec3 c; uniform float a; varying vec3 v; void main(){ float s=sin(a), k=cos(a); gl_Position=vec4(p.x*k-p.y*s, p.x*s+p.y*k, 0.0, 1.0); v=c; }"));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, "precision mediump float; varying vec3 v; void main(){ gl_FragColor=vec4(v,1.0); }"));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0.8, 1, 0, 0, -0.8, -0.6, 0, 1, 0, 0.8, -0.6, 0, 0, 1]), gl.STATIC_DRAW);
  const p = gl.getAttribLocation(prog, "p");
  const c = gl.getAttribLocation(prog, "c");
  gl.enableVertexAttribArray(p);
  gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(c);
  gl.vertexAttribPointer(c, 3, gl.FLOAT, false, 20, 8);
  const a = gl.getUniformLocation(prog, "a");
  const draw = (t: number) => {
    if (!document.getElementById(PROBE_ID)) return;
    gl.clearColor(1, 0, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(a, t / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
  return "ok";
}

export function removeProbe(): void {
  document.getElementById(PROBE_ID)?.remove();
}
