import { FrameExtractor, FRAME_SIZE, HOP_SIZE, emptyMeasurement } from './frameExtractor';
import { movingAverage, normalizeByPercentile, percentile } from './dsp';
import type { FrameFeatures } from './types';

export { FRAME_SIZE, HOP_SIZE };

export interface RawSpectralFeatures {
  frames: FrameFeatures;
  /** un-normalized onset envelope used for tempo (mean-removed log flux) */
  onsetRaw: Float32Array;
  /** absolute mean log-flux per bin (comparable across tracks) */
  fluxAbs: Float32Array;
  /** absolute measurements kept for cross-track descriptors */
  rmsDb: Float32Array;
  lowRaw: Float32Array;
  highRaw: Float32Array;
  midRaw: Float32Array;
}

/**
 * Short-time Fourier analysis. One pass over the signal computes all
 * frame-level measurements. Pure function: same input -> same output.
 */
export function computeFrameFeatures(
  input: Float32Array,
  sampleRate: number,
  onProgress?: (p: number) => void,
): RawSpectralFeatures {
  const n = FRAME_SIZE;
  const hop = HOP_SIZE;
  // Centre frames on their timestamps (frame f is centred at f*hop) by
  // padding half a window of silence at the start.
  const mono = new Float32Array(input.length + n);
  mono.set(input, n / 2);
  const count = Math.max(1, Math.floor(input.length / hop));
  const ex = new FrameExtractor(sampleRate);
  const m = emptyMeasurement();

  const rms = new Float32Array(count);
  const rmsDb = new Float32Array(count);
  const lowRaw = new Float32Array(count);
  const midRaw = new Float32Array(count);
  const highRaw = new Float32Array(count);
  const centroid = new Float32Array(count);
  const flatness = new Float32Array(count);
  const flux = new Float32Array(count);
  const lowFlux = new Float32Array(count);
  const highFlux = new Float32Array(count);
  const fluxAbs = new Float32Array(count);

  const reportEvery = Math.max(1, Math.floor(count / 50));

  for (let f = 0; f < count; f++) {
    ex.process(mono.subarray(f * hop, f * hop + n), m);
    rms[f] = m.rms;
    rmsDb[f] = 20 * Math.log10(m.rms + 1e-9);
    lowRaw[f] = m.low;
    midRaw[f] = m.mid;
    highRaw[f] = m.high;
    centroid[f] = m.centroid;
    flatness[f] = m.flatness;
    flux[f] = m.flux;
    lowFlux[f] = m.lowFlux;
    highFlux[f] = m.highFlux;
    fluxAbs[f] = m.fluxAbs;
    if (onProgress && f % reportEvery === 0) onProgress(f / count);
  }

  // Onset envelope for tempo/beat tracking: mean-removed, half-wave rectified
  // spectral flux. Low-band flux (kick drums, bass attacks) is mixed in at equal
  // weight so dense hi-hats do not pull the beat grid onto off-beats.
  const hopSec = hop / sampleRate;
  const rectify = (x: Float32Array) => {
    const lm = movingAverage(x, Math.round(0.4 / hopSec));
    const o = new Float32Array(count);
    let sq = 0;
    for (let i = 0; i < count; i++) {
      o[i] = Math.max(0, x[i] - lm[i]);
      sq += o[i] * o[i];
    }
    const sd = Math.sqrt(sq / count) || 1;
    for (let i = 0; i < count; i++) o[i] /= sd;
    return o;
  };
  const fullR = rectify(flux);
  const lowR = rectify(lowFlux);
  const onsetRaw = new Float32Array(count);
  for (let i = 0; i < count; i++) onsetRaw[i] = 0.5 * fullR[i] + 0.5 * lowR[i];

  // Relative loudness envelope in dB, smoothed over ~1.5 s, mapped p5..p99 -> 0..1
  const smoothDb = movingAverage(rmsDb, Math.round(1.5 / hopSec));
  const dbLo = Math.max(-70, percentile(smoothDb, 5));
  const dbHi = percentile(smoothDb, 99.5);
  const energy = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    energy[i] = Math.min(1, Math.max(0, (smoothDb[i] - dbLo) / Math.max(1e-3, dbHi - dbLo)));
  }

  // band energies: compress (sqrt of power ~ amplitude) then normalize
  const comp = (x: Float32Array) => normalizeByPercentile(x.map(Math.sqrt), 98);

  return {
    frames: {
      hop: hopSec,
      count,
      rms,
      low: comp(lowRaw),
      mid: comp(midRaw),
      high: comp(highRaw),
      centroid,
      flatness,
      onset: normalizeByPercentile(fullR, 99),
      lowOnset: normalizeByPercentile(lowFlux, 99),
      highOnset: normalizeByPercentile(highFlux, 99),
      energy,
    },
    onsetRaw,
    fluxAbs,
    rmsDb,
    lowRaw,
    midRaw,
    highRaw,
  };
}
