/** Decode an audio File into PCM using the browser's own decoders. */

export interface DecodedAudio {
  buffer: AudioBuffer;
  channels: Float32Array[];
  sampleRate: number;
  duration: number;
}

export const ACCEPTED = '.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.webm,audio/*';
export const MAX_BYTES = 300 * 1024 * 1024;
export const MAX_SECONDS = 20 * 60;

export async function decodeFile(file: File, ctx: BaseAudioContext): Promise<DecodedAudio> {
  if (file.size > MAX_BYTES) throw new Error('That file is larger than 300 MB.');
  const bytes = await file.arrayBuffer();
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(bytes);
  } catch {
    throw new Error("This browser couldn't decode that file. Try MP3, WAV, M4A or FLAC.");
  }
  if (buffer.duration < 3) throw new Error('That clip is shorter than 3 seconds.');
  if (buffer.duration > MAX_SECONDS) throw new Error('Tracks up to 20 minutes are supported.');
  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c).slice());
  return { buffer, channels, sampleRate: buffer.sampleRate, duration: buffer.duration };
}

/** Min/max peaks per bucket for waveform drawing. */
export function computePeaks(channels: Float32Array[], buckets: number): { min: Float32Array; max: Float32Array; rms: Float32Array } {
  const n = channels[0].length;
  const size = n / buckets;
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const rms = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    const a = Math.floor(b * size);
    const e = Math.min(n, Math.floor((b + 1) * size));
    let lo = 1, hi = -1, sq = 0;
    for (let i = a; i < e; i++) {
      let v = 0;
      for (const ch of channels) v += ch[i];
      v /= channels.length;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sq += v * v;
    }
    min[b] = lo;
    max[b] = hi;
    rms[b] = Math.sqrt(sq / Math.max(1, e - a));
  }
  return { min, max, rms };
}
