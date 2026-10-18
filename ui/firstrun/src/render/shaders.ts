/** GLSL ES 3.00 sources for the WebGL2 renderer. All lengths in CSS px are multiplied by uDpr. */

/** Shared projection: instrument space -> screen px -> clip, with a depth that orders by view z. */
const PROJECT = /* glsl */ `
uniform mat3 uView;
uniform vec4 uCam;      // cx, cy, scale (CSS px per sphere radius), dist
uniform vec2 uRes;      // CSS px
vec4 projectWorld(vec3 world, out vec3 viewPos) {
  viewPos = uView * world;
  float p = uCam.w / (uCam.w - viewPos.z);
  vec2 s = vec2(uCam.x + viewPos.x * uCam.z * p, uCam.y - viewPos.y * uCam.z * p);
  vec2 ndc = vec2(s.x / uRes.x * 2.0 - 1.0, 1.0 - s.y / uRes.y * 2.0);
  return vec4(ndc, clamp(-viewPos.z * 0.25, -0.99, 0.99), 1.0);
}
`;

/** Gilt metal shading shared by the rings, the axis and the globe. */
const GILT = /* glsl */ `
uniform vec3 uGlint;    // view-space direction of the travelling glint light
uniform float uBack;    // 1 when drawing the far half
uniform float uDpr;
vec3 giltShade(vec3 N, vec3 viewPos, float cavity, out float keyLambert) {
  vec3 V = normalize(vec3(0.0, 0.0, uCam.w) - viewPos);
  vec3 L1 = normalize(vec3(-0.5, 0.72, 0.55));
  vec3 L2 = normalize(vec3(0.75, -0.28, 0.45));
  vec3 L3 = normalize(vec3(0.35, 0.5, -0.8));
  vec3 gold = vec3(0.93, 0.72, 0.33);
  float d1 = max(dot(N, L1), 0.0);
  float d2 = max(dot(N, L2), 0.0);
  keyLambert = d1;
  vec3 H1 = normalize(L1 + V);
  vec3 H2 = normalize(L2 + V);
  vec3 Hg = normalize(uGlint + V);
  float nh1 = max(dot(N, H1), 0.0);
  float s1 = pow(nh1, 46.0);
  float s1b = pow(nh1, 7.0);
  float s2 = pow(max(dot(N, H2), 0.0), 16.0);
  float sg = pow(max(dot(N, Hg), 0.0), 220.0);
  float sgb = pow(max(dot(N, Hg), 0.0), 24.0);
  float nv = max(dot(N, V), 0.0);
  float rim = pow(1.0 - nv, 3.0) * max(dot(N, L3) + 0.45, 0.0);
  vec3 R = reflect(-V, N);
  // A dim observatory around the instrument: lamplight warm and low on the left, night sky above.
  float lamp = smoothstep(-0.2, 0.9, -R.x * 0.7 + R.y * 0.35 + 0.15);
  vec3 env = mix(vec3(0.035, 0.04, 0.07), vec3(0.62, 0.44, 0.2), lamp);
  env += vec3(0.08, 0.09, 0.13) * smoothstep(0.6, 1.0, R.y);
  // Metal: colour comes from reflection; a broad warm sheen gives the body of the band its gold.
  vec3 c = gold * env * 0.75;
  c += gold * d1 * 0.30;
  c += gold * s1b * 0.55;
  c += mix(gold, vec3(1.0, 0.94, 0.8), 0.45) * s1 * 1.1;
  c += vec3(0.30, 0.34, 0.45) * s2 * 0.35;
  c += gold * d2 * 0.05;
  c += vec3(1.0, 0.95, 0.82) * sg * 1.4 + gold * sgb * 0.22;
  c += gold * rim * 0.4;
  c *= cavity;
  return c;
}
`;

export const RING_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in float aTheta;
layout(location = 1) in vec2 aSection;  // rho, nu
layout(location = 2) in vec2 aSecNormal;
layout(location = 3) in float aAcross;
layout(location = 4) in float aGrad;
${PROJECT}
uniform vec3 uU;
uniform vec3 uV;
uniform vec3 uN;
uniform vec3 uOffset;
uniform float uRadius;
out float vTheta;
out float vAcross;
out float vGrad;
out vec3 vNormal;
out vec3 vViewPos;
void main() {
  vec3 R = cos(aTheta) * uU + sin(aTheta) * uV;
  vec3 world = uOffset + (uRadius + aSection.x) * R + aSection.y * uN;
  vec3 nWorld = normalize(aSecNormal.x * R + aSecNormal.y * uN);
  vec3 vp;
  gl_Position = projectWorld(world, vp);
  vViewPos = vp;
  vNormal = uView * nWorld;
  vTheta = aTheta;
  vAcross = aAcross;
  vGrad = aGrad;
}
`;

export const RING_FS = /* glsl */ `#version 300 es
precision highp float;
${PROJECT}
${GILT}
in float vTheta;
in float vAcross;
in float vGrad;
in vec3 vNormal;
in vec3 vViewPos;
uniform vec2 uDraw;       // from, amount (radians)
uniform float uEtch;      // radians etched from the start
uniform float uAlpha;
uniform float uTip;
uniform float uRadiusPx;  // ring radius in device px (for tip glow and tick AA)
uniform vec2 uTicks;      // minor step (radians), major every N minors
uniform float uWasher;
out vec4 outColor;
const float TAU = 6.28318530718;
float lineMask(float d, float w) { return 1.0 - smoothstep(w * 0.5, w * 0.5 + 1.0, d); }
void main() {
  float viewSide = vViewPos.z;
  if (uBack > 0.5 && viewSide > 0.0) discard;
  if (uBack < 0.5 && viewSide <= 0.0) discard;
  float rel = mod(vTheta - uDraw.x + TAU * 4.0, TAU);
  if (rel > uDraw.y + 0.0005) discard;
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  float key;
  float cavity = 1.0;
  // Engraving on the graduated faces: two border grooves and a degree scale between them.
  float engrave = 0.0;
  float lip = 0.0;
  if (vGrad > 0.5) {
    float pxPerRad = uRadiusPx;
    float etched = step(rel, uEtch);
    float across = vAcross;         // -1 (inner/bottom) .. 1 (outer/top)
    float pxAcross = fwidth(across);
    // grooves near both edges
    float g1 = abs(across - 0.7) / max(pxAcross, 1e-4);
    float g2 = abs(across + 0.7) / max(pxAcross, 1e-4);
    float grooves = max(lineMask(g1, 1.0), lineMask(g2, 1.0));
    // ticks: from the outer groove inward
    float minorStep = uTicks.x;
    float k = vTheta / minorStep;
    float nearest = floor(k + 0.5);
    float dPx = abs(k - nearest) * minorStep * pxPerRad;
    bool major = mod(nearest, uTicks.y) < 0.5;
    float len = major ? 0.95 : 0.55;
    float inBand = step(0.7 - len * 1.4, across) * step(across, 0.7);
    float density = clamp(minorStep * pxPerRad / 5.0, 0.0, 1.0); // fade minors when too dense
    float tick = lineMask(dPx, major ? 1.25 : 0.85) * inBand * (major ? 1.0 : density);
    engrave = max(grooves, tick) * etched;
    // the lit lip of each cut, one pixel to the light side
    float k2 = (vTheta - 0.9 / pxPerRad) / minorStep;
    float dPx2 = abs(k2 - floor(k2 + 0.5)) * minorStep * pxPerRad;
    lip = lineMask(dPx2, 0.8) * inBand * (major ? 1.0 : density) * etched * (1.0 - engrave);
    cavity = 1.0 - engrave * 0.72;
  }
  vec3 c = giltShade(N, vViewPos, cavity, key);
  c += vec3(0.9, 0.8, 0.55) * lip * 0.18;
  // Fine engraver's hatching on the shaded undersides.
  float shade = 1.0 - smoothstep(0.05, 0.42, key);
  if (shade > 0.01) {
    float sp = 3.1 * uDpr;
    float hx = fract((gl_FragCoord.x - gl_FragCoord.y) / sp);
    float hatch = 1.0 - smoothstep(0.32, 0.5, abs(hx - 0.5));
    c *= 1.0 - hatch * shade * 0.5;
  }
  // The burin's bright tip while the ring is cut.
  if (uTip > 0.0) {
    float dEnd = (uDraw.y - rel) * uRadiusPx;
    float tipK = exp(-dEnd * dEnd / (140.0 * uDpr * uDpr));
    c += vec3(1.0, 0.92, 0.7) * tipK * uTip * 2.4 + vec3(1.0) * pow(tipK, 6.0) * uTip * 2.0;
  }
  // The far half sits back: dimmer, cooler, closer to the ink.
  if (uBack > 0.5) c = mix(vec3(0.045, 0.06, 0.1), c * 0.62, 0.62);
  outColor = vec4(c * uAlpha, uAlpha);
}
`;

export const LATHE_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in float aPart;
layout(location = 3) in vec2 aUV;
${PROJECT}
uniform mat3 uModel;      // local +y -> the axis direction
uniform float uExtent;    // rod extension 0..1
uniform float uFinial;    // finial scale 0..1
uniform float uRodLen;
uniform float uScale;     // globe scale
out vec3 vNormal;
out vec3 vViewPos;
out float vPart;
out vec2 vUV;
out vec3 vLocal;
void main() {
  vec3 p = aPos;
  if (aPart < 0.5) {
    p.y *= uExtent;
  } else if (aPart < 1.5) {
    float s = sign(p.y);
    float beyond = abs(p.y) - uRodLen;
    p.y = s * (uRodLen * uExtent + beyond * uFinial);
    p.xz *= uFinial;
  } else {
    p *= uScale;
  }
  vec3 world = uModel * p;
  vec3 vp;
  gl_Position = projectWorld(world, vp);
  vViewPos = vp;
  vNormal = uView * (uModel * aNormal);
  vPart = aPart;
  vUV = aUV;
  vLocal = aPos;
}
`;

export const LATHE_FS = /* glsl */ `#version 300 es
precision highp float;
${PROJECT}
${GILT}
in vec3 vNormal;
in vec3 vViewPos;
in float vPart;
in vec2 vUV;
in vec3 vLocal;
uniform float uAlpha;
uniform float uSplit;     // 1: discard by half (uBack), 0: draw whole
out vec4 outColor;
void main() {
  if (uSplit > 0.5) {
    if (uBack > 0.5 && vViewPos.z > 0.0) discard;
    if (uBack < 0.5 && vViewPos.z <= 0.0) discard;
  }
  vec3 N = normalize(vNormal);
  float key;
  float cavity = 1.0;
  if (vPart > 1.5) {
    // The globe: engraved meridians and parallels.
    float lon = vUV.x * 24.0;
    float lat = vUV.y * 12.0;
    float dl = abs(fract(lon + 0.5) - 0.5) / fwidth(lon);
    float dp = abs(fract(lat + 0.5) - 0.5) / fwidth(lat);
    float grid = max(1.0 - smoothstep(0.4, 1.2, dl), 1.0 - smoothstep(0.4, 1.2, dp));
    cavity = 1.0 - grid * 0.55;
  }
  vec3 c = giltShade(N, vViewPos, cavity, key);
  float shade = 1.0 - smoothstep(0.05, 0.4, key);
  if (shade > 0.01) {
    float sp = 3.1 * uDpr;
    float hx = fract((gl_FragCoord.x - gl_FragCoord.y) / sp);
    float hatch = 1.0 - smoothstep(0.32, 0.5, abs(hx - 0.5));
    c *= 1.0 - hatch * shade * 0.45;
  }
  if (uBack > 0.5 && uSplit > 0.5) c = mix(vec3(0.045, 0.06, 0.1), c * 0.62, 0.62);
  outColor = vec4(c * uAlpha, uAlpha);
}
`;

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const BG_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec2 uRes;
uniform float uTime;
uniform float uNebula;
uniform float uParchment;
uniform float uZoom;
out vec4 outColor;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 c = (uv - 0.5) / uZoom + 0.5;
  float aspect = uRes.x / uRes.y;
  vec2 q = vec2((c.x - 0.5) * aspect, c.y - 0.44);
  float r = length(q);
  vec3 ink0 = vec3(0.043, 0.071, 0.125);
  vec3 deep = vec3(0.022, 0.035, 0.068);
  vec3 lift = vec3(0.075, 0.098, 0.165);
  vec3 col = mix(lift, ink0, smoothstep(0.0, 0.55, r));
  col = mix(col, deep, smoothstep(0.45, 1.1, r));
  // The milky band along the diagonal, faint and cold, with dust lanes.
  float band = exp(-pow((c.y - (0.18 + c.x * 0.62)) / 0.16, 2.0));
  float n = fbm(c * vec2(5.0, 3.0) + 3.1);
  float lanes = smoothstep(0.45, 0.75, fbm(c * 9.0 + 11.0));
  col += vec3(0.05, 0.06, 0.1) * band * (0.55 + 0.45 * n) * (1.0 - 0.6 * lanes) * uNebula;
  col += vec3(0.04, 0.025, 0.045) * smoothstep(0.55, 0.9, fbm(c * 2.2 + 7.7)) * uNebula * 0.6;
  // Grain, 2 to 3 percent.
  float g = hash(floor(uv * uRes * 1.0) + floor(uTime * 0.0));
  col += (g - 0.5) * 0.018;
  // Cross to the Day almanac through warm sepia (a straight mix of navy and parchment reads grey).
  vec3 sepia = vec3(0.36, 0.27, 0.16);
  vec3 parch = vec3(0.953, 0.922, 0.855);
  col = mix(col, sepia, smoothstep(0.0, 0.45, uParchment) * (1.0 - smoothstep(0.45, 1.0, uParchment)));
  col = mix(col, parch, smoothstep(0.3, 1.0, uParchment));
  outColor = vec4(col, 1.0);
}
`;

export const FIELD_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec4 aStar; // size, mag, temp, phase
layout(location = 2) in float aSpeed;
uniform vec2 uRes;
uniform float uTime;
uniform float uZoom;
uniform float uDepth;
uniform float uAlpha;
uniform float uDpr;
out float vMag;
out vec3 vCol;
out float vSize;
void main() {
  float z = pow(uZoom, 1.0 + uDepth * 1.6);
  vec2 p = (aPos - 0.5) * z + 0.5;
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  float tw = 0.72 + 0.28 * sin(6.2831 * (aStar.w + uTime * aSpeed)) * sin(6.2831 * (aStar.w * 1.7 + uTime * aSpeed * 0.53));
  vMag = aStar.y * tw * uAlpha;
  float t = aStar.z;
  vCol = t < 0.0 ? mix(vec3(1.0), vec3(0.78, 0.86, 1.0), -t) : mix(vec3(1.0), vec3(1.0, 0.9, 0.74), t);
  vSize = aStar.x * uDpr * mix(1.0, z, 0.35);
  gl_PointSize = vSize * 2.0 + 3.0 + (uDepth > 0.9 ? vSize * 6.0 * aStar.y : 0.0);
}
`;

export const FIELD_FS = /* glsl */ `#version 300 es
precision highp float;
in float vMag;
in vec3 vCol;
in float vSize;
uniform float uDepth;
out vec4 outColor;
void main() {
  vec2 d = (gl_PointCoord - 0.5) * (vSize * 2.0 + 3.0 + (uDepth > 0.9 ? vSize * 6.0 * vMag : 0.0));
  float r = length(d);
  float core = exp(-r * r / max(vSize * vSize * 0.9, 0.35));
  float spikes = 0.0;
  if (uDepth > 0.9) {
    spikes = exp(-abs(d.x) * 1.4) * exp(-abs(d.y) / (vSize * 3.0)) + exp(-abs(d.y) * 1.4) * exp(-abs(d.x) / (vSize * 3.0));
    spikes *= 0.35 * vMag;
  }
  float a = clamp(core * vMag + spikes, 0.0, 1.0);
  outColor = vec4(vCol * a, a);
}
`;

/** Instanced star sprites: core, bloom, diffraction spikes, the import arc, the pulse, the error tick. */
export const STAR_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 iPos;    // x, y, half-size (CSS px), alpha
layout(location = 2) in vec4 iColor;  // rgb, flare
layout(location = 3) in vec4 iShape;  // core, spikes, spikeAlpha, bloom
layout(location = 4) in vec4 iArc;    // bloomAlpha, arc, arcAlpha, arcRadius
layout(location = 5) in vec2 iPulse;  // pulse, error
uniform vec2 uRes;
out vec2 vLocal;
flat out vec4 vColor;
flat out vec4 vShape;
flat out vec4 vArc;
flat out vec2 vPulse;
flat out float vAlpha;
void main() {
  vec2 s = iPos.xy + aCorner * iPos.z;
  gl_Position = vec4(s.x / uRes.x * 2.0 - 1.0, 1.0 - s.y / uRes.y * 2.0, 0.0, 1.0);
  vLocal = aCorner * iPos.z;
  vColor = iColor;
  vShape = iShape;
  vArc = iArc;
  vPulse = iPulse;
  vAlpha = iPos.w;
}
`;

export const STAR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec4 vColor;
flat in vec4 vShape;
flat in vec4 vArc;
flat in vec2 vPulse;
flat in float vAlpha;
uniform float uDpr;
out vec4 outColor;
const float TAU = 6.28318530718;
void main() {
  vec2 p = vLocal;
  float r = length(p);
  float aa = 0.75 / uDpr;
  float core = vShape.x;
  vec3 col = vColor.rgb;
  float flare = vColor.a;
  // white-hot core inside a saturated family-coloured corona
  float coreMask = 1.0 - smoothstep(core * 0.62 - aa, core * 0.62 + aa, r);
  float corona = exp(-pow(max(r - core * 0.5, 0.0) / max(core * 0.95, 0.5), 2.0));
  vec3 coreCol = mix(col, vec3(1.0, 0.98, 0.94), 0.55 + 0.45 * flare);
  // bloom, tinted by the family colour
  float bloom = vArc.x * exp(-r * r / max(vShape.w * vShape.w * 0.32, 0.01));
  // diffraction spikes: four long, four short at 45 degrees
  float sp = 0.0;
  if (vShape.y > 0.5) {
    float L = vShape.y;
    float th = 0.55 / uDpr + 0.5;
    float s1 = exp(-abs(p.y) / th) * pow(max(1.0 - abs(p.x) / L, 0.0), 2.2);
    float s2 = exp(-abs(p.x) / th) * pow(max(1.0 - abs(p.y) / L, 0.0), 2.2);
    vec2 q = vec2(p.x + p.y, p.x - p.y) * 0.70710678;
    float L2 = L * 0.42;
    float s3 = exp(-abs(q.y) / th) * pow(max(1.0 - abs(q.x) / L2, 0.0), 2.5);
    float s4 = exp(-abs(q.x) / th) * pow(max(1.0 - abs(q.y) / L2, 0.0), 2.5);
    sp = (s1 + s2 + 0.6 * (s3 + s4)) * vShape.z;
  }
  vec3 sat = mix(vec3(dot(col, vec3(0.333))), col, 1.35);
  vec3 c = sat * bloom * 1.05 + mix(sat, vec3(1.0), 0.35) * sp + sat * corona * 0.9 * (1.0 - coreMask) + coreCol * coreMask;
  float a = clamp(bloom * 0.8 + sp + corona * 0.85 + coreMask, 0.0, 1.0);
  // import arc: a faint full track and the filled part from twelve o'clock, clockwise
  if (vArc.z > 0.001) {
    float R = vArc.w;
    float ring = 1.0 - smoothstep(0.42, 0.42 + aa * 1.6, abs(r - R));
    float ang = atan(p.x, -p.y);
    if (ang < 0.0) ang += TAU;
    float filled = step(ang, vArc.y * TAU + 0.0001);
    vec3 gilt = vec3(0.886, 0.78, 0.494);
    vec3 errC = vec3(0.824, 0.275, 0.18);
    vec3 arcCol = vPulse.y > 0.5 ? errC : gilt;
    float track = ring * 0.12;
    // fine graduation on the track: twelve ticks like a dial
    float tickA = abs(fract(ang / TAU * 12.0 + 0.5) - 0.5) * TAU / 12.0 * R;
    track += (1.0 - smoothstep(0.3, 0.3 + aa * 1.5, tickA)) * (1.0 - smoothstep(0.0, 2.2, abs(r - R - 2.0))) * 0.35;
    float fill = ring * filled;
    c += arcCol * (fill + track) * vArc.z;
    a = max(a, (fill + track) * vArc.z);
    // the error tick: a short radial cut at the arc's end
    if (vPulse.y > 0.5) {
      float endA = vArc.y * TAU;
      vec2 dir = vec2(sin(endA), -cos(endA));
      float along = dot(p, dir);
      float side = abs(p.x * dir.y - p.y * dir.x);
      float tick = (1.0 - smoothstep(0.7, 1.4, side)) * step(R - 4.0, along) * step(along, R + 5.0);
      c += errC * tick;
      a = max(a, tick);
    }
  }
  // completion pulse: a ring that swells once and fades
  if (vPulse.x > 0.0) {
    float pr = vArc.w + vPulse.x * 16.0;
    float pw = 1.0 - smoothstep(0.0, 1.2, abs(r - pr));
    float pa = (1.0 - vPulse.x) * (1.0 - vPulse.x) * 0.8;
    c += vec3(0.886, 0.78, 0.494) * pw * pa;
    a = max(a, pw * pa);
  }
  outColor = vec4(c * vAlpha, a * vAlpha);
}
`;

/** Instanced antialiased line segments (constellation lines) with a drawn fraction and a burin tip. */
export const LINE_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;   // x: 0..1 along, y: -1..1 across
layout(location = 1) in vec4 iSeg;      // x1, y1, x2, y2
layout(location = 2) in vec4 iStyle;    // progress, alpha, width, tip
uniform vec2 uRes;
out vec2 vCoord;      // along (px), across (px)
flat out vec4 vStyle;
flat out float vLen;
void main() {
  vec2 a = iSeg.xy;
  vec2 b = iSeg.zw;
  vec2 d = b - a;
  float len = max(length(d), 0.001);
  vec2 t = d / len;
  vec2 n = vec2(-t.y, t.x);
  float half_ = iStyle.z * 0.5 + 1.5;
  vec2 s = a + t * (aCorner.x * len) + n * (aCorner.y * half_);
  gl_Position = vec4(s.x / uRes.x * 2.0 - 1.0, 1.0 - s.y / uRes.y * 2.0, 0.0, 1.0);
  vCoord = vec2(aCorner.x * len, aCorner.y * half_);
  vStyle = iStyle;
  vLen = len;
}
`;

export const LINE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vCoord;
flat in vec4 vStyle;
flat in float vLen;
uniform float uDpr;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  float drawn = vStyle.x * vLen;
  if (vCoord.x > drawn) discard;
  float w = vStyle.z * 0.5;
  float d = abs(vCoord.y);
  float m = 1.0 - smoothstep(w, w + 0.8 / uDpr + 0.35, d);
  // a burin stroke: slightly fuller in the middle, tapering at both ends
  float taper = smoothstep(0.0, 6.0, vCoord.x) * smoothstep(0.0, 6.0, vLen - vCoord.x + (1.0 - vStyle.x) * vLen);
  float a = m * vStyle.y * mix(0.55, 1.0, taper);
  vec3 c = uColor;
  if (vStyle.w > 0.0) {
    float k = exp(-pow((drawn - vCoord.x) / 7.0, 2.0)) * vStyle.w;
    c = mix(c, vec3(1.0, 0.95, 0.82), k);
    a = max(a, (1.0 - smoothstep(0.0, 3.5, d)) * k * vStyle.y);
  }
  outColor = vec4(c * a, a);
}
`;

/** The telescope beam: a soft cone from below with a brighter core and drifting motes. */
export const BEAM_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec2 uRes;
uniform vec4 uBeam;    // pivot x, pivot y (CSS px), angle, spread
uniform vec2 uBeam2;   // length, alpha
uniform vec4 uSpot;    // x, y, r, alpha
uniform float uTime;
out vec4 outColor;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
void main() {
  vec2 s = vec2(vUv.x, 1.0 - vUv.y) * uRes;
  vec2 d = s - uBeam.xy;
  float dist = length(d);
  float ang = atan(d.x, -d.y) - uBeam.z;
  float spread = uBeam.w;
  float cone = exp(-pow(ang / spread, 2.0) * 1.6);
  float core = exp(-pow(ang / (spread * 0.22), 2.0));
  float along = clamp(dist / uBeam2.x, 0.0, 1.0);
  float fall = smoothstep(0.0, 0.25, along) * (1.0 - smoothstep(0.55, 1.0, along));
  float motes = step(0.9965, hash(floor(s / 2.0) + floor(uTime * 3.0))) * cone;
  float a = (cone * 0.07 + core * 0.06 + motes * 0.35) * fall * uBeam2.y;
  vec3 c = vec3(0.93, 0.84, 0.62);
  if (uSpot.w > 0.0) {
    float sr = length(s - uSpot.xy) / uSpot.z;
    a += exp(-sr * sr * 2.5) * 0.28 * uSpot.w;
  }
  outColor = vec4(c * a, a);
}
`;
