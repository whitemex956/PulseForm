import { percentile, std } from './dsp';
import type { BeatGrid } from './types';

/**
 * Tempo estimation + beat tracking following D. P. W. Ellis,
 * "Beat Tracking by Dynamic Programming" (J. New Music Research, 2007):
 *   1. autocorrelate the onset-strength envelope,
 *   2. weight lags with a log-Gaussian tempo prior,
 *   3. find the globally optimal beat sequence with dynamic programming.
 */

export interface TempoEstimate {
  bpm: number;
  /** beat period in frames */
  period: number;
  /** 0..1 strength of periodicity (normalized autocorrelation at the period) */
  confidence: number;
  /** tempo-prior-weighted autocorrelation for diagnostics */
  curve: Float32Array;
  minLag: number;
}

const MIN_BPM = 60;
const MAX_BPM = 200;

export function estimateTempo(onset: Float32Array, hop: number): TempoEstimate {
  const n = onset.length;
  const m = onset.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = onset[i] - m;

  const minLag = Math.max(1, Math.floor(60 / MAX_BPM / hop));
  const maxLag = Math.min(n - 1, Math.ceil(60 / MIN_BPM / hop));

  let ac0 = 0;
  for (let i = 0; i < n; i++) ac0 += x[i] * x[i];
  ac0 = ac0 || 1e-12;

  const raw = new Float32Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1 && lag < n; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += x[i] * x[i - lag];
    raw[lag] = s / ac0;
  }

  // Ellis tempo prior: log-Gaussian centred at 0.5 s period (120 BPM), sigma 1.4 octaves
  const tau0 = 0.5;
  const sigma = 1.4;
  const weighted = new Float32Array(maxLag + 2);
  let best = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const w = Math.exp(-0.5 * (Math.log2((lag * hop) / tau0) / sigma) ** 2);
    weighted[lag] = Math.max(0, raw[lag]) * w;
    if (weighted[lag] > weighted[best]) best = lag;
  }

  // Octave check: if half the period is in range and nearly as periodic,
  // the faster tempo is the real pulse (the slower one is every other beat).
  const half = best / 2;
  if (60 / (half * hop) <= MAX_BPM) {
    let hb = Math.round(half);
    for (const c of [Math.floor(half), Math.ceil(half)]) if (c >= minLag && raw[c] > raw[hb]) hb = c;
    if (hb >= minLag && raw[hb] >= 0.55 * raw[best]) best = hb;
  }

  // parabolic interpolation around the peak for sub-frame precision
  let period = best;
  const a = weighted[best - 1] ?? 0;
  const b = weighted[best];
  const c = weighted[best + 1] ?? 0;
  const denom = a - 2 * b + c;
  if (Math.abs(denom) > 1e-12) period = best + (0.5 * (a - c)) / denom;

  const confidence = Math.max(0, Math.min(1, raw[best]));
  return { bpm: 60 / (period * hop), period, confidence, curve: weighted, minLag };
}

/** Dynamic-programming beat tracker. Returns beat frame indices. */
export function trackBeats(onset: Float32Array, period: number, tightness = 100): number[] {
  const n = onset.length;
  const sd = std(onset) || 1;
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = onset[i] / sd;

  const score = new Float32Array(n);
  const backlink = new Int32Array(n).fill(-1);
  const lo = Math.round(-2 * period);
  const hi = Math.round(-period / 2);

  for (let t = 0; t < n; t++) {
    let bestVal = -Infinity;
    let bestIdx = -1;
    for (let d = lo; d <= hi; d++) {
      const p = t + d;
      if (p < 0) continue;
      const penalty = -tightness * Math.log(-d / period) ** 2;
      const v = score[p] + penalty;
      if (v > bestVal) {
        bestVal = v;
        bestIdx = p;
      }
    }
    if (bestIdx >= 0) {
      score[t] = o[t] + bestVal;
      backlink[t] = bestIdx;
    } else {
      score[t] = o[t];
    }
  }

  // choose the end point: the best-scoring frame in the final period
  const tailStart = Math.max(0, Math.floor(n - period));
  let end = tailStart;
  // find local maxima in the tail and pick the highest; avoid frames past the music
  for (let t = tailStart; t < n; t++) if (score[t] > score[end]) end = t;

  const beats: number[] = [];
  for (let t = end; t >= 0; t = backlink[t]) {
    beats.push(t);
    if (backlink[t] < 0) break;
  }
  beats.reverse();

  // trim leading/trailing beats that sit in silence (onset below a low floor)
  const floor = percentile(o, 20);
  const active = (b: number) => {
    let mx = 0;
    const r = Math.round(period * 2);
    for (let i = Math.max(0, b - r); i < Math.min(n, b + r); i++) mx = Math.max(mx, o[i]);
    return mx > floor + 0.5;
  };
  while (beats.length && !active(beats[0])) beats.shift();
  while (beats.length && !active(beats[beats.length - 1])) beats.pop();
  return beats;
}

/** Least-squares tempo from beat times (more precise than the autocorrelation lag). */
export function tempoFromBeats(beatTimes: number[]): number | null {
  if (beatTimes.length < 4) return null;
  const n = beatTimes.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += beatTimes[i];
    sxx += i * i;
    sxy += i * beatTimes[i];
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return slope > 0 ? 60 / slope : null;
}

/** Regularity of inter-beat intervals: 1 = perfectly steady. */
export function beatRegularity(beatTimes: number[]): number {
  if (beatTimes.length < 4) return 0;
  const ibi: number[] = [];
  for (let i = 1; i < beatTimes.length; i++) ibi.push(beatTimes[i] - beatTimes[i - 1]);
  const m = ibi.reduce((a, b) => a + b, 0) / ibi.length;
  const s = Math.sqrt(ibi.reduce((a, b) => a + (b - m) ** 2, 0) / ibi.length);
  return Math.max(0, 1 - s / m / 0.15);
}

/**
 * Estimate which beat phase (0..3) starts each bar, using low-frequency
 * energy and harmonic change, which tend to peak on downbeats.
 */
export function estimateDownbeats(
  beatFrames: number[],
  lowOnset: Float32Array,
  midChange: Float32Array,
): number[] {
  if (beatFrames.length < 8) return [];
  const scores = [0, 0, 0, 0];
  for (let i = 0; i < beatFrames.length; i++) {
    const f = beatFrames[i];
    let v = 0;
    for (let d = -2; d <= 2; d++) {
      const k = f + d;
      if (k >= 0 && k < lowOnset.length) v = Math.max(v, 0.5 * lowOnset[k] + midChange[k]);
    }
    scores[i % 4] += v;
  }
  let phase = 0;
  for (let p = 1; p < 4; p++) if (scores[p] > scores[phase]) phase = p;
  const out: number[] = [];
  for (let i = phase; i < beatFrames.length; i += 4) out.push(i);
  return out;
}

/**
 * In most beat-driven music the kick lands on the beat. If low-band attacks are
 * clearly stronger halfway between tracked beats, the tracker locked onto the
 * off-beat: shift the grid by half a period.
 */
export function correctHalfBeatPhase(frames: number[], lowOnset: Float32Array, period: number): number[] {
  if (frames.length < 8) return frames;
  const peakNear = (f: number) => {
    let m = 0;
    for (let d = -2; d <= 2; d++) m = Math.max(m, lowOnset[Math.round(f) + d] ?? 0);
    return m;
  };
  let on = 0, off = 0;
  for (const f of frames) {
    on += peakNear(f);
    off += peakNear(f + period / 2);
  }
  if (off > on * 1.5 && off > 0.1 * frames.length) {
    return frames.map((f) => Math.round(f + period / 2)).filter((f) => f < lowOnset.length);
  }
  return frames;
}

/**
 * Electronic music is usually produced on a fixed tempo grid. Fit the best
 * constant-tempo grid (period and phase searched jointly, scored on kick-weighted
 * onsets). If it explains the onsets nearly as well as the free DP path, prefer
 * it: it carries the beat through drum-less breakdowns without drifting onto
 * off-beats. Tracks with genuine tempo drift keep the DP beats.
 */
export function preferSteadyGrid(frames: number[], onset: Float32Array, lowOnset: Float32Array, period: number): number[] {
  if (frames.length < 16) return frames;
  const n = onset.length;
  const sd = std(onset) || 1;
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) env[i] = onset[i] / sd + 2 * lowOnset[i];
  const peak = (f: number) => {
    const c = Math.round(f);
    let m = 0;
    for (let d = -2; d <= 2; d++) m = Math.max(m, env[c + d] ?? 0);
    return m;
  };
  const first = frames[0];
  const last = frames[frames.length - 1];
  // DP score for comparison
  let dpScore = 0;
  for (const f of frames) dpScore += peak(f);
  dpScore /= frames.length;

  // refine period from DP beats as a starting point
  const span = last - first;
  const p0 = span / Math.max(1, frames.length - 1);
  let best = { score: -1, p: p0, phase: first };
  for (let k = -40; k <= 40; k++) {
    const p = p0 * (1 + k * 0.00025);
    for (let ph = 0; ph < p; ph += 0.5) {
      let sc = 0, cnt = 0;
      for (let f = first - p + ph; f <= last + p / 2; f += p) {
        if (f < 0 || f >= n) continue;
        sc += peak(f);
        cnt++;
      }
      if (cnt && sc / cnt > best.score) best = { score: sc / cnt, p, phase: first - p + ph };
    }
  }
  if (best.score < 0.8 * dpScore) return frames;
  const out: number[] = [];
  let start = best.phase;
  while (start - best.p >= 0 && start - best.p >= first - best.p / 2) start -= best.p;
  for (let f = start; f <= last + best.p / 2 && f < n; f += best.p) if (f >= 0) out.push(f);
  void period;
  return out;
}

export function buildBeatGrid(
  onsetRaw: Float32Array,
  lowOnset: Float32Array,
  midChange: Float32Array,
  hop: number,
  report?: (stage: 'tempo' | 'beats', p: number, detail?: string) => void,
): BeatGrid {
  const est = estimateTempo(onsetRaw, hop);
  report?.('tempo', 1, `${est.bpm.toFixed(1)} BPM candidate · periodicity ${(est.confidence * 100).toFixed(0)}%`);
  let frames = trackBeats(onsetRaw, est.period);
  frames = correctHalfBeatPhase(frames, lowOnset, est.period);
  frames = preferSteadyGrid(frames, onsetRaw, lowOnset, est.period);
  const times = frames.map((f) => f * hop);
  const regular = beatRegularity(times);
  const refined = tempoFromBeats(times);
  // A track "has a pulse" when the onset envelope is clearly periodic AND the
  // tracked beats are steady. Both thresholds were set on the synthetic test set
  // and are documented as estimates.
  const hasPulse = est.confidence >= 0.12 && regular >= 0.5 && times.length >= 8;
  const confidence = Math.max(0, Math.min(1, est.confidence * 2)) * (hasPulse ? regular : 0.5);
  report?.('beats', 1, hasPulse ? `${times.length} beats tracked` : 'No steady pulse detected');
  return {
    hasPulse,
    bpm: hasPulse ? Math.round((refined ?? est.bpm) * 10) / 10 : null,
    confidence,
    beats: hasPulse ? times : [],
    downbeats: hasPulse ? estimateDownbeats(frames, lowOnset, midChange) : [],
  };
}
