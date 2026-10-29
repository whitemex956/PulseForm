/**
 * AudioWorklet: measures the incoming signal on the audio thread with the same
 * FrameExtractor used for offline analysis, and posts compact measurements
 * plus min/max waveform blocks to the main thread. No audio leaves the device;
 * nothing is recorded.
 */
import { FrameExtractor, FRAME_SIZE, HOP_SIZE, emptyMeasurement, spectrumEdges } from '../analysis/frameExtractor';

declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

export const SPECTRUM_BANDS = 48;
const BLOCK = 128;

export interface LiveFrameMsg {
  type: 'frame';
  /** audio-context time of the newest sample in this frame */
  t: number;
  rms: number;
  peak: number;
  low: number;
  mid: number;
  high: number;
  centroid: number;
  flatness: number;
  flux: number;
  lowFlux: number;
  highFlux: number;
  fluxAbs: number;
  /** spectrum band magnitudes */
  bands: Float32Array;
  /** min/max per 128-sample block, interleaved [min0,max0,min1,max1,...] */
  wave: Float32Array;
}

class LiveAnalyzerProcessor extends AudioWorkletProcessor {
  private ex = new FrameExtractor(sampleRate);
  private ring = new Float32Array(FRAME_SIZE);
  private frame = new Float32Array(FRAME_SIZE);
  private write = 0;
  private sinceHop = 0;
  private m = emptyMeasurement();
  private edges = spectrumEdges(SPECTRUM_BANDS);
  private wave = new Float32Array((HOP_SIZE / BLOCK) * 2);
  private waveIdx = 0;
  private active = true;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data?.type === 'stop') this.active = false;
      if (e.data?.type === 'reset') this.ex.reset();
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.active) return false;
    const input = inputs[0];
    const n = input?.[0]?.length ?? BLOCK;
    const chs = input?.length ?? 0;
    let lo = 1, hi = -1;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < chs; c++) s += input[c][i];
      s = chs ? s / chs : 0;
      this.ring[this.write] = s;
      this.write = (this.write + 1) % FRAME_SIZE;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    if (!chs) lo = hi = 0;
    if (this.waveIdx < this.wave.length) {
      this.wave[this.waveIdx++] = lo;
      this.wave[this.waveIdx++] = hi;
    }
    this.sinceHop += n;
    if (this.sinceHop >= HOP_SIZE) {
      this.sinceHop -= HOP_SIZE;
      // unroll ring into chronological frame
      const w = this.write;
      this.frame.set(this.ring.subarray(w), 0);
      this.frame.set(this.ring.subarray(0, w), FRAME_SIZE - w);
      const m = this.ex.process(this.frame, this.m);
      const bands = this.ex.bands(this.edges, new Float32Array(SPECTRUM_BANDS));
      const wave = this.wave.slice(0, this.waveIdx);
      this.waveIdx = 0;
      const msg: LiveFrameMsg = { type: 'frame', t: currentTime + n / sampleRate, ...m, bands, wave };
      this.port.postMessage(msg, [bands.buffer, wave.buffer]);
    }
    return true;
  }
}

registerProcessor('pulseform-live-analyzer', LiveAnalyzerProcessor);
