import { Engine } from '../render/engine';
import { WORLDS } from '../render/worlds';
import { DirectorRuntime, type DirectorSettings } from '../director/runtime';
import type { Timeline } from '../timeline/timeline';
import type { AnalysisResult } from '../analysis/types';
import { muxMp4, type AudioSample, type VideoSample } from './mp4';

/**
 * Deterministic MP4 export.
 *
 * Every video frame is rendered at an exact song time t = start + i / fps from
 * the pre-analysed timeline (never by screen recording), encoded with WebCodecs
 * H.264, and muxed with the ORIGINAL audio, re-encoded to AAC (or Opus where the
 * browser has no AAC encoder). The file is reported ready only after the
 * browser has decoded it back and its duration and picture check out.
 */

export type Aspect = '9:16' | '16:9' | '1:1';

export interface ExportOptions {
  aspect: Aspect;
  fps: 30 | 60;
  start: number;
  end: number;
  world: string;
  stage: string | null;
  director: DirectorSettings;
  reducedMotion: boolean;
  photosensitive: boolean;
}

export interface ExportProgress {
  phase: 'preparing' | 'video' | 'audio' | 'muxing' | 'validating' | 'done';
  frame: number;
  frames: number;
  /** seconds remaining, estimated from the measured render speed */
  eta: number | null;
}

export interface ExportResult {
  blob: Blob;
  url: string;
  fileName: string;
  width: number;
  height: number;
  duration: number;
  bytes: number;
  videoCodec: string;
  audioCodec: string;
  validation: { durationOk: boolean; pictureOk: boolean; audioOk: boolean | null; decodedDuration: number };
}

export const SIZES: Record<Aspect, [number, number]> = {
  '9:16': [1080, 1920],
  '16:9': [1920, 1080],
  '1:1': [1080, 1080],
};

export function exportSupported(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

async function pickVideoCodec(w: number, h: number, fps: number): Promise<VideoEncoderConfig> {
  const bitrate = Math.round((w * h * fps * 0.11) / 1); // ~7 Mbps at 1080p30, ~14 at 60
  const level = fps > 30 ? '2a' : '28'; // 4.2 / 4.0
  for (const codec of [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.4200${level}`, 'avc1.640033']) {
    const cfg: VideoEncoderConfig = { codec, width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality', avc: { format: 'avc' } };
    try {
      if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg;
    } catch {
      /* try next */
    }
  }
  throw new Error('This browser can’t encode H.264 video. Try Chrome or Edge on a desktop.');
}

async function pickAudio(sampleRate: number, channels: number): Promise<{ cfg: AudioEncoderConfig; codec: 'aac' | 'opus' }> {
  const aac: AudioEncoderConfig = { codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate: 192000 };
  try {
    if ((await AudioEncoder.isConfigSupported(aac)).supported) return { cfg: aac, codec: 'aac' };
  } catch {
    /* fall through */
  }
  const opus: AudioEncoderConfig = { codec: 'opus', sampleRate: 48000, numberOfChannels: channels, bitrate: 192000 };
  if ((await AudioEncoder.isConfigSupported(opus)).supported) return { cfg: opus, codec: 'opus' };
  throw new Error('This browser can’t encode audio for MP4.');
}

async function resample(buffer: AudioBuffer, start: number, end: number, rate: number, channels: number): Promise<AudioBuffer> {
  const len = Math.max(1, Math.round((end - start) * rate));
  const ctx = new OfflineAudioContext(channels, len, rate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start(0, start, end - start);
  return ctx.startRendering();
}

export async function exportMp4(
  opts: ExportOptions,
  song: { analysis: AnalysisResult; timeline: Timeline; buffer: AudioBuffer; name: string },
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<ExportResult> {
  if (!exportSupported()) throw new Error('Video export needs WebCodecs (Chrome, Edge, or Safari 17+).');
  const [W, H] = SIZES[opts.aspect];
  const fps = opts.fps;
  const start = Math.max(0, opts.start);
  const end = Math.min(song.analysis.duration, opts.end);
  const frames = Math.max(1, Math.round((end - start) * fps));
  onProgress({ phase: 'preparing', frame: 0, frames, eta: null });

  // ---- offscreen engine at the exact output size, fixed top quality
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.style.cssText = `position:fixed;left:-99999px;top:0;width:${W}px;height:${H}px;pointer-events:none`;
  document.body.appendChild(canvas);
  const engine = new Engine(canvas);
  engine.settings.fixedSize = { w: W, h: H };
  engine.settings.quality = 3;
  engine.settings.frameOffset = opts.aspect === '9:16' ? 0.02 : 0.04;
  engine.settings.reducedMotion = opts.reducedMotion;
  engine.settings.photosensitive = opts.photosensitive;
  engine.settings.stageWorld = opts.world === 'festival' ? opts.stage : null;
  for (const id of new Set([opts.world, opts.stage].filter(Boolean) as string[])) engine.register(WORLDS.find((w) => w.id === id)!.create());
  const dir = new DirectorRuntime({ ...opts.director });
  dir.planFor(song.analysis);

  const vcfg = await pickVideoCodec(W, H, fps);
  const videoSamples: VideoSample[] = [];
  let avcC: Uint8Array | null = null;
  let encError: Error | null = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      videoSamples.push({ data, pts: chunk.timestamp, dur: chunk.duration ?? 1e6 / fps, key: chunk.type === 'key' });
      if (meta?.decoderConfig?.description && !avcC) avcC = new Uint8Array(meta.decoderConfig.description as ArrayBuffer);
    },
    error: (e) => (encError = e),
  });
  venc.configure(vcfg);

  const cleanup = () => {
    engine.dispose();
    canvas.remove();
    if (venc.state !== 'closed') venc.close();
  };

  try {
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (encError) throw encError;
      const t = start + i / fps;
      const s = song.timeline.stateAt(t);
      const params = dir.paramsFile(s);
      engine.render(opts.world, s, params, t * 1000);
      const vf = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      venc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
      vf.close();
      while (venc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 2));
      if (i % 5 === 0) {
        const per = (performance.now() - t0) / (i + 1) / 1000;
        onProgress({ phase: 'video', frame: i + 1, frames, eta: per * (frames - i - 1) });
        await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
      }
    }
    await venc.flush();
    if (encError) throw encError;
    if (!avcC) throw new Error('The video encoder did not provide its configuration.');
  } catch (e) {
    cleanup();
    throw e;
  }
  cleanup();

  // ---- audio: the original song, trimmed to the range and re-encoded
  onProgress({ phase: 'audio', frame: frames, frames, eta: null });
  const channels = Math.min(2, song.buffer.numberOfChannels);
  const { cfg: acfg, codec: acodec } = await pickAudio(song.buffer.sampleRate, channels);
  const pcm = await resample(song.buffer, start, end, acfg.sampleRate, channels);
  const audioSamples: AudioSample[] = [];
  let aDesc: Uint8Array | undefined;
  let aErr: Error | null = null;
  const aenc = new AudioEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      audioSamples.push({ data, pts: chunk.timestamp, dur: chunk.duration ?? 0 });
      if (meta?.decoderConfig?.description && !aDesc) aDesc = new Uint8Array(meta.decoderConfig.description as ArrayBuffer);
    },
    error: (e) => (aErr = e),
  });
  aenc.configure(acfg);
  const block = 4096;
  for (let off = 0; off < pcm.length; off += block) {
    if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
    const n = Math.min(block, pcm.length - off);
    const planar = new Float32Array(n * channels);
    for (let c = 0; c < channels; c++) planar.set(pcm.getChannelData(c).subarray(off, off + n), c * n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: acfg.sampleRate, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round((off * 1e6) / acfg.sampleRate), data: planar });
    aenc.encode(ad);
    ad.close();
  }
  await aenc.flush();
  aenc.close();
  if (aErr) throw aErr;
  // fill missing durations from timestamps
  for (let i = 0; i < audioSamples.length; i++) {
    if (!audioSamples[i].dur) audioSamples[i].dur = (audioSamples[i + 1]?.pts ?? audioSamples[i].pts + 20000) - audioSamples[i].pts;
  }

  // ---- mux
  onProgress({ phase: 'muxing', frame: frames, frames, eta: null });
  const bytes = muxMp4({
    width: W,
    height: H,
    avcC: avcC!,
    video: videoSamples.sort((a, b) => a.pts - b.pts),
    audio: { codec: acodec, sampleRate: acfg.sampleRate, channels, description: aDesc, samples: audioSamples },
  });
  const blob = new Blob([bytes], { type: 'video/mp4' });
  const url = URL.createObjectURL(blob);

  // ---- validate by decoding the file we just made
  onProgress({ phase: 'validating', frame: frames, frames, eta: null });
  const validation = await validateMp4(url, end - start, W, H);
  if (!validation.durationOk || !validation.pictureOk) {
    URL.revokeObjectURL(url);
    throw new Error(`The exported file failed its check (duration ${validation.decodedDuration.toFixed(2)} s, picture ${validation.pictureOk ? 'ok' : 'blank'}). Nothing was saved.`);
  }
  onProgress({ phase: 'done', frame: frames, frames, eta: 0 });
  const base = song.name.replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').trim() || 'song';
  return {
    blob,
    url,
    fileName: `${base} · PulseForm ${opts.aspect.replace(':', 'x')}.mp4`,
    width: W,
    height: H,
    duration: end - start,
    bytes: blob.size,
    videoCodec: vcfg.codec,
    audioCodec: acodec === 'aac' ? 'AAC' : 'Opus',
    validation,
  };
}

/** Load the file in a <video>, check duration, decode a frame mid-way, check audio decoded. */
export async function validateMp4(url: string, expected: number, w: number, h: number): Promise<ExportResult['validation']> {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = url;
  await new Promise<void>((res, rej) => {
    v.onloadedmetadata = () => res();
    v.onerror = () => rej(new Error('The browser could not open the exported file.'));
    setTimeout(() => rej(new Error('Timed out opening the exported file.')), 20000);
  });
  const decodedDuration = v.duration;
  const durationOk = Math.abs(decodedDuration - expected) < 0.25 && v.videoWidth === w && v.videoHeight === h;
  v.currentTime = Math.min(expected * 0.6, Math.max(0, expected - 0.2));
  await new Promise<void>((res) => {
    v.onseeked = () => res();
    setTimeout(res, 8000);
  });
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.drawImage(v, 0, 0, 64, 64);
  const d = g.getImageData(0, 0, 64, 64).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
  const pictureOk = lit > 20;
  // audio: play muted briefly and see whether the decoder produced audio bytes (Chrome)
  let audioOk: boolean | null = null;
  const anyV = v as HTMLVideoElement & { webkitAudioDecodedByteCount?: number; audioTracks?: { length: number } };
  try {
    await v.play();
    await new Promise((r) => setTimeout(r, 600));
    v.pause();
    if (typeof anyV.webkitAudioDecodedByteCount === 'number') audioOk = anyV.webkitAudioDecodedByteCount > 0;
    else if (anyV.audioTracks) audioOk = anyV.audioTracks.length > 0;
  } catch {
    /* autoplay of a muted element can still be blocked; leave audio unknown */
  }
  v.removeAttribute('src');
  v.load();
  return { durationOk, pictureOk, audioOk, decodedDuration };
}
