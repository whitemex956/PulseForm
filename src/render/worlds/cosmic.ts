import { ShaderWorld } from './common';

/**
 * COSMIC DREAMS — drifting through a nebula: layered parallax clouds, a slowly
 * turning spiral of stars, and a breathing celestial body.
 *   low  → cloud luminance swells, the star core breathes
 *   mid  → colour drift through the palette, cloud turbulence
 *   high → star twinkle and dust sparkle
 * Built for calm music: motion stays slow even at high energy.
 */
const FS = /* glsl */ `
vec3 stars(vec2 uv, float scale, float m, float seed) {
  vec2 g = uv * scale;
  vec2 id = floor(g), f = fract(g) - 0.5;
  float h = hash12(id + seed);
  if (h < 0.82) return vec3(0.0);
  vec2 o = (hash22(id + seed) - 0.5) * 0.7;
  float d = length(f - o);
  float tw = 0.55 + 0.45 * sin(m * (1.5 + 3.0 * h) + h * 40.0 + uHigh * 6.0);
  float s = smoothstep(0.06 + 0.04 * uHigh, 0.0, d) * tw;
  s += smoothstep(0.012, 0.0, abs(f.x - o.x)) * smoothstep(0.25, 0.0, abs(f.y - o.y)) * 0.25 * h * (h > 0.97 ? 1.0 : 0.0);
  return mix(vec3(1.0), pal(h * 2.0), 0.35) * s * (0.4 + 0.8 * h);
}

void main() {
  vec2 uv0 = screenUv();
  float m = uMotion * 0.35; // cosmic time runs slow
  vec3 col = uPal[0] * 0.02;

  // slow camera drift + roll
  vec2 uv = rot(0.05 * sin(m * 0.2) + uSeed.x) * uv0;

  // nebula: three parallax layers of domain-warped fbm
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float depth = 1.0 + fl * 0.8;
    vec2 p = uv * (1.2 + fl * 0.7) + vec2(m * 0.05 * depth, m * 0.02) + uSeed.yz * 10.0 + fl * 3.1;
    vec2 w = vec2(fbm(p + m * 0.03), fbm(p + 5.2 - m * 0.02));
    float n = fbm(p + 1.6 * w * (0.8 + 0.6 * uMid));
    float dens = smoothstep(0.5, 1.0, n) * smoothstep(0.2, 0.8, fbm(p * 0.35 + 9.0));
    vec3 c = pal(0.15 * fl + n * 0.6 + m * 0.01 + uMid * 0.15);
    col += c * dens * (0.08 + 0.25 * uLow + 0.1 * uEnergy) / depth * (0.5 + 0.5 * uIntensity);
  }

  // galactic spiral of dust behind the core
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  float arms = 2.0 + floor(uSeed.w * 3.0);
  float spiral = sin(arms * a + log(r + 0.05) * 5.0 - m * 0.6);
  float galaxy = smoothstep(0.2, 1.0, spiral) * exp(-r * 2.2) * smoothstep(0.02, 0.15, r);
  col += pal(0.5 + r) * galaxy * (0.05 + 0.15 * uMid + 0.1 * uEnergy);

  // celestial body: soft star core with corona that breathes with the bass
  float core = 0.05 + 0.03 * uLow + 0.02 * uKick;
  col += mix(uPal[4], vec3(1.0), 0.6) * smoothstep(core, 0.0, r) * (0.8 + 0.6 * uLow);
  col += uPal[3] * exp(-r / (core * 3.0)) * (0.25 + 0.5 * uLow);
  float corona = fbm(vec2(a * 3.0 / TAU * 6.0, r * 8.0 - m)) ;
  col += uPal[2] * exp(-r * 9.0) * corona * (0.3 + uEnergy) * 0.6;

  // stars: three depths
  col += stars(uv + vec2(m * 0.01, 0.0), 22.0, m, 1.0) * 0.9;
  col += stars(uv * 1.3 + vec2(m * 0.02, 0.0), 40.0, m, 7.0) * 0.6;
  col += stars(uv * 1.7 + vec2(m * 0.035, 0.0), 75.0, m, 13.0) * 0.4 * (0.4 + uHigh);

  // a gentle swell on drops (no strobe in this world)
  col *= 1.0 + 0.35 * uDrop;
  outColor = vec4(col, 1.0);
}`;

export class CosmicDreams extends ShaderWorld {
  constructor() {
    super('cosmic', FS);
  }
}
