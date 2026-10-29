import { Program } from '../gl';
import type { FrameInput } from '../world';

/** GLSL shared by every world: audio uniforms, palette, noise. */
export const COMMON = /* glsl */ `
precision highp float;
uniform vec2 uRes;
uniform float uT, uMotion;
uniform float uLow, uMid, uHigh, uKick, uSnare, uHat, uTransient, uEnergy, uIntensity;
uniform float uBeat, uBeatPhase, uBeatTime, uDownbeat, uDrop, uBuild, uFlash;
uniform float uHasPulse, uSinceDrop, uSectionProgress, uSection;
uniform vec4 uSeed;
uniform vec3 uPal[5];
uniform float uQuality, uMotionScale, uComplexity, uOffset, uCamStyle;
uniform float uShapeA, uShapeB, uMorph;

#define PI 3.14159265
#define TAU 6.2831853

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = rot(0.6) * p * 2.03 + 11.7; a *= 0.5; }
  return s;
}
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n = i.x + i.y * 57.0 + i.z * 113.0;
  float a = hash11(n), b = hash11(n + 1.0), c = hash11(n + 57.0), d = hash11(n + 58.0);
  float e = hash11(n + 113.0), f1 = hash11(n + 114.0), g = hash11(n + 170.0), h = hash11(n + 171.0);
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, f1, u.x), mix(g, h, u.x), u.y), u.z);
}
float fbm3(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise3(p); p = p * 2.02 + 7.3; a *= 0.5; }
  return s;
}
// cyclic gradient through primary → secondary → accent → hot
vec3 pal(float x) {
  x = fract(x);
  if (x < 0.25) return mix(uPal[1], uPal[2], smoothstep(0.0, 0.25, x));
  if (x < 0.5) return mix(uPal[2], uPal[3], smoothstep(0.25, 0.5, x));
  if (x < 0.75) return mix(uPal[3], uPal[4], smoothstep(0.5, 0.75, x));
  return mix(uPal[4], uPal[1], smoothstep(0.75, 1.0, x));
}
`;

/** Fragment-only helpers (use gl_FragCoord). */
export const FRAG_COMMON = /* glsl */ `
vec2 screenUv() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  uv.y -= uOffset;
  uv *= max(1.0, 1.2 * uRes.y / uRes.x);
  return uv;
}
`;

/** Push the standard uniforms every world uses. */
export function setCommon(P: Program, f: FrameInput): void {
  const s = f.s;
  const k = f.p.intensity;
  const seed = f.p.seed;
  const sv = (n: number) => ((seed >>> (n * 8)) & 255) / 255;
  P.f('uRes', f.width, f.height)
    .f('uT', s.t % 10000)
    .f('uMotion', s.motion * f.p.motionScale)
    .f('uLow', s.low * k)
    .f('uMid', s.mid * k)
    .f('uHigh', s.high * k)
    .f('uKick', s.kick * k)
    .f('uSnare', s.snare * k)
    .f('uHat', s.hat * k)
    .f('uTransient', s.transient * k)
    .f('uEnergy', s.energy)
    .f('uIntensity', Math.min(1, s.intensity * k))
    .f('uBeat', s.beatPulse)
    .f('uBeatPhase', s.beatPhase)
    .f('uBeatTime', s.beatTime)
    .f('uDownbeat', s.downbeatPulse)
    .f('uDrop', s.dropImpact * k)
    .f('uBuild', s.build)
    .f('uFlash', s.flash)
    .f('uHasPulse', s.hasPulse ? 1 : 0)
    .f('uSinceDrop', Number.isFinite(s.sinceDrop) ? Math.min(1e4, s.sinceDrop) : 1e4)
    .f('uSectionProgress', s.sectionProgress)
    .f('uSection', ['intro', 'verse', 'build', 'drop', 'breakdown', 'peak', 'outro', 'ambient'].indexOf(s.section))
    .f('uSeed', sv(0), sv(1), sv(2), sv(3))
    .fv3('uPal', f.p.palette)
    .f('uQuality', f.quality)
    .f('uMotionScale', f.p.motionScale)
    .f('uComplexity', f.p.complexity)
    .f('uOffset', f.frameOffset)
    .f('uCamStyle', f.p.camera)
    .f('uShapeA', f.p.shapeA)
    .f('uShapeB', f.p.shapeB)
    .f('uMorph', f.p.morph);
}

/** A world that is a single full-screen fragment shader. */
export class ShaderWorld {
  private prog: Program | null = null;
  protected gl!: WebGL2RenderingContext;
  constructor(readonly id: string, private fs: string) {}
  init(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    this.prog = new Program(gl, `#version 300 es\n${COMMON}\n${FRAG_COMMON}\nout vec4 outColor;\n${this.fs}`, this.id);
  }
  render(f: FrameInput): void {
    const P = this.prog!.use();
    setCommon(P, f);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }
  dispose(): void {
    this.prog?.dispose();
    this.prog = null;
  }
}
