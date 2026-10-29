/** Small DSP/statistics helpers shared by analysis stages. */

export function percentile(arr: ArrayLike<number>, p: number): number {
  const a = Float64Array.from(arr as ArrayLike<number>).sort();
  if (a.length === 0) return 0;
  const idx = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))));
  return a[idx];
}

export function mean(arr: ArrayLike<number>, from = 0, to = arr.length): number {
  let s = 0;
  const a = Math.max(0, from);
  const b = Math.min(arr.length, to);
  if (b <= a) return a < arr.length ? arr[a] : arr.length ? arr[arr.length - 1] : 0;
  for (let i = a; i < b; i++) s += arr[i];
  return s / (b - a);
}

export function std(arr: ArrayLike<number>): number {
  const m = mean(arr);
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += (arr[i] - m) ** 2;
  return Math.sqrt(s / Math.max(1, arr.length));
}

/** Centered moving average with window w (frames). */
export function movingAverage(x: Float32Array, w: number): Float32Array {
  const out = new Float32Array(x.length);
  const half = Math.max(1, Math.floor(w / 2));
  let s = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < x.length; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(x.length - 1, i + half);
    while (hi < b) s += x[++hi];
    while (lo < a) s -= x[lo++];
    out[i] = s / (hi - lo + 1);
  }
  return out;
}

/** Scale to 0..1 by dividing by the given percentile and clipping. */
export function normalizeByPercentile(x: Float32Array, p = 98): Float32Array {
  const ref = percentile(x, p) || 1e-12;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.min(1, Math.max(0, x[i] / ref));
  return out;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Linear-interpolated lookup of a frame-rate signal at time t. */
export function sampleAt(x: ArrayLike<number>, hop: number, t: number): number {
  const f = t / hop;
  const i = Math.floor(f);
  if (i < 0) return x[0] ?? 0;
  if (i >= x.length - 1) return x[x.length - 1] ?? 0;
  const u = f - i;
  return x[i] * (1 - u) + x[i + 1] * u;
}

/** FNV-1a 32-bit hash over quantized samples (stable fingerprint). */
export function fingerprint(samples: Float32Array, sampleRate: number): string {
  let h = 0x811c9dc5;
  const stride = Math.max(1, Math.floor(samples.length / 200000));
  for (let i = 0; i < samples.length; i += stride) {
    const q = Math.round(samples[i] * 1000) & 0xffff;
    h ^= q & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= q >> 8;
    h = Math.imul(h, 0x01000193);
  }
  h ^= sampleRate;
  h = Math.imul(h, 0x01000193);
  h ^= samples.length;
  h = Math.imul(h, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}
