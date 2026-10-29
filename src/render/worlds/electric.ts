import { ShaderWorld } from './common';

/**
 * ELECTRIC ENERGY — a plasma core wrapped in organically moving energy trails,
 * with lightning that forks out on beats.
 *   low/kick → core swell, shockwave rings, bolt length
 *   mid      → trail thickness and wander
 *   high/hat → sparks and filament crackle
 * Bolts are regenerated from the beat index, so a given moment of a song always
 * draws the same lightning (deterministic for export).
 */
const FS = /* glsl */ `
float bolt(vec2 p, vec2 a, vec2 b, float seed, float amp, out float tpos) {
  vec2 ab = b - a;
  float L = length(ab);
  vec2 dir = ab / L;
  vec2 nrm = vec2(-dir.y, dir.x);
  vec2 ap = p - a;
  float t = clamp(dot(ap, dir) / L, 0.0, 1.0);
  tpos = t;
  float env = sin(PI * t);
  float jag = (fbm(vec2(t * 7.0 + seed * 13.1, seed * 3.7)) - 0.5) * 2.0;
  jag += (vnoise(vec2(t * 40.0, seed * 9.1)) - 0.5) * 0.35;
  float off = jag * amp * env;
  float along = dot(ap, dir) - t * L;
  return length(vec2(dot(ap, nrm) - off, along));
}

void main() {
  vec2 uv = screenUv();
  float m = uMotion;
  float r = length(uv);
  float ang = atan(uv.y, uv.x);
  vec3 col = uPal[0] * 0.015;

  // ---- haze
  col += uPal[1] * 0.02 * exp(-r * 2.6) * (0.3 + uIntensity);

  // ---- energy trails (the signature organic electric ribbons)
  int trails = int(3.0 + 7.0 * uComplexity * (0.3 + 0.7 * uIntensity));
  for (int i = 0; i < 10; i++) {
    if (i >= trails) break;
    float fi = float(i);
    float h = hash11(fi + uSeed.x * 17.0);
    vec2 q = rot(fi * 0.63 + m * (0.05 + 0.04 * h) * (h > 0.5 ? 1.0 : -1.0)) * uv;
    float freq = 3.0 + 4.0 * h;
    float wander = 0.18 + 0.12 * uMid;
    float y = wander * sin(q.x * freq + m * (0.9 + h) + fi) * exp(-q.x * q.x * 0.9)
            + 0.06 * sin(q.x * freq * 2.7 - m * 1.7 + fi * 3.0) * uMid;
    float d = abs(q.y - y);
    float th = 0.0025 + 0.004 * uMid + 0.003 * h;
    float fade = exp(-q.x * q.x * 1.3);
    float g = (th / (d + th)) * fade;
    // mostly electric blue → violet, an occasional hot trail
    vec3 c = h > 0.85 ? pal(0.62) : mix(uPal[1], uPal[2], h * 1.2);
    c = mix(c, vec3(0.8, 0.9, 1.0), 0.25);
    col += c * (g * g * 1.6 + g * 0.035) * (0.12 + 0.88 * uIntensity) * (0.6 + 0.6 * uEnergy);
  }

  // ---- plasma core
  float r0 = 0.15 + 0.05 * uLow + 0.05 * uKick + 0.04 * uDrop;
  // plasma texture in Cartesian space (no seam at the angle wrap)
  vec2 pp = rot(m * 0.07) * uv * 7.0;
  float plasma = fbm(pp + vec2(0.0, m * 0.35)) + 0.5 * fbm(rot(-m * 0.11) * uv * 15.0 - m * 0.4);
  float core = smoothstep(r0, r0 * 0.2, r);
  float rim = exp(-abs(r - r0) * 60.0);
  col += mix(uPal[1], vec3(1.0), 0.45) * core * (0.25 + plasma * 0.9) * (0.4 + uLow + 0.6 * uKick);
  col += pal(0.1 + plasma * 0.3) * rim * (0.8 + 2.0 * uKick);
  col += uPal[2] * 0.12 * exp(-r * 7.0) * (0.2 + uIntensity);

  // ---- shockwave on kicks (one ring per kick, expanding as the kick decays)
  float wave = r0 + (1.0 - uKick) * 0.75;
  col += pal(0.25) * exp(-abs(r - wave) * 90.0) * uKick * 0.9;

  // ---- lightning: new bolts every beat, more and longer when it's intense
  float beatIdx = floor(uBeatTime);
  float life = uHasPulse > 0.5 ? exp(-fract(uBeatTime) * 3.0) : exp(-fract(m * 0.5) * 3.0);
  // lightning is earned: none in calm passages, up to 7 bolts at peaks
  float nb = floor(7.0 * clamp((uIntensity - 0.35) / 0.65, 0.0, 1.0) * (0.5 + 0.5 * uComplexity) + 0.999 * uDrop);
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    if (fi >= nb) break;
    float sd = beatIdx * 7.0 + fi + uSeed.y * 31.0;
    float a0 = hash11(sd) * TAU;
    float len = 0.35 + 0.45 * hash11(sd + 1.3) * (0.5 + uLow + uDrop);
    vec2 A = vec2(cos(a0), sin(a0)) * r0 * 0.9;
    vec2 B = vec2(cos(a0 + 0.3 * (hash11(sd + 2.0) - 0.5)), sin(a0 + 0.3 * (hash11(sd + 2.0) - 0.5))) * (r0 + len);
    float tp;
    float d = bolt(uv, A, B, sd, 0.06 + 0.04 * uHigh, tp);
    float flick = 0.7 + 0.3 * sin(uT * 70.0 + fi * 3.0);
    float g = 0.0012 / (d + 0.0012);
    vec3 bc = mix(vec3(1.0), pal(hash11(sd + 5.0) * 0.5), 0.35);
    col += bc * (g * g * 3.0 + g * 0.25) * life * flick * (0.4 + uIntensity);
    // fork
    vec2 F = mix(A, B, 0.45);
    vec2 G = F + rot(0.7 * (hash11(sd + 7.0) - 0.5) * 2.0) * (B - A) * 0.45;
    float tp2;
    float d2 = bolt(uv, F, G, sd + 0.5, 0.04, tp2);
    float g2 = 0.0009 / (d2 + 0.0009);
    col += bc * (g2 * g2 * 2.0 + g2 * 0.15) * life * flick * (0.3 + uIntensity) * step(0.35, uComplexity);
  }

  // ---- sparks riding the highs
  vec2 sp = vec2(ang * 6.0, log(r + 0.02) * 6.0 - m * 1.8);
  vec2 cell = floor(sp), fr = fract(sp) - 0.5;
  float hs = hash12(cell + floor(m * 2.0));
  if (hs > 0.9 - 0.15 * uHigh) {
    float s = smoothstep(0.08, 0.0, length(fr)) * (0.3 + 1.6 * uHigh + uHat);
    col += pal(hs) * s * smoothstep(0.1, 0.4, r);
  }
  outColor = vec4(col, 1.0);
}`;

export class ElectricEnergy extends ShaderWorld {
  constructor() {
    super('electric', FS);
  }
}
