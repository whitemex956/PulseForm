import { computeFrameFeatures } from './features';
import { buildBeatGrid } from './tempo';
import { analyzeStructure } from './structure';
import { computeDescriptors, detectTransients } from './descriptors';
import { fingerprint, movingAverage } from './dsp';
import type { AnalysisResult, ProgressEvent } from './types';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] / channels.length;
  return out;
}

/**
 * Full analysis pipeline over decoded PCM. Deterministic and side-effect free;
 * runs in a Web Worker in the app and in Node for tests.
 */
export function analyzeAudio(
  channels: Float32Array[],
  sampleRate: number,
  onProgress?: (e: ProgressEvent) => void,
): AnalysisResult {
  const timings: Record<string, number> = {};
  let t0 = now();
  const mark = (k: string) => {
    const t = now();
    timings[k] = (t - t0) / 1000;
    t0 = t;
  };

  const mono = mixToMono(channels);
  const duration = mono.length / sampleRate;
  let peak = 0;
  for (let i = 0; i < mono.length; i++) peak = Math.max(peak, Math.abs(mono[i]));

  onProgress?.({ stage: 'spectrum', progress: 0 });
  const raw = computeFrameFeatures(mono, sampleRate, (p) => onProgress?.({ stage: 'spectrum', progress: p }));
  onProgress?.({ stage: 'spectrum', progress: 1, detail: `${raw.frames.count.toLocaleString()} frames` });
  mark('spectrum');

  onProgress?.({ stage: 'onsets', progress: 0 });
  const transients = detectTransients(raw.frames, raw.fluxAbs);
  onProgress?.({ stage: 'onsets', progress: 1, detail: `${transients.length} transients` });
  mark('onsets');

  // harmonic-change proxy for downbeats: rise in smoothed mid band
  const midSmooth = movingAverage(raw.frames.mid, Math.round(0.2 / raw.frames.hop));
  const lag = Math.round(0.25 / raw.frames.hop);
  const midChange = new Float32Array(midSmooth.length);
  for (let i = lag; i < midSmooth.length; i++) midChange[i] = Math.max(0, midSmooth[i] - midSmooth[i - lag]);

  onProgress?.({ stage: 'tempo', progress: 0 });
  const grid = buildBeatGrid(raw.onsetRaw, raw.frames.lowOnset, midChange, raw.frames.hop, (stage, p, detail) =>
    onProgress?.({ stage, progress: p, detail }),
  );
  mark('tempo+beats');

  onProgress?.({ stage: 'structure', progress: 0 });
  const structure = analyzeStructure(raw.frames, grid, duration);
  onProgress?.({
    stage: 'structure',
    progress: 1,
    detail: `${structure.sections.length} sections · ${structure.drops.length} likely drop${structure.drops.length === 1 ? '' : 's'}`,
  });
  mark('structure');

  onProgress?.({ stage: 'descriptors', progress: 0 });
  const descriptors = computeDescriptors(raw, grid, structure.sections, transients, duration);
  onProgress?.({ stage: 'descriptors', progress: 1 });
  mark('descriptors');

  let sumDb = 0;
  for (let i = 0; i < raw.rmsDb.length; i++) sumDb += raw.rmsDb[i];

  return {
    version: 1,
    duration,
    sampleRate,
    channels: channels.length,
    meanDb: sumDb / raw.rmsDb.length,
    peakDb: 20 * Math.log10(peak + 1e-9),
    frames: raw.frames,
    transients,
    beatGrid: grid,
    sections: structure.sections,
    drops: structure.drops,
    builds: structure.builds,
    descriptors,
    fingerprint: fingerprint(mono, sampleRate),
    timings,
  };
}
