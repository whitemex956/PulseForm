import { Program } from '../gl';
import type { FrameInput, World } from '../world';

/**
 * LIQUID FORM — an iridescent liquid-chrome sculpture, ray-marched as a signed
 * distance field so it can flow between shapes without mesh topology limits.
 *
 * Audio coupling (all simultaneous, all from VisualState):
 *   low  → expansion / contraction, deep radial waves, kick punches
 *   mid  → organic folds (domain warp), inner colour drift, slow morphs
 *   high → fine surface ripples, rim shimmer, sparkle particles
 * Shapes (director-selected, morphable):
 *   0 drop (noise blob)  1 wave ribbon (the PulseForm mark)  2 torus  3 metaball cluster
 */

const FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform vec2 uRes;
uniform float uMotion, uT;
uniform float uLow, uMid, uHigh, uKick, uSnare, uHat, uEnergy, uIntensity, uBeat, uDrop, uBuild;
uniform float uShapeA, uShapeB, uMorph;
uniform vec4 uSeed;           // per-world random parameters 0..1
uniform vec3 uPal[5];         // deep, primary, secondary, accent, hot (linear)
uniform float uSteps;         // ray-march budget
uniform float uMotionScale;   // reduced-motion scaling
uniform float uComplexity;
uniform float uCamStyle;
uniform float uReflect;       // floor reflection on/off
uniform float uOffset;        // vertical framing lift
uniform float uDetail;        // fine-detail amount (0 on low tiers to avoid aliasing)

#define PI 3.14159265

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// smooth min (polynomial)
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// cheap smooth 3D value-ish noise via layered sines (no textures, stable)
float wnoise(vec3 p) {
  return sin(p.x * 1.7 + sin(p.y * 1.3)) * sin(p.y * 1.9 + sin(p.z * 1.1)) * sin(p.z * 1.5 + sin(p.x * 1.2));
}

// ---------- shapes ----------
float sdDrop(vec3 p, float m) {
  float r = 1.0;
  float d = length(p) - r;
  d += 0.18 * wnoise(p * 1.6 + vec3(0.0, m * 0.35, m * 0.2));
  return d;
}

// The PulseForm mark: a thick sinuous ribbon, swollen in the middle.
float sdRibbon(vec3 p, float m) {
  vec3 q = p;
  q.xz *= rot(0.35 * sin(m * 0.21));
  float k = 2.9 + 0.5 * uSeed.x;
  float ph = m * 0.9;
  float amp = 0.36 + 0.1 * uMid;
  float fy = amp * sin(k * q.x + ph) * (1.0 - 0.25 * q.x * q.x);
  float fz = 0.12 * cos(k * 0.6 * q.x - ph * 0.7);
  float dfy = amp * k * cos(k * q.x + ph);
  // clamp along the length so the ends are rounded tips, not cut pipes
  float cx = clamp(q.x, -1.7, 1.7);
  float cfy = amp * sin(k * cx + ph) * (1.0 - 0.25 * cx * cx);
  float cfz = 0.12 * cos(k * 0.6 * cx - ph * 0.7);
  vec3 e3 = vec3(q.x - cx, q.y - cfy, q.z - cfz);
  float th = 0.27 * (1.0 - smoothstep(0.3, 1.75, abs(cx))) + 0.04;
  // flatten into a ribbon that twists along its length
  e3.yz *= rot(cx * 1.1 + m * 0.3);
  e3.z *= 1.8;
  float d = length(e3) / sqrt(1.0 + dfy * dfy * 0.35) - th;
  return d * 0.8;
}

float sdTorus(vec3 p, float m) {
  vec3 q = p;
  q.yz *= rot(0.6 + 0.3 * sin(m * 0.17));
  q.xy *= rot(m * 0.11);
  float R = 0.78, r = 0.27 + 0.05 * sin(atan(q.z, q.x) * 3.0 + m);
  vec2 t = vec2(length(q.xz) - R, q.y);
  return length(t) - r;
}

float sdBlobs(vec3 p, float m) {
  float d = 1e5;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    vec3 c = vec3(
      sin(m * (0.31 + 0.07 * fi) + fi * 2.1 + uSeed.y * 6.0),
      sin(m * (0.27 + 0.05 * fi) + fi * 1.3 + uSeed.z * 6.0) * 0.7,
      cos(m * (0.23 + 0.06 * fi) + fi * 2.7)
    ) * (0.55 + 0.12 * uLow);
    float r = 0.36 + 0.08 * sin(fi * 1.7 + m * 0.5);
    d = smin(d, length(p - c) - r, 0.42);
  }
  return d;
}

float shapeD(float id, vec3 p, float m) {
  if (id < 0.5) return sdDrop(p, m);
  if (id < 1.5) return sdRibbon(p, m);
  if (id < 2.5) return sdTorus(p, m);
  return sdBlobs(p, m);
}

float map(vec3 p) {
  float m = uMotion * uMotionScale;
  // LOW: breathe and punch
  float scale = 1.0 + 0.16 * uLow + 0.1 * uKick + 0.08 * uDrop;
  p /= scale;
  // MID: organic folds via domain warp
  float fold = 0.05 + 0.15 * uMid * (0.6 + 0.4 * uComplexity);
  p += fold * vec3(
    sin(p.y * 2.3 + m * 0.8),
    sin(p.z * 2.1 + m * 0.9 + 1.7),
    sin(p.x * 2.5 + m * 0.7 + 3.1)
  );
  float d = mix(shapeD(uShapeA, p, m), shapeD(uShapeB, p, m), uMorph);
  // LOW: travelling radial waves
  float r = length(p);
  d -= (0.02 + 0.07 * uLow + 0.04 * uKick) * sin(r * 5.0 - m * 3.5) * smoothstep(1.8, 0.2, r);
  // HIGH: fine ripples (small amplitude, high frequency)
  d -= 0.008 * uHigh * uDetail * sin(p.x * 13.0 + m * 9.0) * sin(p.y * 12.0 - m * 8.0) * sin(p.z * 14.0 + m * 7.0);
  return d * scale * 0.72;
}

vec3 calcNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float h = 0.0015;
  return normalize(k.xyy * map(p + k.xyy * h) + k.yyx * map(p + k.yyx * h) + k.yxy * map(p + k.yxy * h) + k.xxx * map(p + k.xxx * h));
}

// cyclic iridescent gradient through primary → secondary → accent → hot
vec3 irid(float x) {
  x = fract(x);
  vec3 a = uPal[1], b = uPal[2], c = uPal[3], d = uPal[4];
  if (x < 0.25) return mix(a, b, smoothstep(0.0, 0.25, x));
  if (x < 0.5) return mix(b, c, smoothstep(0.25, 0.5, x));
  if (x < 0.75) return mix(c, d, smoothstep(0.5, 0.75, x));
  return mix(d, a, smoothstep(0.75, 1.0, x));
}

// procedural studio environment for chrome reflections
vec3 env(vec3 r, float m) {
  float y = r.y;
  // chrome needs a horizon: dark ground below, luminous sky above
  vec3 col = mix(uPal[0] * 0.04, mix(uPal[1], vec3(0.9), 0.35) * 0.55, smoothstep(-0.04, 0.05, y) * (1.0 - 0.6 * smoothstep(0.1, 0.9, y)));
  // overhead softbox
  col += vec3(1.0, 0.98, 1.02) * 1.5 * smoothstep(0.78, 0.97, y);
  // coloured light strips sweeping around the sculpture
  float a = atan(r.z, r.x);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float ang = fi * 1.5708 + m * 0.07 * (1.0 + fi * 0.3) + uSeed.w * 6.28;
    float da = abs(mod(a - ang + PI, 2.0 * PI) - PI);
    float strip = exp(-da * da * 40.0) * smoothstep(-0.25, 0.2, y) * smoothstep(0.9, 0.35, y);
    col += uPal[1 + i] * strip * (1.1 + 1.1 * uEnergy);
  }
  // warm horizon glow (the logo's floor bounce)
  col += uPal[4] * 0.45 * exp(-abs(y + 0.08) * 12.0);
  return col;
}

vec3 sparkles(vec2 uv, float m) {
  // HIGH: fine particle field; density/brightness follow the highs
  vec3 acc = vec3(0.0);
  for (int l = 0; l < 2; l++) {
    float fl = float(l);
    vec2 g = uv * (14.0 + fl * 11.0) + vec2(m * 0.15 * (1.0 + fl), -m * 0.08);
    vec2 id = floor(g), f = fract(g) - 0.5;
    float h = hash13(vec3(id, fl));
    if (h > 0.86 - 0.2 * uHigh) {
      float tw = 0.5 + 0.5 * sin(m * 6.0 + h * 50.0);
      float s = smoothstep(0.09, 0.0, length(f + (h - 0.5) * 0.5)) * tw;
      acc += mix(vec3(0.9), irid(h + m * 0.02), 0.5) * s * (0.04 + 0.7 * uHigh + 0.4 * uHat);
    }
  }
  return acc;
}

void main() {
  vec2 frag = vUv * uRes;
  vec2 uv = (frag - 0.5 * uRes) / uRes.y;
  uv.y -= uOffset;
  // portrait screens: pull back so the sculpture fits the width
  uv *= max(1.0, 1.2 * uRes.y / uRes.x);
  float m = uMotion * uMotionScale;

  // ---------- camera ----------
  // camera styles: 0 sway (front-biased), 1 slow full orbit, 2 locked frontal
  float orbit = 0.75 * sin(m * 0.07 + uSeed.x * 6.28);
  float elev = 0.18 + 0.12 * sin(m * 0.05 + uSeed.y * 6.0);
  float dist = 6.4 - 0.5 * uIntensity - 0.55 * uDrop * uMotionScale;
  if (uCamStyle > 0.5 && uCamStyle < 1.5) { orbit = m * 0.1 + uSeed.x * 6.28; dist += 0.3 * sin(m * 0.09); }
  if (uCamStyle > 1.5) { orbit = 0.12 * sin(m * 0.04); elev = 0.08; }
  vec3 ro = vec3(sin(orbit) * dist, elev * dist, cos(orbit) * dist);
  // kick shake (off in reduced motion)
  ro += uMotionScale * 0.03 * uKick * vec3(sin(uT * 61.0), cos(uT * 53.0), 0.0);
  vec3 ta = vec3(0.0, -0.18, 0.0);
  vec3 ww = normalize(ta - ro), uu = normalize(cross(ww, vec3(0.0, 1.0, 0.0))), vv = cross(uu, ww);
  float fov = 1.9 + 0.15 * uBuild;
  vec3 rd = normalize(uv.x * uu + uv.y * vv + fov * ww);

  // ---------- background ----------
  vec3 bg = uPal[0] * 0.012;
  float rr = length(uv - vec2(0.0, 0.02));
  bg += uPal[2] * 0.03 * exp(-rr * 4.0) * (0.25 + 0.9 * uEnergy);
  bg += uPal[1] * 0.008 * exp(-rr * 2.5) * (0.4 + uLow);
  // soft volumetric beams behind the sculpture, gated by intensity
  float ang = atan(uv.y + 0.6, uv.x);
  float beams = pow(0.5 + 0.5 * sin(ang * (7.0 + 5.0 * uSeed.z) + m * 0.4), 40.0) * smoothstep(1.3, 0.2, rr);
  bg += irid(ang * 0.3 + m * 0.03) * beams * 0.025 * smoothstep(0.5, 0.95, uIntensity);
  bg += sparkles(uv, m) * smoothstep(0.15, 1.2, rr);

  // ---------- march ----------
  float t = 0.0, d = 1.0;
  int steps = int(uSteps);
  int i;
  float tmax = 9.0;
  for (i = 0; i < 160; i++) {
    if (i >= steps) break;
    vec3 p = ro + rd * t;
    d = map(p);
    if (d < 0.0012 * t || t > tmax) break;
    t += d;
  }

  vec3 col = bg;
  // floor plane for the mirrored reflection under the sculpture
  float floorY = -1.2;
  float tf = (floorY - ro.y) / rd.y;
  bool hitObj = t < tmax && d < 0.01 * t;

  if (rd.y < 0.0 && tf > 0.0 && (!hitObj || tf < t)) {
    vec3 fp = ro + rd * tf;
    vec3 fcol = uPal[0] * 0.02;
    if (uReflect > 0.5) {
      vec3 rro = fp + vec3(0.0, 0.002, 0.0), rrd = reflect(rd, vec3(0.0, 1.0, 0.0));
      float rt = 0.0, rdist = 1.0;
      for (int j = 0; j < 48; j++) {
        rdist = map(rro + rrd * rt);
        if (rdist < 0.004 || rt > 5.0) break;
        rt += rdist;
      }
      if (rdist < 0.01) {
        vec3 hp = rro + rrd * rt;
        vec3 n = calcNormal(hp);
        vec3 rc = env(reflect(rrd, n), m) * 0.5 + irid(dot(n, rrd) * 1.5 + m * 0.04) * 0.4;
        fcol += rc * 0.35 * exp(-rt * 0.6);
      }
    }
    // coloured light pool on the floor
    fcol += uPal[2] * 0.12 * exp(-length(fp.xz) * 1.3) * (0.4 + uEnergy);
    float fade = exp(-tf * 0.18) * smoothstep(7.0, 2.0, length(fp.xz));
    col = mix(col, fcol, fade);
  }

  if (hitObj) {
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p);
    vec3 v = -rd;
    float nv = clamp(dot(n, v), 0.0, 1.0);
    float fres = pow(1.0 - nv, 4.0);
    vec3 r = reflect(rd, n);

    // thin-film iridescence: hue shifts with view angle, surface flow and mids
    // colour bands follow the surface orientation (like the mark), drift with
    // flow and the mids, and shift toward the rim (thin-film look)
    float film = 0.5 * n.y + 0.33 * n.x - 0.2 * n.z + (1.0 - nv) * 1.1 + 0.08 * wnoise(p * 1.1 + m * 0.15) + m * 0.03 + 0.3 * uMid + uSeed.z;
    vec3 tint = irid(film);
    vec3 refl = env(r, m);
    vec3 key = normalize(vec3(0.4, 0.8, 0.5));
    float wrap = pow(clamp(dot(n, key) * 0.5 + 0.5, 0.0, 1.0), 1.6);
    vec3 c = tint * (0.015 + 0.8 * pow(wrap, 2.4));
    c += refl * mix(0.45, 1.0, fres) * (0.35 + 0.75 * tint);

    // two key lights
    vec3 l1 = normalize(vec3(0.6, 0.9, 0.4)), l2 = normalize(vec3(-0.7, 0.2, -0.5));
    float s1 = pow(max(dot(reflect(-l1, n), v), 0.0), 64.0);
    float s2 = pow(max(dot(reflect(-l2, n), v), 0.0), 24.0);
    c += vec3(1.0) * s1 * 2.4 + uPal[3] * s2 * 1.4;

    // HIGH: shimmering rim
    float shimmer = 0.6 + 0.4 * sin(p.y * 40.0 + m * 12.0 + p.x * 30.0);
    c += irid(film + 0.3) * fres * (0.6 + 2.2 * uHigh * shimmer + 0.8 * uHat);
    // MID: inner glow (fake subsurface) shifting colour
    c += uPal[2] * 0.25 * uMid * (1.0 - nv);
    // LOW/KICK: hot core pulse
    c += uPal[4] * (0.35 * uKick + 0.6 * uDrop) * pow(nv, 3.0);
    // cheap AO from march effort
    float ao = 1.0 - float(i) / max(uSteps, 1.0) * 0.55;
    col = c * ao;
  }

  // atmospheric glow around the silhouette
  col += uPal[2] * 0.03 * exp(-max(d, 0.0) * 8.0) * (0.3 + uEnergy) * (hitObj ? 0.0 : 1.0);
  outColor = vec4(col, 1.0);
}`;

export class LiquidForm implements World {
  readonly id = 'liquid';
  private prog: Program | null = null;
  private gl!: WebGL2RenderingContext;

  init(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    this.prog = new Program(gl, FS, 'Liquid Form');
  }

  render(f: FrameInput): void {
    const gl = this.gl;
    const P = this.prog!.use();
    const s = f.s;
    const k = f.p.intensity;
    const seed = f.p.seed;
    const sv = (n: number) => ((seed >>> (n * 8)) & 255) / 255;
    P.f('uRes', f.width, f.height)
      .f('uMotion', s.motion)
      .f('uT', s.t)
      .f('uLow', s.low * k)
      .f('uMid', s.mid * k)
      .f('uHigh', s.high * k)
      .f('uKick', s.kick * k)
      .f('uSnare', s.snare * k)
      .f('uHat', s.hat * k)
      .f('uEnergy', s.energy)
      .f('uIntensity', Math.min(1, s.intensity * k))
      .f('uBeat', s.beatPulse)
      .f('uDrop', s.dropImpact * k)
      .f('uBuild', s.build)
      .f('uShapeA', f.p.shapeA)
      .f('uShapeB', f.p.shapeB)
      .f('uMorph', f.p.morph)
      .f('uSeed', sv(0), sv(1), sv(2), sv(3))
      .fv3('uPal', f.p.palette)
      .f('uSteps', [40, 64, 90, 120][f.quality] ?? 64)
      .f('uMotionScale', f.p.motionScale)
      .f('uComplexity', f.p.complexity)
      .f('uCamStyle', f.p.camera)
      .f('uReflect', f.quality >= 1 ? 1 : 0)
      .f('uOffset', f.frameOffset)
      .f('uDetail', [0, 0.5, 1, 1][f.quality] ?? 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    this.prog?.dispose();
    this.prog = null;
  }
}
