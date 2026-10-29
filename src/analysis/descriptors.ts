import { clamp01, mean, movingAverage, percentile } from './dsp';
import type { RawSpectralFeatures } from './features';
import type { BeatGrid, Descriptor, FrameFeatures, Section, Transient } from './types';

/**
 * Peak-pick the onset envelope. Two gates: a relative one (above the local
 * mean) and an absolute one on per-bin log flux, so the noise floor of a quiet
 * ambient track is not mistaken for attacks.
 */
export function detectTransients(frames: FrameFeatures, fluxAbs: Float32Array): Transient[] {
  const { onset, lowOnset, highOnset, hop } = frames;
  const absGate = 1.8 * percentile(fluxAbs, 50) + 0.15;
  const local = movingAverage(onset, Math.round(0.3 / hop));
  const win = Math.max(1, Math.round(0.05 / hop));
  const out: Transient[] = [];
  let last = -Infinity;
  for (let i = 1; i < onset.length - 1; i++) {
    const v = onset[i];
    if (v < 0.2 || v < local[i] + 0.1 || fluxAbs[i] < absGate) continue;
    let isMax = true;
    for (let d = -win; d <= win && isMax; d++) if (d && (onset[i + d] ?? 0) > v) isMax = false;
    if (!isMax) continue;
    const t = i * hop;
    if (t - last < 0.06) continue;
    last = t;
    const lo = lowOnset[i], hi = highOnset[i];
    const band = lo > 0.5 && lo > hi ? 'low' : hi > 0.5 && hi > lo ? 'high' : lo + hi < 0.4 ? 'mid' : 'full';
    out.push({ time: t, strength: v, band });
  }
  return out;
}

function level(v: number): string {
  if (v < 0.2) return 'Very low';
  if (v < 0.4) return 'Low';
  if (v < 0.6) return 'Medium';
  if (v < 0.8) return 'High';
  return 'Very high';
}

export function computeDescriptors(
  raw: RawSpectralFeatures,
  grid: BeatGrid,
  sections: Section[],
  transients: Transient[],
  duration: number,
): Descriptor[] {
  const f = raw.frames;
  const meanDb = mean(raw.rmsDb);
  // weight centroid by frame RMS so silence does not dominate
  let cw = 0, cs = 0;
  for (let i = 0; i < f.count; i++) {
    cs += f.centroid[i] * f.rms[i];
    cw += f.rms[i];
  }
  const centroidHz = cw ? cs / cw : 0;
  let lowP = 0, totP = 0;
  for (let i = 0; i < f.count; i++) {
    lowP += raw.lowRaw[i];
    totP += raw.lowRaw[i] + raw.midRaw[i] + raw.highRaw[i];
  }
  const bassShare = totP ? lowP / totP : 0;
  const onsetRate = transients.length / Math.max(1, duration);
  const smoothDb = movingAverage(raw.rmsDb, Math.round(1.5 / f.hop));
  const dynRange = percentile(smoothDb, 95) - percentile(smoothDb, 10);
  const flat = mean(f.flatness);

  const loud = clamp01((meanDb + 35) / 27); // -35 dBFS..-8 dBFS
  const brightness = clamp01(Math.log(Math.max(centroidHz, 1) / 500) / Math.log(10)); // 500 Hz..5 kHz
  const density = clamp01(onsetRate / 6);
  const tempoN = grid.bpm ? clamp01((grid.bpm - 60) / 120) : 0;
  const energy = clamp01(0.45 * loud + 0.3 * density + 0.25 * (grid.hasPulse ? tempoN : 0));
  const contrast = clamp01(dynRange / 18);
  const dropCount = sections.filter((s) => s.kind === 'drop').length;

  let mood: string;
  if (energy < 0.3) mood = brightness > 0.5 ? 'Airy, calm' : 'Dark, meditative';
  else if (energy < 0.55) mood = brightness > 0.5 ? 'Bright, grooving' : 'Deep, hypnotic';
  else if (energy < 0.75) mood = brightness > 0.55 ? 'Euphoric, driving' : 'Dark, driving';
  else mood = brightness > 0.55 ? 'Explosive, euphoric' : 'Aggressive, intense';

  return [
    { key: 'energy', label: 'Energy', value: energy, text: level(energy), provenance: 'estimated', basis: 'Loudness, transient rate and tempo' },
    { key: 'loudness', label: 'Loudness', value: loud, text: `${meanDb.toFixed(1)} dBFS avg`, provenance: 'measured', basis: 'Mean RMS level' },
    { key: 'brightness', label: 'Brightness', value: brightness, text: `${Math.round(centroidHz)} Hz centroid`, provenance: 'measured', basis: 'RMS-weighted spectral centroid' },
    { key: 'bass', label: 'Bass weight', value: clamp01(bassShare * 1.6), text: `${Math.round(bassShare * 100)}% of power`, provenance: 'measured', basis: 'Share of power below 150 Hz' },
    { key: 'density', label: 'Rhythmic density', value: density, text: `${onsetRate.toFixed(1)} attacks/s`, provenance: 'measured', basis: 'Detected transients per second' },
    { key: 'contrast', label: 'Dynamic contrast', value: contrast, text: `${dynRange.toFixed(1)} dB range`, provenance: 'measured', basis: 'p95–p10 of smoothed level' },
    { key: 'texture', label: 'Texture', value: clamp01(flat * 4), text: flat > 0.15 ? 'Noisy / airy' : flat > 0.06 ? 'Mixed' : 'Tonal / smooth', provenance: 'measured', basis: 'Mean spectral flatness' },
    { key: 'drops', label: 'Drops', value: clamp01(dropCount / 3), text: dropCount ? `${dropCount} likely` : 'None detected', provenance: 'estimated', basis: 'Energy jumps after builds/breakdowns' },
    { key: 'mood', label: 'Mood', value: energy, text: mood, provenance: 'estimated', basis: 'Rule-based from energy and brightness' },
  ];
}
