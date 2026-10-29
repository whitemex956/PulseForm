import { Program } from '../gl';
import { COMMON, FRAG_COMMON, setCommon } from './common';
import type { FrameInput, World } from '../world';

/**
 * PARTICLE UNIVERSE — tens of thousands of GPU particles that assemble into
 * shapes (sphere, the PulseForm wave, ring, galaxy) and dissolve between them.
 * Positions are computed entirely in the vertex shader from the particle index,
 * so there are no buffers to upload and nothing accumulates frame to frame.
 *   low/kick → expansion and shock scatter
 *   mid      → swirling turbulence
 *   high/hat → twinkle and point size
 */
const VS = /* glsl */ `#version 300 es
${COMMON}
out vec3 vCol;
out float vAlpha;

vec3 h3(float i) { return vec3(hash11(i * 1.13 + 0.1), hash11(i * 2.71 + 3.3), hash11(i * 0.37 + 7.9)); }

vec3 shape(float s, vec3 r, float m) {
  if (s < 0.5) { // sphere shell
    float th = r.x * TAU, ph = acos(2.0 * r.y - 1.0);
    return vec3(sin(ph) * cos(th), cos(ph), sin(ph) * sin(th)) * (1.0 + 0.04 * (r.z - 0.5));
  }
  if (s < 1.5) { // the PulseForm wave ribbon
    float x = (r.x - 0.5) * 3.4;
    float y = 0.38 * sin(x * 2.9 + m * 0.9) * (1.0 - 0.22 * x * x);
    float th = (0.3 * (1.0 - smoothstep(0.3, 1.7, abs(x))) + 0.03) * sqrt(r.z);
    float a = r.y * TAU;
    return vec3(x, y + cos(a) * th, sin(a) * th * 0.6);
  }
  if (s < 2.5) { // ring
    float a = r.x * TAU, b = r.y * TAU;
    float R = 0.85, rr = 0.22 * sqrt(r.z);
    return vec3((R + rr * cos(b)) * cos(a), rr * sin(b), (R + rr * cos(b)) * sin(a));
  }
  // galaxy disc with spiral arms
  float arm = floor(r.z * 3.0);
  float d = pow(r.x, 0.6) * 1.4;
  float a = arm * TAU / 3.0 + d * 3.2 + (r.y - 0.5) * 0.5 - m * 0.15;
  return vec3(cos(a) * d, (r.y - 0.5) * 0.08 * (1.4 - d), sin(a) * d);
}

void main() {
  float id = float(gl_VertexID);
  vec3 r = h3(id);
  float m = uMotion;
  vec3 pa = shape(uShapeA, r, m);
  vec3 pb = shape(uShapeB, r, m);
  // particles leave on slightly different schedules: a dissolve, not a lerp
  float k = clamp(uMorph * 1.6 - r.z * 0.6, 0.0, 1.0);
  k = k * k * (3.0 - 2.0 * k);
  vec3 p = mix(pa, pb, k);
  p += (h3(id + 9.0) - 0.5) * sin(PI * k) * 0.9; // scatter mid-morph

  // MID: swirling turbulence
  vec3 sw = vec3(
    vnoise3(p * 1.7 + vec3(m * 0.3, 0.0, 0.0)),
    vnoise3(p * 1.7 + vec3(0.0, m * 0.3, 3.0)),
    vnoise3(p * 1.7 + vec3(5.0, 0.0, m * 0.3))) - 0.5;
  p += sw * (0.06 + 0.35 * uMid * uComplexity);
  // LOW: breathing expansion, KICK: outward shock
  p *= 1.0 + 0.14 * uLow + 0.06 * uDrop;
  p += normalize(p + 1e-4) * uKick * 0.18 * r.x;

  // camera
  float orbit = m * 0.1 + uSeed.x * TAU;
  if (uCamStyle > 1.5) orbit = 0.2 * sin(m * 0.05);
  float elev = 0.35 + 0.15 * sin(m * 0.07);
  vec3 ro = vec3(sin(orbit), elev, cos(orbit)) * (3.3 - 0.4 * uIntensity);
  vec3 ww = normalize(-ro), uu = normalize(cross(ww, vec3(0, 1, 0))), vv = cross(uu, ww);
  vec3 d = p - ro;
  float z = dot(d, ww);
  vec2 sp = vec2(dot(d, uu), dot(d, vv)) / z * 2.0;
  sp.y += uOffset;
  float fit = max(1.0, 1.2 * uRes.y / uRes.x);
  sp /= fit;
  gl_Position = vec4(sp.x * uRes.y / uRes.x, sp.y, 0.0, 1.0);
  // HIGH: twinkle
  float tw = 0.6 + 0.4 * sin(m * 4.0 + r.y * 60.0);
  float size = (1.4 + 2.6 * r.z * r.z + 3.5 * uHigh * tw * step(0.85, r.x)) * uRes.y / 900.0;
  gl_PointSize = max(1.0, size * 4.0 / z);
  vCol = pal(r.x * 0.45 + length(p) * 0.25 + m * 0.01);
  vCol = mix(vCol, vec3(1.0), step(0.97, r.y) * 0.6);
  vAlpha = (0.25 + 0.75 * uIntensity) * (0.55 + 0.45 * tw) * smoothstep(9.0, 2.0, z);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vCol;
in float vAlpha;
out vec4 outColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.0, d);
  a *= a;
  outColor = vec4(vCol * a * vAlpha, 1.0);
}`;

const BG = /* glsl */ `#version 300 es
${COMMON}
${FRAG_COMMON}
out vec4 outColor;
void main() {
  vec2 uv = screenUv();
  float r = length(uv);
  vec3 col = uPal[0] * 0.015 + uPal[2] * 0.05 * exp(-r * 3.0) * (0.3 + uEnergy);
  outColor = vec4(col, 1.0);
}`;

export class ParticleUniverse implements World {
  readonly id = 'particles';
  private prog: Program | null = null;
  private bg: Program | null = null;
  private gl!: WebGL2RenderingContext;

  init(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    this.prog = new Program(gl, FS, 'particles', VS);
    this.bg = new Program(gl, BG, 'particles-bg');
  }

  render(f: FrameInput): void {
    const gl = this.gl;
    const B = this.bg!.use();
    setCommon(B, f);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const P = this.prog!.use();
    setCommon(P, f);
    const count = [12000, 24000, 48000, 80000][f.quality] ?? 24000;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.POINTS, 0, Math.round(count * (0.5 + 0.5 * f.p.complexity)));
    gl.disable(gl.BLEND);
  }

  dispose(): void {
    this.prog?.dispose();
    this.bg?.dispose();
  }
}
