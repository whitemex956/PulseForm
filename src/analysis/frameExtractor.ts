import { FFT, hann } from './fft';

/**
 * Per-frame spectral measurements. This ONE class is used by:
 *  - offline full-track analysis (features.ts), and
 *  - the live AudioWorklet (microphone / playback / companion input).
 * so every source is measured identically.
 */

export const FRAME_SIZE = 2048;
export const HOP_SIZE = 512;

export interface FrameMeasurement {
  /** RMS of the frame, linear full scale */
  rms: number;
  /** absolute peak sample in the newest hop */
  peak: number;
  /** band powers (sum of |X|^2) */
  low: number;
  mid: number;
  high: number;
  /** spectral centroid, Hz */
  centroid: number;
  /** spectral flatness, 0..1 */
  flatness: number;
  /** log-magnitude positive spectral flux (all bins) */
  flux: number;
  /** linear-magnitude positive flux below 150 Hz (kick-weighted) */
  lowFlux: number;
  /** log flux above 2 kHz */
  highFlux: number;
  /** flux per bin — absolute, comparable across sources */
  fluxAbs: number;
}

/** Log-spaced band edges for the spectrum display (Hz). */
export function spectrumEdges(bands: number, fMin = 30, fMax = 16000): number[] {
  const e: number[] = [];
  for (let i = 0; i <= bands; i++) e.push(fMin * Math.pow(fMax / fMin, i / bands));
  return e;
}

export class FrameExtractor {
  readonly sampleRate: number;
  readonly n = FRAME_SIZE;
  private readonly fft: FFT;
  private readonly win: Float32Array;
  private readonly buf: Float32Array;
  readonly mag: Float32Array;
  private readonly prevLog: Float32Array;
  private readonly prevMag: Float32Array;
  private readonly binHz: number;
  private readonly lowA: number;
  private readonly lowB: number;
  private readonly midB: number;
  private readonly highB: number;
  private first = true;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    const n = this.n;
    this.fft = new FFT(n);
    this.win = hann(n);
    this.buf = new Float32Array(n);
    this.mag = new Float32Array(n / 2 + 1);
    this.prevLog = new Float32Array(n / 2 + 1);
    this.prevMag = new Float32Array(n / 2 + 1);
    this.binHz = sampleRate / n;
    const bin = (hz: number) => Math.min(n / 2, Math.max(1, Math.round(hz / this.binHz)));
    this.lowA = bin(20);
    this.lowB = bin(150);
    this.midB = bin(2000);
    this.highB = bin(Math.min(16000, sampleRate / 2 - 1));
  }

  reset(): void {
    this.prevLog.fill(0);
    this.prevMag.fill(0);
    this.first = true;
  }

  /**
   * Measure one frame. `frame` is FRAME_SIZE raw samples (oldest first).
   * `out` is reused to avoid allocation in the audio thread.
   */
  process(frame: ArrayLike<number>, out: FrameMeasurement, hopForPeak = HOP_SIZE): FrameMeasurement {
    const n = this.n;
    const buf = this.buf;
    let sq = 0;
    let pk = 0;
    for (let i = 0; i < n; i++) {
      const s = frame[i] ?? 0;
      sq += s * s;
      buf[i] = s * this.win[i];
      if (i >= n - hopForPeak) {
        const a = s < 0 ? -s : s;
        if (a > pk) pk = a;
      }
    }
    this.fft.magnitude(buf, this.mag);
    const mag = this.mag;
    const { lowA, lowB, midB, highB, binHz } = this;
    let lo = 0, mi = 0, hi = 0, wsum = 0, msum = 0, logSum = 0;
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
      const lg = Math.log1p(1000 * m);
      const d = lg - this.prevLog[k];
      this.prevLog[k] = lg;
      if (d > 0) {
        fl += d;
        if (k >= midB) hfl += d;
      }
      // Low band uses LINEAR magnitude flux so the loudest low-end attack
      // (usually the kick) dominates rather than every bass-note onset.
      if (k < lowB) {
        const dl = m - this.prevMag[k];
        if (dl > 0) lfl += dl;
      }
      this.prevMag[k] = m;
    }
    out.rms = Math.sqrt(sq / n);
    out.peak = pk;
    out.low = lo;
    out.mid = mi;
    out.high = hi;
    out.centroid = msum > 1e-9 ? wsum / msum : 0;
    out.flatness = msum > 1e-9 ? Math.exp(logSum / highB) / (msum / highB) : 0;
    if (this.first) {
      out.flux = out.lowFlux = out.highFlux = out.fluxAbs = 0;
      this.first = false;
    } else {
      out.flux = fl;
      out.lowFlux = lfl;
      out.highFlux = hfl;
      out.fluxAbs = fl / highB;
    }
    return out;
  }

  /** Sum magnitudes into log-spaced display bands (call right after process()). */
  bands(edges: number[], out: Float32Array): Float32Array {
    const mag = this.mag;
    for (let b = 0; b < edges.length - 1; b++) {
      const k0 = Math.max(1, Math.floor(edges[b] / this.binHz));
      const k1 = Math.max(k0 + 1, Math.ceil(edges[b + 1] / this.binHz));
      let s = 0;
      for (let k = k0; k < k1 && k < mag.length; k++) s = Math.max(s, mag[k]);
      out[b] = s;
    }
    return out;
  }
}

export function emptyMeasurement(): FrameMeasurement {
  return { rms: 0, peak: 0, low: 0, mid: 0, high: 0, centroid: 0, flatness: 0, flux: 0, lowFlux: 0, highFlux: 0, fluxAbs: 0 };
}
