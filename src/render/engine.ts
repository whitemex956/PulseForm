import { Program, Target } from './gl';
import type { FrameInput, World, WorldParams } from './world';
import type { VisualState } from '../timeline/timeline';

/**
 * Render engine: world → HDR target → bloom → composite (tonemap, flash,
 * vignette, grain) → screen. Owns adaptive quality and the flash safety guard.
 */

const BLOOM_DOWN = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform vec2 uTexel; uniform float uThreshold;
void main() {
  vec2 h = uTexel * 0.5;
  vec3 c = texture(uTex, vUv).rgb * 4.0;
  c += texture(uTex, vUv - h).rgb + texture(uTex, vUv + h).rgb;
  c += texture(uTex, vUv + vec2(h.x, -h.y)).rgb + texture(uTex, vUv - vec2(h.x, -h.y)).rgb;
  c /= 8.0;
  if (uThreshold > 0.0) {
    float l = max(c.r, max(c.g, c.b));
    c *= smoothstep(uThreshold, uThreshold * 1.8, l);
  }
  o = vec4(c, 1.0);
}`;

const BLOOM_UP = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform vec2 uTexel;
void main() {
  vec2 h = uTexel * 0.5;
  vec3 c = texture(uTex, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
  c += texture(uTex, vUv + vec2(-h.x, h.y)).rgb * 2.0;
  c += texture(uTex, vUv + vec2(0.0, h.y * 2.0)).rgb;
  c += texture(uTex, vUv + vec2(h.x, h.y)).rgb * 2.0;
  c += texture(uTex, vUv + vec2(h.x * 2.0, 0.0)).rgb;
  c += texture(uTex, vUv + vec2(h.x, -h.y)).rgb * 2.0;
  c += texture(uTex, vUv + vec2(0.0, -h.y * 2.0)).rgb;
  c += texture(uTex, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
  o = vec4(c / 12.0, 1.0);
}`;

const COMPOSITE = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uScene, uBloom;
uniform float uBloomStrength, uExposure, uFlash, uCA, uGrain, uTime, uVignette;
uniform vec3 uFlashColor;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 d = vUv - 0.5;
  vec3 c;
  if (uCA > 0.0) {
    vec2 off = d * uCA;
    c = vec3(texture(uScene, vUv + off).r, texture(uScene, vUv).g, texture(uScene, vUv - off).b);
  } else c = texture(uScene, vUv).rgb;
  c += texture(uBloom, vUv).rgb * uBloomStrength;
  c += uFlashColor * uFlash;
  c *= uExposure;
  c = aces(c);
  c *= mix(1.0, smoothstep(1.05, 0.25, length(d * vec2(1.0, 0.85))), uVignette);
  c = pow(c, vec3(1.0 / 2.2));
  c += (hash(vUv * 977.0 + uTime) - 0.5) * uGrain;
  o = vec4(c, 1.0);
}`;

export interface EngineSettings {
  /** cap flashes to 3/s and limit their brightness (always on) */
  photosensitive: boolean;
  reducedMotion: boolean;
  /** 'auto' adapts; fixed tiers for testing / low-power */
  quality: 'auto' | 0 | 1 | 2 | 3;
  /** max device pixel ratio */
  maxDpr: number;
  /** lift the subject above a bottom UI band (fraction of height) */
  frameOffset: number;
  /** world shown on the Festival Mode LED wall (null = procedural show) */
  stageWorld: string | null;
  /** render at an exact pixel size, no adaptive scaling (export) */
  fixedSize?: { w: number; h: number };
}

export interface EngineStats {
  fps: number;
  frameMs: number;
  renderScale: number;
  quality: number;
  width: number;
  height: number;
  flashesSuppressed: number;
  contextLost: boolean;
}

/**
 * Flash safety. Independent of any world: every flash request passes here.
 * - never more than 3 flash onsets per second (WCAG 2.3.1 general flash threshold)
 * - flash brightness capped; photosensitive mode removes flashes entirely
 */
export class FlashGuard {
  private lastOnset = -10;
  private prev = 0;
  private onsets: number[] = [];
  private admitted = false;
  suppressed = 0;
  apply(want: number, t: number, photosensitive: boolean): number {
    if (photosensitive) {
      this.prev = 0;
      this.admitted = false;
      return 0;
    }
    const rising = want > 0.25 && this.prev <= 0.25;
    if (want <= 0.25) this.admitted = false;
    this.prev = want;
    this.onsets = this.onsets.filter((x) => t - x < 1);
    if (rising) {
      if (t - this.lastOnset < 0.34 || this.onsets.length >= 3) {
        this.suppressed++;
        this.admitted = false;
      } else {
        this.admitted = true;
        this.lastOnset = t;
        this.onsets.push(t);
      }
    }
    // only a pulse whose onset was admitted may glow, and only while it lasts
    return this.admitted ? Math.min(0.35, want * 0.35) : 0;
  }
  /** for tests: onsets in the last second */
  get recent(): number {
    return this.onsets.length;
  }
}

export class Engine {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  settings: EngineSettings = { photosensitive: false, reducedMotion: false, quality: 'auto', maxDpr: 2, frameOffset: 0.08, stageWorld: null };
  readonly stats: EngineStats = { fps: 0, frameMs: 0, renderScale: 1, quality: 2, width: 0, height: 0, flashesSuppressed: 0, contextLost: false };
  private worlds = new Map<string, World>();
  private scene: Target;
  private sceneB: Target;
  private bloom: Target[] = [];
  private pDown!: Program;
  private pUp!: Program;
  private pComp!: Program;
  private pMix!: Program;
  private vao: WebGLVertexArrayObject;
  private guard = new FlashGuard();
  private scale: number;
  private tier: number;
  private slowFor = 0;
  private fastFor = 0;
  private emaMs = 16;
  private lastFrame = 0;
  private frames: number[] = [];
  private hdr: boolean;
  /** world crossfade */
  private fade: { from: string; to: string; start: number; dur: number; fromParams: WorldParams } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: !!(window as unknown as { __pfTest?: unknown }).__pfTest });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    this.gl = gl;
    this.hdr = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    this.vao = gl.createVertexArray()!;
    this.scene = new Target(gl, this.hdr);
    this.sceneB = new Target(gl, this.hdr);
    for (let i = 0; i < 5; i++) this.bloom.push(new Target(gl, this.hdr));
    this.buildPrograms();
    const mobile = /iPhone|iPad|Android/i.test(navigator.userAgent) || Math.min(screen.width, screen.height) < 600;
    this.tier = mobile ? 1 : 2;
    this.scale = mobile ? 0.6 : 0.85;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.stats.contextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.stats.contextLost = false;
      this.scene = new Target(gl, this.hdr);
      this.sceneB = new Target(gl, this.hdr);
      this.bloom = Array.from({ length: 5 }, () => new Target(gl, this.hdr));
      this.vao = gl.createVertexArray()!;
      this.buildPrograms();
      for (const w of this.worlds.values()) w.init(gl);
    });
  }

  private buildPrograms() {
    const gl = this.gl;
    this.pDown = new Program(gl, BLOOM_DOWN, 'bloom down');
    this.pUp = new Program(gl, BLOOM_UP, 'bloom up');
    this.pComp = new Program(gl, COMPOSITE, 'composite');
    this.pMix = new Program(
      gl,
      `#version 300 es
precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D uA, uB; uniform float uK;
void main(){ vec2 c = vUv - 0.5; float r = length(c); float k = smoothstep(uK * 1.4 - 0.2, uK * 1.4, 1.2 - r); o = vec4(mix(texture(uA, vUv).rgb, texture(uB, vUv).rgb, k), 1.0); }`,
      'mix',
    );
  }

  register(world: World): void {
    world.init(this.gl);
    this.worlds.set(world.id, world);
  }

  hasWorld(id: string): boolean {
    return this.worlds.has(id);
  }

  /** Begin a crossfade between worlds (radial wipe, ~1.6 s). */
  transition(from: string, to: string, fromParams: WorldParams, now: number): void {
    if (from === to) return;
    this.fade = { from, to, start: now, dur: 1.6, fromParams };
  }

  private resize(): { w: number; h: number } {
    const fixed = this.settings.fixedSize;
    if (fixed) {
      if (this.canvas.width !== fixed.w || this.canvas.height !== fixed.h) {
        this.canvas.width = fixed.w;
        this.canvas.height = fixed.h;
      }
      this.scale = 1;
      this.scene.resize(fixed.w, fixed.h);
      this.sceneB.resize(fixed.w, fixed.h);
      let bw = fixed.w / 2, bh = fixed.h / 2;
      for (const b of this.bloom) {
        b.resize(bw, bh);
        bw /= 2;
        bh /= 2;
      }
      this.stats.width = fixed.w;
      this.stats.height = fixed.h;
      return { w: fixed.w, h: fixed.h };
    }
    const dpr = Math.min(this.settings.maxDpr, window.devicePixelRatio || 1);
    const cw = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const ch = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const w = Math.round(cw * this.scale);
    const h = Math.round(ch * this.scale);
    this.scene.resize(w, h);
    this.sceneB.resize(w, h);
    let bw = w / 2, bh = h / 2;
    for (const b of this.bloom) {
      b.resize(bw, bh);
      bw /= 2;
      bh /= 2;
    }
    this.stats.width = w;
    this.stats.height = h;
    return { w, h };
  }

  private governor(dtMs: number) {
    this.emaMs = this.emaMs * 0.92 + Math.min(dtMs, 250) * 0.08;
    if (this.settings.quality !== 'auto') {
      this.tier = this.settings.quality;
      return;
    }
    if (this.emaMs > 20) {
      this.slowFor += dtMs;
      this.fastFor = 0;
    } else if (this.emaMs < 13) {
      this.fastFor += dtMs;
      this.slowFor = 0;
    } else {
      this.slowFor = this.fastFor = 0;
    }
    if (this.slowFor > 1200) {
      this.slowFor = 0;
      if (this.scale > 0.5) this.scale = Math.max(0.5, this.scale - 0.1);
      else if (this.tier > 0) this.tier--;
      else this.scale = Math.max(0.35, this.scale - 0.05);
    } else if (this.fastFor > 4000) {
      this.fastFor = 0;
      if (this.scale < 0.6) this.scale = Math.min(1, this.scale + 0.1);
      else if (this.tier < 3) this.tier++;
      else this.scale = Math.min(1, this.scale + 0.05);
    }
  }

  /**
   * Render one frame. `wallMs` is performance.now() (for fps / transitions only);
   * all motion comes from `state`.
   */
  render(worldId: string, stateIn: VisualState, params: WorldParams, wallMs: number): void {
    let state = stateIn;
    const gl = this.gl;
    if (gl.isContextLost()) return;
    const dt = this.lastFrame ? wallMs - this.lastFrame : 16;
    this.lastFrame = wallMs;
    this.frames.push(wallMs);
    while (this.frames.length && wallMs - this.frames[0] > 1000) this.frames.shift();
    this.stats.fps = this.frames.length;
    this.stats.frameMs = this.emaMs;
    this.governor(dt);

    const { w, h } = this.resize();
    const p: WorldParams = { ...params, motionScale: params.motionScale * (this.settings.reducedMotion ? 0.35 : 1) };
    // worlds never see an unguarded flash request
    // the flash guard runs once per frame; worlds only ever see the admitted value
    const guarded = this.guard.apply(state.flash * params.intensity, state.t, this.settings.photosensitive);
    this.lastGuardedFlash = guarded;
    state = { ...state, flash: guarded / 0.35 };
    const input: FrameInput = { s: state, p, width: w, height: h, quality: this.tier, frameOffset: this.settings.frameOffset };
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    const world = this.worlds.get(worldId);
    // stage content: render the chosen world small, then hand it to the stage
    const stage = this.settings.stageWorld && worldId === 'festival' ? this.worlds.get(this.settings.stageWorld) : undefined;
    if (stage) {
      if (!this.stageTarget) this.stageTarget = new Target(gl, this.hdr);
      this.stageTarget.resize(Math.min(640, w), Math.min(360, Math.round(w * 0.5625)));
      this.stageTarget.bind();
      stage.render({ ...input, width: this.stageTarget.width, height: this.stageTarget.height, frameOffset: 0, quality: Math.min(1, this.tier) });
      input.screen = this.stageTarget.tex;
      gl.bindVertexArray(this.vao);
    }
    let src = this.scene;
    if (this.fade && wallMs / 1000 - this.fade.start < this.fade.dur && this.worlds.has(this.fade.from) && this.fade.to === worldId) {
      const k = (wallMs / 1000 - this.fade.start) / this.fade.dur;
      this.scene.bind();
      this.worlds.get(this.fade.from)!.render({ ...input, p: { ...this.fade.fromParams, motionScale: p.motionScale } });
      this.sceneB.bind();
      world?.render(input);
      src = this.mixInto(k);
    } else {
      this.fade = null;
      this.scene.bind();
      world?.render(input);
    }

    // bloom chain
    const bs = this.bloom;
    this.pDown.use();
    let prev = src;
    for (let i = 0; i < bs.length; i++) {
      bs[i].bind();
      this.pDown.tex('uTex', 0, prev.tex).f('uTexel', 1 / prev.width, 1 / prev.height).f('uThreshold', i === 0 ? 1.0 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      prev = bs[i];
    }
    this.pUp.use();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = bs.length - 1; i > 0; i--) {
      bs[i - 1].bind();
      this.pUp.tex('uTex', 0, bs[i].tex).f('uTexel', 1 / bs[i].width, 1 / bs[i].height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);

    // composite
    // worlds with their own strobe fixtures handle flashes; no full-screen wash
    const flash = world?.ownFlash ? 0 : guarded;
    this.stats.flashesSuppressed = this.guard.suppressed;
    const pal = params.palette;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const motion = p.motionScale;
    this.pComp
      .use()
      .tex('uScene', 0, src.tex)
      .tex('uBloom', 1, bs[0].tex)
      .f('uBloomStrength', 0.35 + 0.35 * state.intensity)
      .f('uExposure', 1.0 + 0.12 * state.energy)
      .f('uFlash', flash)
      .f('uFlashColor', 0.6 + pal[12] * 0.4, 0.6 + pal[13] * 0.4, 0.6 + pal[14] * 0.4)
      .f('uCA', this.settings.reducedMotion ? 0 : 0.004 + 0.012 * state.kick * motion)
      .f('uGrain', 0.025)
      .f('uTime', (state.t % 100) + 0.37)
      .f('uVignette', 0.85);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.stats.renderScale = this.scale;
    this.stats.quality = this.tier;
  }

  /** Crossfade helper: mixes scene (A) and sceneB (B) into a bloom-sized-free target. */
  private mixTarget: Target | null = null;
  private stageTarget: Target | null = null;
  /** flash level admitted by the guard on the previous frame (worlds with ownFlash read it) */
  lastGuardedFlash = 0;
  private mixInto(k: number): Target {
    const gl = this.gl;
    if (!this.mixTarget) this.mixTarget = new Target(gl, this.hdr);
    this.mixTarget.resize(this.scene.width, this.scene.height);
    this.mixTarget.bind();
    this.pMix.use().tex('uA', 0, this.scene.tex).tex('uB', 1, this.sceneB.tex).f('uK', k * k * (3 - 2 * k));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return this.mixTarget;
  }

  /** Read back the current frame (tests, export). */
  snapshot(): ImageData {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    const px = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return new ImageData(px, w, h);
  }

  dispose(): void {
    for (const w of this.worlds.values()) w.dispose();
    this.worlds.clear();
    this.scene.dispose();
    this.sceneB.dispose();
    this.mixTarget?.dispose();
    this.stageTarget?.dispose();
    this.bloom.forEach((b) => b.dispose());
    this.pDown.dispose();
    this.pUp.dispose();
    this.pComp.dispose();
    this.pMix.dispose();
    this.gl.deleteVertexArray(this.vao);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
