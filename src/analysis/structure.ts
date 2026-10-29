import { mean, percentile } from './dsp';
import type { BeatGrid, FrameFeatures, Section, SectionKind } from './types';

/**
 * Structural segmentation.
 *
 * 1. Summarize the track into units: bars when a pulse exists, 1-second
 *    windows otherwise.
 * 2. Compute a novelty curve: distance between the mean feature vector of the
 *    L units before and after each unit boundary (a box-kernel variant of
 *    Foote's checkerboard novelty, 2000).
 * 3. Peak-pick boundaries with a minimum section length.
 * 4. Label sections by rules over measured energy, low-end weight, onset
 *    density and slope. Labels are ESTIMATES.
 */

interface Unit {
  start: number;
  end: number;
  v: number[]; // feature vector
  intensity: number;
  low: number;
  high: number;
  density: number;
}

const FEATS = ['energy', 'low', 'mid', 'high', 'onset', 'highOnset', 'centroid', 'flatness'] as const;

function unitBoundaries(frames: FrameFeatures, grid: BeatGrid, duration: number): number[] {
  if (grid.hasPulse && grid.downbeats.length >= 4) {
    const b = grid.downbeats.map((i) => grid.beats[i]);
    // extend to cover the whole track using the bar length
    const barLen = (60 / (grid.bpm ?? 120)) * 4;
    const out: number[] = [];
    for (let t = b[0]; t > 0; t -= barLen) out.unshift(t);
    if (out.length && out[0] > 0.05) out.unshift(0);
    if (!out.length) out.push(0);
    for (const t of b) if (t > out[out.length - 1] + barLen * 0.5) out.push(t);
    for (let t = out[out.length - 1] + barLen; t < duration; t += barLen) out.push(t);
    out.push(duration);
    return out;
  }
  const out: number[] = [];
  for (let t = 0; t < duration; t += 1) out.push(t);
  out.push(duration);
  return out;
}

function summarize(frames: FrameFeatures, a: number, b: number): Unit {
  const i0 = Math.max(0, Math.floor(a / frames.hop));
  const i1 = Math.min(frames.count, Math.max(i0 + 1, Math.floor(b / frames.hop)));
  const src: Record<(typeof FEATS)[number], Float32Array> = {
    energy: frames.energy,
    low: frames.low,
    mid: frames.mid,
    high: frames.high,
    onset: frames.onset,
    highOnset: frames.highOnset,
    centroid: frames.centroid,
    flatness: frames.flatness,
  };
  const v = FEATS.map((k) => mean(src[k], i0, i1));
  const energy = v[0], low = v[1], onsetD = v[4];
  return {
    start: a,
    end: b,
    v,
    intensity: 0.45 * energy + 0.35 * low + 0.2 * Math.min(1, onsetD * 3),
    low,
    high: v[3],
    density: onsetD,
  };
}

function zscore(units: Unit[]): number[][] {
  const d = units[0]?.v.length ?? 0;
  const mu = new Array(d).fill(0);
  const sd = new Array(d).fill(0);
  for (const u of units) u.v.forEach((x, j) => (mu[j] += x / units.length));
  for (const u of units) u.v.forEach((x, j) => (sd[j] += (x - mu[j]) ** 2 / units.length));
  return units.map((u) => u.v.map((x, j) => (x - mu[j]) / (Math.sqrt(sd[j]) || 1)));
}

export function noveltyCurve(z: number[][], L: number): number[] {
  const n = z.length;
  const out = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const a0 = Math.max(0, i - L), b1 = Math.min(n, i + L);
    if (i - a0 < 2 || b1 - i < 2) continue;
    let dist = 0;
    for (let j = 0; j < z[0].length; j++) {
      let ma = 0, mb = 0;
      for (let k = a0; k < i; k++) ma += z[k][j];
      for (let k = i; k < b1; k++) mb += z[k][j];
      dist += (ma / (i - a0) - mb / (b1 - i)) ** 2;
    }
    out[i] = Math.sqrt(dist);
  }
  return out;
}

function pickPeaks(nov: number[], minGap: number, thresh: number): number[] {
  const cand = nov
    .map((v, i) => ({ v, i }))
    .filter(({ v, i }) => v >= thresh && v >= (nov[i - 1] ?? 0) && v >= (nov[i + 1] ?? 0))
    .sort((a, b) => b.v - a.v);
  const chosen: number[] = [];
  for (const c of cand) if (chosen.every((x) => Math.abs(x - c.i) >= minGap)) chosen.push(c.i);
  return chosen.sort((a, b) => a - b);
}

function slopeOf(frames: FrameFeatures, a: number, b: number): number {
  // slope of combined (energy + high + onset) per second, via least squares on 0.25 s means
  const step = 0.25;
  const xs: number[] = [], ys: number[] = [];
  for (let t = a; t < b - step; t += step) {
    const i0 = Math.floor(t / frames.hop), i1 = Math.floor((t + step) / frames.hop);
    const y = mean(frames.energy, i0, i1) + mean(frames.high, i0, i1) + mean(frames.onset, i0, i1);
    xs.push(t);
    ys.push(y / 3);
  }
  if (xs.length < 3) return 0;
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den ? num / den : 0;
}

export interface StructureResult {
  sections: Section[];
  drops: number[];
  builds: Array<[number, number]>;
  novelty: number[];
}

export function analyzeStructure(frames: FrameFeatures, grid: BeatGrid, duration: number): StructureResult {
  const bounds = unitBoundaries(frames, grid, duration);
  const units: Unit[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] - bounds[i] > 0.05) units.push(summarize(frames, bounds[i], bounds[i + 1]));
  }
  if (units.length < 4) {
    const only = summarize(frames, 0, duration);
    return {
      sections: [{ start: 0, end: duration, kind: grid.hasPulse ? 'verse' : 'ambient', energy: only.v[0], slope: 0 }],
      drops: [],
      builds: [],
      novelty: [],
    };
  }

  const z = zscore(units);
  const unitLen = (duration / units.length);
  const L = grid.hasPulse ? 4 : 8; // 4 bars or 8 seconds either side
  const minGap = grid.hasPulse ? 4 : 10;
  const nov = noveltyCurve(z, L);
  const thresh = Math.max(percentile(nov, 75), (grid.hasPulse ? 1.2 : 2.2));
  const peaks = pickPeaks(nov, minGap, thresh);

  const cuts = [0, ...peaks, units.length];
  const sections: Section[] = [];
  const raw: Array<{ a: number; b: number; intensity: number; low: number; density: number; high: number }> = [];
  for (let s = 0; s < cuts.length - 1; s++) {
    const us = units.slice(cuts[s], cuts[s + 1]);
    const a = us[0].start, b = us[us.length - 1].end;
    raw.push({
      a,
      b,
      intensity: mean(us.map((u) => u.intensity)),
      low: mean(us.map((u) => u.low)),
      density: mean(us.map((u) => u.density)),
      high: mean(us.map((u) => u.high)),
    });
  }

  const intens = raw.map((r) => r.intensity);
  const hiT = percentile(intens, 70);
  const loT = percentile(intens, 30);
  const spread = Math.max(...intens) - Math.min(...intens);
  const flat = spread < 0.12 || !grid.hasPulse;

  raw.forEach((r, i) => {
    const slope = slopeOf(frames, r.a, r.b);
    const energy = mean(frames.energy, Math.floor(r.a / frames.hop), Math.floor(r.b / frames.hop));
    let kind: SectionKind;
    const next = raw[i + 1];
    const prev = sections[i - 1];
    if (flat) {
      kind = grid.hasPulse ? 'verse' : 'ambient';
    } else if (r.intensity >= hiT && r.low > 0.25) {
      const jump = prev ? r.intensity - raw[i - 1].intensity : 0;
      kind = prev && (prev.kind === 'build' || prev.kind === 'breakdown' || jump > 0.15) ? 'drop' : 'peak';
    } else if (next && next.intensity >= hiT && next.low > 0.25 && (slope > 0.004 || r.low < next.low * 0.5) && r.intensity < next.intensity) {
      kind = 'build';
    } else if (i === 0 && r.intensity < hiT) {
      kind = 'intro';
    } else if (i === raw.length - 1 && r.intensity < hiT) {
      kind = 'outro';
    } else if (r.intensity <= loT || r.low < 0.15) {
      kind = 'breakdown';
    } else {
      kind = 'verse';
    }
    sections.push({ start: r.a, end: r.b, kind, energy, slope });
  });

  // merge consecutive sections with identical kind
  const merged: Section[] = [];
  for (const s of sections) {
    const last = merged[merged.length - 1];
    if (last && last.kind === s.kind && s.kind !== 'drop') {
      const la = last.end - last.start, lb = s.end - s.start;
      last.energy = (last.energy * la + s.energy * lb) / (la + lb);
      last.end = s.end;
    } else merged.push({ ...s });
  }

  const drops = merged.filter((s) => s.kind === 'drop').map((s) => s.start);
  const builds = merged.filter((s) => s.kind === 'build').map((s) => [s.start, s.end] as [number, number]);
  void unitLen;
  return { sections: merged, drops, builds, novelty: nov };
}
