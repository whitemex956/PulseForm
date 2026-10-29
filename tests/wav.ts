import { readFileSync } from 'node:fs';

/** Minimal PCM16/float32 WAV reader for Node-side tests. */
export function readWav(path: string): { channels: Float32Array[]; sampleRate: number } {
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV');
  let off = 12;
  let fmt = { format: 1, ch: 2, sr: 44100, bits: 16 };
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: dv.getUint16(body, true),
        ch: dv.getUint16(body + 2, true),
        sr: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      const bps = fmt.bits / 8;
      const frames = Math.floor(size / (bps * fmt.ch));
      const channels = Array.from({ length: fmt.ch }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < fmt.ch; c++) {
          const p = body + (i * fmt.ch + c) * bps;
          channels[c][i] = fmt.format === 3 ? dv.getFloat32(p, true) : dv.getInt16(p, true) / 32768;
        }
      }
      return { channels, sampleRate: fmt.sr };
    }
    off = body + size + (size & 1);
  }
  throw new Error('no data chunk');
}
