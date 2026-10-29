/// <reference lib="webworker" />
import { analyzeAudio } from '../analysis/analyze';
import type { AnalysisResult, ProgressEvent } from '../analysis/types';

export type WorkerIn = { channels: Float32Array[]; sampleRate: number };
export type WorkerOut =
  | { type: 'progress'; event: ProgressEvent }
  | { type: 'done'; result: AnalysisResult }
  | { type: 'error'; message: string };

const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  try {
    let last = 0;
    const result = analyzeAudio(e.data.channels, e.data.sampleRate, (event) => {
      const now = performance.now();
      // throttle fine-grained progress, never drop stage completions
      if (event.progress >= 1 || event.progress === 0 || now - last > 60) {
        last = now;
        post({ type: 'progress', event });
      }
    });
    const f = result.frames;
    post({ type: 'done', result }, [
      f.rms.buffer, f.low.buffer, f.mid.buffer, f.high.buffer, f.centroid.buffer, f.flatness.buffer,
      f.onset.buffer, f.lowOnset.buffer, f.highOnset.buffer, f.energy.buffer,
    ] as Transferable[]);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
