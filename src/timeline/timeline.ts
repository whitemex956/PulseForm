import type { AnalysisResult, Section, SectionKind } from '../analysis/types';
import { sampleAt } from '../analysis/dsp';

/**
 * The automation timeline: a pure function of audio time.
 *
 * At construction every control signal is precomputed at a fixed control rate
 * (deterministically, from the analysis). At runtime `stateAt(t)` only samples
 * those arrays and does closed-form math on beat times. Nothing accumulates
 * between frames, so play / pause / seek / export always agree.
 */

export const CONTROL_RATE = 120; // Hz

export interface VisualState {
  t: number;
  duration: number;
  /** 0..1 position in the song */
  progress: number;

  // --- rhythm (estimated grid) ---
  hasPulse: boolean;
  bpm: number;
  beatIndex: number;
  /** 0..1 within the current beat */
  beatPhase: number;
  /** 1 on the beat, decays exponentially */
  beatPulse: number;
  barIndex: number;
  /** 0..1 within the bar */
  barPhase: number;
  /** 1 on the downbeat, slower decay */
  downbeatPulse: number;
  /** continuous beat count (beats elapsed, fractional) — use for beat-locked motion */
  beatTime: number;

  // --- measured signal envelopes (attack/release smoothed) ---
  low: number;
  mid: number;
  high: number;
  /** relative loudness, ~1.5 s smoothing */
  energy: number;
  /** decaying pulses from detected transients */
  kick: number;
  snare: number;
  hat: number;
  transient: number;

  // --- structure (estimated) ---
  section: SectionKind;
  sectionIndex: number;
  /** 0..1 within section */
  sectionProgress: number;
  /** 0..1 ramp inside a build-up, 0 elsewhere */
  build: number;
  /** 1 at a drop, decays over ~2 s */
  dropImpact: number;
  /** seconds since the most recent drop (Infinity if none) */
  sinceDrop: number;
  /** 0..1 rising in the last 2 beats before a drop */
  anticipation: number;

  // --- director curves ---
  /** master intensity 0..1 with musical restraint */
  intensity: number;
  /** 0..1 permission for flashes/strobes (safety-limited by the player) */
  flash: number;
  /**
   * Motion clock: integral of musical drive over time. Worlds use it instead of
   * raw time so motion speeds up with the music. Pure in t for files.
   */
  motion: number;
}

export function emptyState(): VisualState {
  return {
    t: 0, duration: 1, progress: 0, hasPulse: false, bpm: 120, beatIndex: 0, beatPhase: 0, beatPulse: 0,
    barIndex: 0, barPhase: 0, downbeatPulse: 0, beatTime: 0, low: 0, mid: 0, high: 0, energy: 0, kick: 0,
    snare: 0, hat: 0, transient: 0, section: 'intro', sectionIndex: 0, sectionProgress: 0, build: 0,
    dropImpact: 0, sinceDrop: Infinity, anticipation: 0, intensity: 0, flash: 0, motion: 0,
  };
}

/** Section-role intensity targets: restraint is the point. */
const TARGET: Record<SectionKind, number> = {
  ambient: 0.32,
  intro: 0.35,
  verse: 0.55,
  breakdown: 0.22,
  build: 0.45, // ramps toward 0.85 across the build
  drop: 1.0,
  peak: 0.82,
  outro: 0.3,
};

function envelopeFollow(src: Float32Array, hop: number, attack: number, release: number): Float32Array {
  const out = new Float32Array(src.length);
  const a = 1 - Math.exp(-hop / attack);
  const r = 1 - Math.exp(-hop / release);
  let y = 0;
  for (let i = 0; i < src.length; i++) {
    const x = src[i];
    y += (x > y ? a : r) * (x - y);
    out[i] = y;
  }
  return out;
}

function upperBound(arr: number[], t: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] <= t) lo = m + 1;
    else hi = m;
  }
  return lo; // first index with arr[i] > t
}

/** Shared by file and live modes so motion feels identical across sources. */
export function motionRate(intensity: number, energy: number): number {
  return 0.3 + 0.9 * intensity + 0.35 * energy;
}

export class Timeline {
  readonly duration: number;
  readonly analysis: AnalysisResult;
  private readonly low: Float32Array;
  private readonly mid: Float32Array;
  private readonly high: Float32Array;
  private readonly energy: Float32Array;
  private readonly intensityCurve: Float32Array; // at CONTROL_RATE
  private readonly motionCurve: Float32Array; // at CONTROL_RATE
  private readonly hop: number;
  private readonly beats: number[];
  private readonly downbeatTimes: number[];
  private readonly kicks: number[];
  private readonly kickStr: number[];
  private readonly snares: number[];
  private readonly hats: number[];
  private readonly allT: number[];
  private readonly allS: number[];
  private readonly sectionStarts: number[];
  private readonly sections: Section[];
  private readonly period: number;
  /** user/director scaling */
  intensityScale = 1;
  reactivity = 1;

  constructor(analysis: AnalysisResult) {
    this.analysis = analysis;
    this.duration = analysis.duration;
    const f = analysis.frames;
    this.hop = f.hop;
    this.low = envelopeFollow(f.low, f.hop, 0.012, 0.18);
    this.mid = envelopeFollow(f.mid, f.hop, 0.02, 0.22);
    this.high = envelopeFollow(f.high, f.hop, 0.008, 0.12);
    this.energy = f.energy;

    const g = analysis.beatGrid;
    this.beats = g.beats;
    this.period = g.bpm ? 60 / g.bpm : 1;
    this.downbeatTimes = g.downbeats.map((i) => g.beats[i]);

    const tr = analysis.transients;
    const low = tr.filter((x) => x.band === 'low' || (x.band === 'full' && x.strength > 0.5));
    this.kicks = low.map((x) => x.time);
    this.kickStr = low.map((x) => x.strength);
    this.snares = tr.filter((x) => x.band === 'mid' || x.band === 'full').map((x) => x.time);
    this.hats = tr.filter((x) => x.band === 'high').map((x) => x.time);
    this.allT = tr.map((x) => x.time);
    this.allS = tr.map((x) => x.strength);

    this.sections = analysis.sections.length
      ? analysis.sections
      : [{ start: 0, end: this.duration, kind: 'ambient', energy: 0.5, slope: 0 }];
    this.sectionStarts = this.sections.map((s) => s.start);

    this.intensityCurve = this.buildIntensity();
    this.motionCurve = new Float32Array(this.intensityCurve.length);
    let m = 0;
    for (let i = 0; i < this.intensityCurve.length; i++) {
      const e = sampleAt(this.energy, this.hop, i / CONTROL_RATE);
      m += motionRate(this.intensityCurve[i], e) / CONTROL_RATE;
      this.motionCurve[i] = m;
    }
  }

  private sectionAt(t: number): number {
    return Math.max(0, upperBound(this.sectionStarts, t) - 1);
  }

  private buildIntensity(): Float32Array {
    const n = Math.ceil(this.duration * CONTROL_RATE) + 1;
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / CONTROL_RATE;
      const si = this.sectionAt(t);
      const s = this.sections[si];
      const p = Math.min(1, Math.max(0, (t - s.start) / Math.max(0.001, s.end - s.start)));
      let target = TARGET[s.kind];
      if (s.kind === 'build') target = 0.4 + 0.45 * p ** 1.6;
      // blend the role target with the measured loudness envelope
      const e = sampleAt(this.energy, this.hop, t);
      raw[i] = 0.65 * target + 0.35 * e * target * 1.4;
    }
    // smooth across boundaries with a ~1 beat window, but keep drops as hard cuts
    const w = Math.max(1, Math.round(this.period * CONTROL_RATE));
    const out = new Float32Array(n);
    let acc = 0;
    const a = 1 - Math.exp(-1 / w);
    for (let i = 0; i < n; i++) {
      const t = i / CONTROL_RATE;
      const atDrop = this.analysis.drops.some((d) => t >= d && t < d + 1 / CONTROL_RATE);
      acc = atDrop ? raw[i] : acc + a * (raw[i] - acc);
      out[i] = Math.min(1, acc);
    }
    return out;
  }

  /** Decaying pulse from the most recent event at or before t. */
  private pulse(times: number[], t: number, decay: number, strengths?: number[]): number {
    const i = upperBound(times, t) - 1;
    if (i < 0) return 0;
    const dt = t - times[i];
    return Math.exp(-dt / decay) * (strengths ? strengths[i] : 1);
  }

  /** Fill `out` with the state at audio time t. Pure in t. */
  stateAt(t: number, out: VisualState = emptyState()): VisualState {
    const T = Math.min(Math.max(0, t), this.duration);
    out.t = T;
    out.duration = this.duration;
    out.progress = T / this.duration;
    const g = this.analysis.beatGrid;
    out.hasPulse = g.hasPulse;
    out.bpm = g.bpm ?? 60;
    const react = this.reactivity;

    if (g.hasPulse && this.beats.length > 1) {
      const bi = upperBound(this.beats, T) - 1;
      let phase: number;
      let beatTime: number;
      if (bi < 0) {
        phase = 1 - Math.min(1, (this.beats[0] - T) / this.period);
        beatTime = (T - this.beats[0]) / this.period;
      } else if (bi >= this.beats.length - 1) {
        phase = ((T - this.beats[this.beats.length - 1]) / this.period) % 1;
        beatTime = this.beats.length - 1 + (T - this.beats[this.beats.length - 1]) / this.period;
      } else {
        const a = this.beats[bi], b = this.beats[bi + 1];
        phase = (T - a) / (b - a);
        beatTime = bi + phase;
      }
      out.beatIndex = Math.max(0, bi);
      out.beatPhase = phase;
      out.beatTime = beatTime;
      out.beatPulse = bi >= 0 && T - this.beats[bi] < this.period * 2 ? Math.exp(-(T - this.beats[bi]) / (this.period * 0.22)) : 0;
      const di = upperBound(this.downbeatTimes, T) - 1;
      out.barIndex = Math.max(0, di);
      const da = this.downbeatTimes[di] ?? 0;
      out.barPhase = di >= 0 ? Math.min(1, (T - da) / (this.period * 4)) : 0;
      out.downbeatPulse = di >= 0 ? Math.exp(-(T - da) / (this.period * 0.6)) : 0;
    } else {
      // no steady pulse: a slow "breath" so motion still has a phase
      const breath = T / 4;
      out.beatIndex = Math.floor(breath);
      out.beatPhase = breath % 1;
      out.beatTime = breath;
      out.beatPulse = 0;
      out.barIndex = Math.floor(breath / 4);
      out.barPhase = (breath / 4) % 1;
      out.downbeatPulse = 0;
    }

    out.low = Math.min(1, sampleAt(this.low, this.hop, T) * react);
    out.mid = Math.min(1, sampleAt(this.mid, this.hop, T) * react);
    out.high = Math.min(1, sampleAt(this.high, this.hop, T) * react);
    out.energy = sampleAt(this.energy, this.hop, T);
    out.kick = Math.min(1, this.pulse(this.kicks, T, 0.12, this.kickStr) * 1.2 * react);
    out.snare = Math.min(1, this.pulse(this.snares, T, 0.1) * react);
    out.hat = Math.min(1, this.pulse(this.hats, T, 0.05) * react);
    out.transient = Math.min(1, this.pulse(this.allT, T, 0.09, this.allS) * react);

    const si = this.sectionAt(T);
    const s = this.sections[si];
    out.section = s.kind;
    out.sectionIndex = si;
    out.sectionProgress = Math.min(1, Math.max(0, (T - s.start) / Math.max(0.001, s.end - s.start)));
    out.build = s.kind === 'build' ? out.sectionProgress : 0;

    const drops = this.analysis.drops;
    const dj = upperBound(drops, T) - 1;
    out.sinceDrop = dj >= 0 ? T - drops[dj] : Infinity;
    out.dropImpact = dj >= 0 ? Math.exp(-out.sinceDrop / 1.8) : 0;
    const next = drops[dj + 1];
    const win = this.period * 2;
    out.anticipation = next !== undefined && next - T < win ? 1 - (next - T) / win : 0;

    const ci = Math.min(this.intensityCurve.length - 1, Math.floor(T * CONTROL_RATE));
    const u = T * CONTROL_RATE - ci;
    const iv = this.intensityCurve[ci] * (1 - u) + (this.intensityCurve[ci + 1] ?? this.intensityCurve[ci]) * u;
    out.intensity = Math.min(1, iv * this.intensityScale);
    // flashes are earned: big at drops, modest on downbeats in high sections, none in quiet parts
    out.flash = Math.max(out.dropImpact, out.intensity > 0.8 ? out.downbeatPulse * 0.5 : 0);
    out.motion = this.motionCurve[ci] * (1 - u) + (this.motionCurve[ci + 1] ?? this.motionCurve[ci]) * u;
    return out;
  }
}
