import type { AnalysisResult } from '../analysis/types';
import type { VisualState } from '../timeline/timeline';
import type { WorldParams } from '../render/world';
import { hexToRgb } from '../render/gl';
import { Rng, mixSeed, hashString } from '../core/random';
import { SIGNATURE, type Palette, makePalette } from './director';

/**
 * Director runtime: decides, over time, which shape the sculpture takes and
 * when it morphs. Two modes:
 *  - file: a deterministic plan from the pre-analysed sections (same seed →
 *          same performance, frame for frame)
 *  - live: gradual evolution from rolling measurements; morphs are triggered by
 *          detected transitions and sustained changes, never on a fixed loop
 */

export const SHAPES = ['Drop', 'Wave', 'Ring', 'Cluster'] as const;
const MORPH_SECONDS = 2.6;

export interface DirectorSettings {
  seed: number;
  palette: Palette;
  intensity: number; // user control 0..1.3
  complexity: number;
  camera: number;
}

export function paletteToArray(p: Palette): Float32Array {
  const a = new Float32Array(15);
  p.colors.forEach((c, i) => a.set(hexToRgb(c), i * 3));
  return a;
}

interface PlanStep {
  t: number;
  shape: number;
}

/** Choose a shape that suits a section, avoiding repeats. */
function shapeFor(kind: string, energy: number, rng: Rng, prev: number): number {
  const prefs: Record<string, number[]> = {
    intro: [1, 0],
    ambient: [0, 1],
    verse: [1, 2, 0],
    build: [2, 1],
    drop: [3, 2, 1],
    peak: [3, 1],
    breakdown: [0, 1],
    outro: [1, 0],
  };
  const opts = (prefs[kind] ?? [1, 0, 2, 3]).filter((s) => s !== prev);
  if (energy > 0.85 && kind !== 'breakdown') opts.unshift(3);
  return opts[Math.floor(rng.next() * Math.min(2, opts.length))] ?? 1;
}

export class DirectorRuntime {
  settings: DirectorSettings;
  private palArr: Float32Array;
  private plan: PlanStep[] = [];
  // live state
  private liveShape = 1;
  private livePrev = 1;
  private liveMorphStart = -100;
  private lastTransitions = 0;
  private lastLiveChange = 0;
  private rng: Rng;
  /** rolling live character, used to bias choices */
  private character = { bass: 0, bright: 0, energy: 0, n: 0 };

  constructor(settings: DirectorSettings) {
    this.settings = settings;
    this.palArr = paletteToArray(settings.palette);
    this.rng = new Rng(settings.seed);
  }

  setPalette(p: Palette): void {
    this.settings.palette = p;
    this.palArr = paletteToArray(p);
  }

  /** New random identity (Surprise Me). Keeps the musical plan logic. */
  surprise(analysis: AnalysisResult | null, variation: number): void {
    const base = analysis ? hashString(analysis.fingerprint) : hashString('live');
    const seed = mixSeed(base, variation, Date.now() & 0xffff);
    const rng = new Rng(seed);
    const bright = analysis?.descriptors.find((d) => d.key === 'brightness')?.value ?? 0.5;
    const energy = analysis?.descriptors.find((d) => d.key === 'energy')?.value ?? 0.5;
    this.settings.seed = seed;
    this.settings.camera = rng.int(0, 2);
    this.setPalette(makePalette(rng, bright, energy, 'liquid'));
    this.rng = new Rng(seed);
    if (analysis) this.planFor(analysis);
    else this.liveShape = rng.int(0, 3);
  }

  /** Deterministic shape plan from sections. */
  planFor(a: AnalysisResult): void {
    const rng = new Rng(mixSeed(this.settings.seed, 'plan'));
    const plan: PlanStep[] = [];
    let prev = -1;
    for (const s of a.sections) {
      // long sections get an internal change every ~16 bars (or 30 s without a pulse)
      const step = a.beatGrid.bpm ? (60 / a.beatGrid.bpm) * 64 : 30;
      for (let t = s.start; t < s.end - step * 0.5; t += step) {
        const shape = shapeFor(s.kind, s.energy, rng, prev);
        plan.push({ t, shape });
        prev = shape;
      }
    }
    if (!plan.length) plan.push({ t: 0, shape: 1 });
    this.plan = plan;
  }

  get palette(): Float32Array {
    return this.palArr;
  }

  /** WorldParams at a state (file mode: pure in s.t). */
  paramsFile(s: VisualState): WorldParams {
    let i = 0;
    while (i + 1 < this.plan.length && this.plan[i + 1].t <= s.t) i++;
    const cur = this.plan[i];
    const prev = this.plan[Math.max(0, i - 1)];
    const k = i === 0 ? 1 : Math.min(1, (s.t - cur.t) / MORPH_SECONDS);
    return this.base(prev.shape, cur.shape, smooth(k));
  }

  /** WorldParams for live input: evolves from measurements. */
  paramsLive(s: VisualState, transitions: number): WorldParams {
    const c = this.character;
    c.n = Math.min(c.n + 1, 3600);
    const a = 1 / c.n;
    c.bass += a * (s.low - c.bass);
    c.bright += a * (s.high - c.bright);
    c.energy += a * (s.energy - c.energy);
    const sinceChange = s.t - this.lastLiveChange;
    const trig = transitions !== this.lastTransitions;
    this.lastTransitions = transitions;
    // change on detected transitions, or every ~45 s of sustained music
    if ((trig && sinceChange > 10) || (sinceChange > 45 && s.energy > 0.2)) {
      this.livePrev = this.liveShape;
      const bias = c.bass > 0.55 ? [3, 0] : c.bright > 0.5 ? [1, 2] : [2, 1, 0];
      const opts = bias.concat([0, 1, 2, 3]).filter((x) => x !== this.liveShape);
      this.liveShape = opts[Math.floor(this.rng.next() * Math.min(2, opts.length))];
      this.liveMorphStart = s.t;
      this.lastLiveChange = s.t;
    }
    if (!this.lastLiveChange) this.lastLiveChange = s.t;
    const k = Math.min(1, (s.t - this.liveMorphStart) / MORPH_SECONDS);
    return this.base(this.livePrev, this.liveShape, smooth(k));
  }

  /** Calm idle (no audio yet): honest — barely moves, no beat reactions. */
  paramsIdle(): WorldParams {
    return this.base(1, 1, 0);
  }

  private base(a: number, b: number, morph: number): WorldParams {
    return {
      seed: this.settings.seed,
      palette: this.palArr,
      complexity: this.settings.complexity,
      intensity: this.settings.intensity,
      motionScale: 1,
      shapeA: a,
      shapeB: b,
      morph: a === b ? 0 : morph,
      camera: this.settings.camera,
    };
  }

  get currentShapeName(): string {
    return SHAPES[this.liveShape] ?? 'Wave';
  }
}

function smooth(k: number): number {
  return k * k * (3 - 2 * k);
}

export function defaultDirector(): DirectorRuntime {
  return new DirectorRuntime({ seed: 0x5eed1234, palette: SIGNATURE, intensity: 1, complexity: 0.7, camera: 0 });
}
