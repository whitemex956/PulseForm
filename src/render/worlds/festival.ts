import { Program } from '../gl';
import { COMMON, FRAG_COMMON, setCommon } from './common';
import type { FrameInput, World } from '../world';

/**
 * FESTIVAL MODE — first person, in the crowd, facing a main stage.
 *
 * Everything is analytic 3D (ray/plane hits and ray/line closest approach), so
 * it stays fast on laptops and phones while reading as real volumetric light:
 *   - arched LED wall (optionally showing another world as stage content)
 *   - moving-head beams through haze, choreographed on the beat grid
 *   - laser fans over the crowd and a laser "ceiling" in the big moments
 *   - pyro, CO2 jets and confetti on detected drops
 *   - crowd silhouettes in front of you that bounce on kicks; phone lights in breakdowns
 *
 * Restraint is built in: breakdowns fall back to haze and a single spot, builds
 * tighten the light chases, and only drops light everything at once.
 * Flashes/strobes are scaled by uFlash, which the engine's flash guard limits.
 */
const FS = /* glsl */ `
uniform sampler2D uScreen;
uniform float uScreenOn;
out vec4 outColor;

const float WALL_Z = 44.0;
const float STAGE_Z = 31.0;

// closest approach between view ray (ro, rd) and a line (o, d), s >= 0 along the line
// returns (distance, s along beam, t along view)
vec3 rayLine(vec3 ro, vec3 rd, vec3 o, vec3 d) {
  vec3 w = ro - o;
  float b = dot(rd, d), dd = dot(rd, w), e = dot(d, w);
  float den = 1.0 - b * b;
  float t = den > 1e-4 ? (b * e - dd) / den : 0.0;
  float s = den > 1e-4 ? (e - b * dd) / den : e;
  t = max(t, 0.0);
  s = max(s, 0.0);
  vec3 p1 = ro + rd * t, p2 = o + d * s;
  return vec3(length(p1 - p2), s, t);
}

float haze(vec3 p) {
  return 0.45 + 0.55 * fbm(p.xz * 0.06 + vec2(uMotion * 0.04, -uMotion * 0.02) + p.y * 0.05);
}

vec3 wallContent(vec2 wuv, float m) {
  // stage content: another world rendered by the engine, or a procedural show
  if (uScreenOn > 0.5) return texture(uScreen, wuv).rgb * 1.6;
  vec2 c = wuv - vec2(0.5, 0.45);
  float r = length(c * vec2(1.6, 1.0));
  float a = atan(c.y, c.x);
  float bar = floor(uBeatTime / 4.0);
  float pat = mod(bar + floor(uSeed.z * 4.0), 4.0);
  float v;
  if (pat < 1.0) v = 0.5 + 0.5 * sin(r * 28.0 - m * 4.0);
  else if (pat < 2.0) v = step(0.6, fract(a / TAU * 12.0 + m * 0.3)) * smoothstep(0.7, 0.1, r);
  else if (pat < 3.0) v = step(abs(c.y - 0.25 * sin(c.x * 9.0 + m * 2.0)), 0.04 + 0.12 * uLow);
  else v = smoothstep(0.35, 0.0, abs(fract(r * 4.0 - m * 0.6) - 0.5));
  return pal(r * 0.8 + bar * 0.17 + m * 0.02) * v;
}

vec3 sceneRay(vec3 ro, vec3 rd, float m, out float hitT) {
  vec3 col = vec3(0.0);
  hitT = 1e4;
  float I = uIntensity;
  float drop = uDrop;
  float party = clamp(I * 1.2 - 0.15, 0.0, 1.0); // 0 calm … 1 full show

  // ---------- LED wall (arched) ----------
  if (rd.z > 0.0) {
    float t = (WALL_Z - ro.z) / rd.z;
    vec3 p = ro + rd * t;
    float halfW = 30.0;
    float top = 4.0 + 15.0 * sqrt(max(0.0, 1.0 - pow(p.x / halfW, 2.0)));
    if (abs(p.x) < halfW && p.y > 1.5 && p.y < top) {
      hitT = t;
      vec2 wuv = vec2(p.x / (2.0 * halfW) + 0.5, (p.y - 1.5) / 17.5);
      vec2 grid = fract(p.xy * 3.0) - 0.5;
      float led = smoothstep(0.5, 0.25, max(abs(grid.x), abs(grid.y)));
      float bright = 0.18 + 0.55 * party + 0.6 * uKick * party + 0.5 * drop;
      col += wallContent(wuv, m) * mix(0.55, 1.0, led) * bright;
      // edge trim
      float edge = smoothstep(0.35, 0.0, abs(p.y - top)) + smoothstep(0.35, 0.0, abs(abs(p.x) - halfW + 0.2));
      col += pal(m * 0.05) * edge * (0.3 + party);
    }
    // side LED columns
    for (int sidei = 0; sidei < 2; sidei++) {
      float sx = sidei == 0 ? -36.0 : 36.0;
      float tz = (WALL_Z - 3.0 - ro.z) / rd.z;
      vec3 q = ro + rd * tz;
      if (abs(q.x - sx) < 2.6 && q.y > 0.0 && q.y < 30.0 && tz < hitT) {
        hitT = tz;
        float bars = step(0.5, fract(q.y * 0.5 - m * (0.5 + 2.0 * party) + float(sidei) * 0.5));
        col += pal(q.y * 0.03 + float(sidei) * 0.3) * bars * (0.12 + 0.6 * party + 0.6 * uKick * party);
      }
    }
  }

  // ---------- stage deck front + LED strip ----------
  if (rd.z > 0.0) {
    float t = (STAGE_Z - ro.z) / rd.z;
    vec3 p = ro + rd * t;
    if (t < hitT && abs(p.x) < 34.0 && p.y < 2.0 && p.y > -0.5) {
      hitT = t;
      col = vec3(0.004);
      col += pal(p.x * 0.02 + m * 0.1) * smoothstep(0.12, 0.0, abs(p.y - 1.85)) * (0.4 + 1.2 * party);
    }
  }

  // ---------- ground (wet look: faint reflection of the wall) ----------
  if (rd.y < 0.0) {
    float t = -ro.y / rd.y;
    if (t < hitT) {
      hitT = t;
      vec3 p = ro + rd * t;
      vec3 rr = reflect(rd, vec3(0.0, 1.0, 0.0));
      float tw = (WALL_Z - p.z) / max(rr.z, 1e-3);
      vec3 pw = p + rr * tw;
      vec2 wuv = vec2(pw.x / 60.0 + 0.5, (pw.y - 1.5) / 25.5);
      float inWall = step(abs(pw.x), 30.0) * step(1.5, pw.y) * step(pw.y, 26.0);
      col = wallContent(wuv, m) * inWall * 0.08 * (0.3 + party) * fbm(p.xz * 0.5);
    }
  }

  // ---------- volumetric moving-head beams ----------
  float heads = floor(2.0 + 10.0 * smoothstep(0.15, 0.85, I) * (0.6 + 0.4 * uComplexity));
  // chase speed tightens through a build: 1, 2, 4 hits per beat
  float sub = uBuild > 0.66 ? 4.0 : uBuild > 0.33 ? 2.0 : 1.0;
  float bt = uHasPulse > 0.5 ? uBeatTime : m * 0.5;
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    if (fi >= heads) break;
    float x = (fi + 0.5) / heads * 52.0 - 26.0;
    vec3 o = vec3(x, 22.0, WALL_Z - 4.0);
    float side = mod(fi, 2.0) * 2.0 - 1.0;
    float pan = 0.5 * sin(bt * PI * 0.25 * (0.8 + 0.3 * uMid) + fi * 0.9 + uSeed.x * 6.0) * side;
    float tilt = 0.55 + 0.25 * sin(bt * PI * 0.125 + fi * 1.7);
    // calm passages: beams point down onto the stage, big moments: out over the crowd
    tilt = mix(0.15, tilt, party);
    vec3 d = normalize(vec3(sin(pan), -cos(tilt) * 0.9, -sin(tilt)));
    vec3 cl = rayLine(ro, rd, o, d);
    if (cl.z > hitT) continue;
    float w = 0.12 + cl.y * 0.045;
    float beamI = exp(-cl.x * cl.x / (w * w)) * exp(-cl.y * 0.018);
    // chase: heads take turns on the beat subdivision
    float chase = 0.55 + 0.45 * step(0.5, fract((bt * sub + fi * 0.5) * 0.5));
    chase = mix(1.0, chase, smoothstep(0.3, 0.8, I));
    vec3 bc = pal(fi / heads * 0.6 + floor(bt / 8.0) * 0.21);
    col += bc * beamI * haze(ro + rd * cl.z) * (0.06 + 0.5 * party + 0.6 * uKick * party) * chase;
    // fixture glare
    float glare = exp(-length(cross(rd, o - ro)) * 3.0 / max(1.0, length(o - ro) * 0.08));
    col += bc * glare * 0.25 * (0.2 + party);
  }

  // ---------- laser fans over the crowd ----------
  float laserOn = smoothstep(0.62, 0.9, I) + drop + 0.6 * uBuild * step(0.5, uBuild);
  if (laserOn > 0.01) {
    float n = 6.0 + floor(uComplexity * 10.0);
    float sweep = 0.55 * sin(bt * PI * 0.5);
    for (int j = 0; j < 16; j++) {
      float fj = float(j);
      if (fj >= n) break;
      for (int k = 0; k < 2; k++) {
        float ox = k == 0 ? -10.0 : 10.0;
        vec3 o = vec3(ox, 2.6, STAGE_Z + 0.5);
        float a = (fj / (n - 1.0) - 0.5) * 1.4 + sweep * (k == 0 ? 1.0 : -1.0);
        float lift = 0.08 + 0.05 * sin(bt * PI * 0.25 + fj);
        vec3 d = normalize(vec3(sin(a), lift, -cos(a)));
        vec3 cl = rayLine(ro, rd, o, d);
        if (cl.z > hitT) continue;
        float w = 0.025 + cl.y * 0.0015;
        float li = exp(-cl.x * cl.x / (w * w)) * exp(-cl.y * 0.01);
        vec3 lc = mix(pal(0.08 + fj * 0.02), vec3(1.0), 0.25);
        col += lc * li * laserOn * haze(ro + rd * cl.z) * 1.4;
      }
    }
    // laser ceiling: a scanned sheet above the crowd in drops
    if (rd.y > 0.0) {
      float tc = (11.0 - ro.y) / rd.y;
      vec3 p = ro + rd * tc;
      if (tc < hitT && p.z > -6.0 && p.z < STAGE_Z) {
        float lines = smoothstep(0.06, 0.0, abs(fract(p.x * 0.35 + sin(p.z * 0.15 + m) * 0.5) - 0.5));
        lines *= 0.6 + 0.4 * sin(p.z * 0.4 - m * 8.0);
        col += pal(0.35 + p.z * 0.01) * lines * smoothstep(0.75, 1.0, I) * drop * 0.9 * exp(-tc * 0.03);
      }
    }
  }

  // ---------- strobes on the truss (flash-guard limited) ----------
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    vec3 sp = vec3(fi * 10.0 - 25.0, 23.5, WALL_Z - 5.0);
    float dd = length(cross(rd, sp - ro)) / length(sp - ro);
    col += vec3(1.0) * (smoothstep(0.012, 0.0, dd) * 5.0 + smoothstep(0.08, 0.0, dd) * 0.4) * uFlash;
  }

  // ---------- haze ambient lit by the show ----------
  col += (uPal[1] * 0.025 + uPal[2] * 0.02) * (0.2 + party) * haze(ro + rd * 20.0) * smoothstep(-0.1, 0.3, rd.y);
  return col;
}

vec3 pyro(vec2 uv, vec2 base, float h, float seed, float m) {
  vec2 q = (uv - base) / vec2(h * 0.18, h);
  if (q.y < 0.0 || q.y > 1.2 || abs(q.x) > 1.0) return vec3(0.0);
  float n = fbm(vec2(q.x * 3.0 + seed, q.y * 2.5 - uT * 6.0));
  float shape = smoothstep(0.9, 0.2, abs(q.x) + q.y * 0.6 - n * 0.6);
  vec3 c = mix(vec3(1.0, 0.85, 0.5), vec3(1.0, 0.32, 0.05), smoothstep(0.0, 1.0, q.y));
  return c * shape * 1.6;
}

void main() {
  vec2 uv = screenUv();
  float m = uMotion;
  float I = uIntensity;

  // ---------- camera: standing in the crowd ----------
  float bounce = (0.06 * uKick + 0.03 * uBeat) * uMotionScale * smoothstep(0.4, 0.9, I);
  vec3 ro = vec3(1.5 * sin(m * 0.05) * uMotionScale, 1.75 + bounce, -2.0);
  if (uCamStyle > 0.5 && uCamStyle < 1.5) ro = vec3(8.0 * sin(m * 0.03), 1.75 + bounce, -6.0 + 4.0 * sin(m * 0.02));
  if (uCamStyle > 1.5) ro = vec3(0.5 * sin(m * 0.07), 1.6 + bounce, 18.0);
  // push toward the stage through a build, punch in on the drop
  ro.z += (3.0 * uBuild + 2.0 * uDrop) * uMotionScale;
  vec3 ta = vec3(0.0, 7.5 + 1.5 * sin(m * 0.04), WALL_Z);
  ta.x += 2.0 * sin(m * 0.06) * uMotionScale;
  vec3 ww = normalize(ta - ro);
  vec3 uu = normalize(cross(ww, vec3(0.0, 1.0, 0.0)));
  vec3 vv = cross(uu, ww);
  float roll = 0.015 * sin(m * 0.4) * uMotionScale + 0.01 * uKick * uMotionScale;
  vec2 ruv = rot(roll) * uv;
  vec3 rd = normalize(ruv.x * uu + ruv.y * vv + 1.25 * ww);

  float hitT;
  vec3 col = sceneRay(ro, rd, m, hitT);

  // ---------- pyro + CO2 on drops ----------
  float pyroOn = uDrop * smoothstep(0.6, 0.9, I);
  if (pyroOn > 0.02 || uBuild > 0.9) {
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      float x = (fi < 2.0 ? -1.0 : 1.0) * (8.0 + mod(fi, 2.0) * 9.0);
      vec3 bp = vec3(x, 2.0, STAGE_Z);
      vec3 rel = bp - ro;
      float z = dot(rel, ww);
      vec2 sp = vec2(dot(rel, uu), dot(rel, vv)) / z * 1.25;
      float h = 7.0 / z * 1.25 * pyroOn;
      col += pyro(ruv, sp, h, fi * 7.0, m) * pyroOn;
      // CO2 jet: cold white plume during the last moments of a build
      float co2 = smoothstep(0.9, 1.0, uBuild) + uDrop * 0.5;
      vec2 q = (ruv - sp) / vec2(0.035, 0.35 * 12.0 / z);
      if (q.y > 0.0 && q.y < 1.0) {
        float plume = smoothstep(1.0, 0.0, abs(q.x) / (0.3 + q.y)) * fbm(vec2(q.x * 4.0, q.y * 3.0 - uT * 8.0));
        col += vec3(0.9, 0.95, 1.0) * plume * co2 * 0.8;
      }
    }
    // warm light from the fire on everything
    col += vec3(1.0, 0.45, 0.15) * 0.03 * pyroOn;
  }

  // ---------- confetti after a drop ----------
  float confetti = exp(-uSinceDrop / 6.0) * step(uSinceDrop, 9.0) * smoothstep(0.55, 0.85, I);
  if (confetti > 0.01) {
    for (int l = 0; l < 3; l++) {
      float fl = float(l);
      float sc = 10.0 + fl * 9.0;
      vec2 g = ruv * sc + vec2(sin(uT * 0.7 + fl) * 0.6, uSinceDrop * (1.6 + fl * 0.6));
      vec2 id = floor(g), f = fract(g) - 0.5;
      float h = hash12(id + fl * 17.0);
      if (h > 0.55) {
        f = rot(uT * (2.0 + h * 6.0)) * (f - (hash22(id) - 0.5) * 0.5);
        float flutter = abs(sin(uT * (5.0 + h * 8.0) + h * 20.0));
        float piece = step(abs(f.x), 0.06 * flutter + 0.01) * step(abs(f.y), 0.1);
        vec3 cc = h > 0.9 ? vec3(1.0) : pal(h * 3.0);
        col += cc * piece * confetti * (1.4 - fl * 0.3);
      }
    }
  }

  // ---------- crowd in front of you ----------
  vec3 rim = pal(m * 0.05) * (0.15 + 0.6 * I);
  for (int row = 0; row < 3; row++) {
    float fr = float(row);
    float scale = 1.0 - fr * 0.3;
    float base = -0.6 + fr * 0.075;
    float spacing = 5.5 + fr * 1.5;
    float xr = ruv.x / scale * spacing + fr * 13.7;
    float person = floor(xr);
    float ph = hash11(person + fr * 31.0);
    float ph2 = hash11(person * 1.7 + fr * 5.0);
    float px = fract(xr) - 0.5 + (ph2 - 0.5) * 0.3;
    float jump = uMotionScale * (0.03 * uKick * step(0.35, ph) + 0.012 * uBeat) * scale * smoothstep(0.45, 0.9, I);
    float headY = base + (0.16 + 0.05 * ph) * scale + jump;
    float hr = (0.042 + 0.01 * ph2) * scale;
    vec2 hp = vec2(px / spacing * scale * 1.0, ruv.y - headY);
    float head = length(hp * vec2(1.0, 0.85)) - hr;
    // shoulders: a rounded slope below the head
    float sy = headY - hr * 1.6;
    float shoulderW = (0.11 + 0.03 * ph) * scale;
    float shoulder = abs(px / spacing * scale) - shoulderW * smoothstep(sy + 0.02 * scale, sy - 0.06 * scale, ruv.y);
    float body = step(shoulder, 0.0) * step(ruv.y, sy + 0.02 * scale);
    // hands up: more in drops, a few whenever the music is up
    float handsUp = step(0.85 - 0.55 * uDrop - 0.2 * smoothstep(0.7, 1.0, I), hash11(person * 3.1 + fr));
    // a raised arm: slanted forearm from the shoulder with a small fist
    float side = ph2 > 0.5 ? 1.0 : -1.0;
    float sway = 0.25 * sin(uBeatTime * PI + person) * uMotionScale;
    vec2 a0 = vec2(side * shoulderW * 0.7, sy - headY + hr * 0.4);
    vec2 a1 = a0 + vec2(side * (0.025 + 0.02 * sway), 0.1) * scale;
    vec2 pa = vec2(px / spacing * scale, ruv.y - headY);
    vec2 ba = a1 - a0;
    float hseg = clamp(dot(pa - a0, ba) / dot(ba, ba), 0.0, 1.0);
    float armD = length(pa - a0 - ba * hseg) - 0.0065 * scale;
    float fist = length(pa - a1) - 0.011 * scale;
    float arm = step(min(armD, fist), 0.0) * handsUp;
    float armX = a1.x;
    float sil = max(max(step(head, 0.0), body), arm);
    if (sil > 0.0) {
      float edge = smoothstep(0.006, 0.0, abs(head)) * step(headY - hr * 0.3, ruv.y);
      col = vec3(0.003) + rim * edge * 0.5 * (1.0 - fr * 0.3);
      // phone lights held up in breakdowns
      float phone = step(0.88, hash11(person * 7.7 + fr)) * smoothstep(0.45, 0.2, I);
      vec2 pp = vec2(px / spacing * scale - armX, ruv.y - headY - 0.1 * scale - 0.015 * scale);
      col += vec3(1.0, 0.97, 0.9) * smoothstep(0.006 * scale, 0.0, length(pp * vec2(1.0, 0.6))) * phone * 2.5;
    }
  }
  outColor = vec4(col, 1.0);
}`;

export class FestivalMode implements World {
  readonly id = 'festival';
  readonly ownFlash = true;
  private prog: Program | null = null;
  private gl!: WebGL2RenderingContext;
  private blank: WebGLTexture | null = null;

  init(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    this.prog = new Program(gl, `#version 300 es\n${COMMON}\n${FRAG_COMMON}\n${FS}`, 'festival');
    this.blank = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.blank);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  }

  render(f: FrameInput): void {
    const P = this.prog!.use();
    setCommon(P, f);
    P.tex('uScreen', 0, f.screen ?? this.blank!).f('uScreenOn', f.screen ? 1 : 0);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    this.prog?.dispose();
    if (this.blank) this.gl.deleteTexture(this.blank);
  }
}
