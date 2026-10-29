import { ShaderWorld } from './common';

/**
 * LASER DIMENSION — flying down a corridor of light. A polar tunnel of grid
 * lines rushes past; laser fans sweep from the vanishing point in time with
 * the beat; geometric rings fire on downbeats.
 *   low/kick → ring launches, tunnel pulse
 *   mid      → tunnel twist and grid density
 *   high/hat → beam scintillation, scanline shimmer
 *   tempo    → beam sweeps lock to the beat phase (estimated grid)
 */
const FS = /* glsl */ `
float line(float x, float w) { return smoothstep(w, 0.0, abs(x)); }

void main() {
  vec2 uv = screenUv();
  float m = uMotion;
  vec3 col = uPal[0] * 0.01;

  // vanishing point drifts a little
  vec2 vp = 0.06 * vec2(sin(m * 0.13), cos(m * 0.11)) * uMotionScale;
  vec2 q = uv - vp;
  float r = length(q);
  float a = atan(q.y, q.x);

  // ---- tunnel: depth = 1/r, rushing toward us
  float twist = 0.25 * sin(m * 0.07) + 0.4 * uMid;
  float z = 0.35 / max(r, 0.02) + m * (1.2 + 0.8 * uIntensity);
  float sides = 4.0 + floor(uSeed.x * 4.0);
  float seg = (a + twist * z * 0.1) / TAU * sides * (1.0 + floor(uComplexity * 2.0));
  float ringLines = line(fract(z * 0.5) - 0.5, 0.03 + 0.02 * uLow);
  float segLines = line(fract(seg) - 0.5, 0.025);
  float fog = smoothstep(0.0, 0.5, r);
  float tunnel = max(ringLines, segLines * 0.6) * fog;
  col += pal(z * 0.03 + 0.1) * tunnel * (0.2 + 0.7 * uIntensity) * (0.7 + uLow * 0.8);

  // ---- laser fans: beams from the vanishing point, sweeping on the beat
  float nBeams = floor(3.0 + 9.0 * uComplexity * uIntensity);
  float sweep = uHasPulse > 0.5 ? sin(uBeatTime * PI * 0.5) : sin(m * 0.4);
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    if (fi >= nBeams) break;
    float base = (fi / nBeams) * TAU + uSeed.y * TAU;
    float ang = base + sweep * 0.6 * (mod(fi, 2.0) * 2.0 - 1.0);
    float da = abs(mod(a - ang + PI, TAU) - PI);
    float w = 0.004 + 0.01 * r;
    float beam = smoothstep(w, 0.0, da * r) * smoothstep(0.02, 0.2, r);
    float scint = 0.75 + 0.25 * sin(r * 80.0 - m * 20.0 + fi);
    vec3 bc = pal(fi / nBeams * 0.5 + 0.05);
    col += bc * beam * scint * (0.25 + 1.4 * uIntensity) * (0.8 + uHat);
    col += bc * smoothstep(w * 6.0, 0.0, da * r) * 0.08 * uIntensity;
  }

  // ---- rings launched on downbeats (and kicks), expanding outward
  float ringT = uHasPulse > 0.5 ? fract(uBeatTime * 0.25) : fract(m * 0.1);
  float ringR = ringT * 1.4;
  float poly = cos(PI / sides) / cos(mod(a + m * 0.05, TAU / sides) - PI / sides);
  float ring = line(r / poly - ringR, 0.006 + 0.01 * uDownbeat) * (1.0 - ringT);
  col += pal(0.3) * ring * (0.4 + 1.5 * uDownbeat + 0.6 * uKick) * smoothstep(0.3, 0.6, uIntensity + uDownbeat);

  // ---- vanishing-point glow and kick pulse
  col += mix(uPal[1], vec3(1.0), 0.5) * exp(-r * 18.0) * (0.3 + 1.2 * uKick + 0.8 * uDrop);

  // ---- scanline shimmer with the highs
  col *= 1.0 + 0.12 * uHigh * sin(gl_FragCoord.y * 1.5 + m * 30.0);
  outColor = vec4(col, 1.0);
}`;

export class LaserDimension extends ShaderWorld {
  constructor() {
    super('laser', FS);
  }
}
