import { FFT, hann } from './fft';
import { movingAverage, normalizeByPercentile, percentile } from './dsp';
import type { FrameFeatures } from './types';

export const FRAME_SIZE = 2048;
export const HOP_SIZE = 512;

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
  let mono = input;
  const n = FRAME_SIZE;
  const hop = HOP_SIZE;
  // Centre frames on their timestamps (frame f is centred at f*hop) by
  // padding half a window of silence at the start.
  const padded = new Float32Array(mono.length + n);
  padded.set(mono, n / 2);
  mono = padded;
  const count = Math.max(1, Math.floor(input.length / hop));
  const fft = new FFT(n);
  const win = hann(n);
  const buf = new Float32Array(n);
  const mag = new Float32Array(n / 2 + 1);
  const prevLog = new Float32Array(n / 2 + 1);
  const curLog = new Float32Array(n / 2 + 1);
  const prevMag = new Float32Array(n / 2 + 1);

  const binHz = sampleRate / n;
  const bin = (hz: number) => Math.min(n / 2, Math.max(1, Math.round(hz / binHz)));
  const lowA = bin(20), lowB = bin(150);
  const midB = bin(2000);
  const highB = bin(Math.min(16000, sampleRate / 2 - 1));

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

  const reportEvery = Math.max(1, Math.floor(count / 50));

  for (let f = 0; f < count; f++) {
    const off = f * hop;
    let sq = 0;
    for (let i = 0; i < n; i++) {
      const s = mono[off + i] ?? 0;
      sq += s * s;
      buf[i] = s * win[i];
    }
    rms[f] = Math.sqrt(sq / n);
    rmsDb[f] = 20 * Math.log10(rms[f] + 1e-9);
    fft.magnitude(buf, mag);

    let lo = 0, mi = 0, hi = 0, wsum = 0, msum = 0, logSum = 0, linSum = 0;
    let fl = 0, lfl = 0, hfl = 0;
    for (let k = 1; k <= highB; k++) {
      const m = mag[k];
      const p = m * m;
      if (k >= lowA && k < lowB) lo += p;
      else if (k >= lowB && k < midB) mi += p;
      else if (k >= midB) hi += p;
      wsum += k * binHz * m;
      msum += m;
      logSum += Math.log(m + 1e-10);
      linSum += m;
      const lg = Math.log1p(1000 * m);
      curLog[k] = lg;
      const d = lg - prevLog[k];
      if (d > 0) {
        fl += d;
        if (k >= midB) hfl += d;
      }
      // Low band uses LINEAR magnitude flux: the loudest low-end attack (usually
      // the kick) dominates, instead of every bass-note onset counting equally.
      if (k < lowB) {
        const dl = m - prevMag[k];
        if (dl > 0) lfl += dl;
      }
    }
    const nb = highB;
    lowRaw[f] = lo;
    midRaw[f] = mi;
    highRaw[f] = hi;
    centroid[f] = msum > 1e-9 ? wsum / msum : 0;
    flatness[f] = linSum > 1e-9 ? Math.exp(logSum / nb) / (linSum / nb) : 0;
    if (f > 0) {
      flux[f] = fl;
      lowFlux[f] = lfl;
      highFlux[f] = hfl;
    }
    prevLog.set(curLog);
    prevMag.set(mag);
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
    fluxAbs: flux.map((v) => v / highB),
    rmsDb,
    lowRaw,
    midRaw,
    highRaw,
  };
}
