/**
 * Minimal MP4 (ISO BMFF) muxer for one H.264 video track and one AAC or Opus
 * audio track. Writes a non-fragmented, "fast start" file (moov before mdat) so
 * it plays and seeks in browsers, QuickTime/Photos and social apps.
 */

export interface VideoSample {
  data: Uint8Array;
  /** presentation time, microseconds */
  pts: number;
  /** duration, microseconds */
  dur: number;
  key: boolean;
}

export interface AudioSample {
  data: Uint8Array;
  pts: number;
  dur: number;
}

export interface MuxInput {
  width: number;
  height: number;
  /** AVCDecoderConfigurationRecord from the VideoEncoder */
  avcC: Uint8Array;
  video: VideoSample[];
  audio?: {
    codec: 'aac' | 'opus';
    sampleRate: number;
    channels: number;
    /** AAC: AudioSpecificConfig. Opus: OpusHead (optional) */
    description?: Uint8Array;
    samples: AudioSample[];
  };
}

class W {
  private parts: Uint8Array[] = [];
  size = 0;
  bytes(b: Uint8Array | number[]) {
    const u = b instanceof Uint8Array ? b : new Uint8Array(b);
    this.parts.push(u);
    this.size += u.length;
  }
  u8(v: number) {
    this.bytes([v & 255]);
  }
  u16(v: number) {
    this.bytes([(v >> 8) & 255, v & 255]);
  }
  u24(v: number) {
    this.bytes([(v >> 16) & 255, (v >> 8) & 255, v & 255]);
  }
  u32(v: number) {
    this.bytes([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
  }
  u64(v: number) {
    this.u32(Math.floor(v / 2 ** 32));
    this.u32(v >>> 0);
  }
  str(s: string) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
  }
  done(): Uint8Array {
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

function box(type: string, ...children: Array<Uint8Array | ((w: W) => void)>): Uint8Array {
  const w = new W();
  for (const c of children) {
    if (typeof c === 'function') c(w);
    else w.bytes(c);
  }
  const body = w.done();
  const out = new W();
  out.u32(body.length + 8);
  out.str(type);
  out.bytes(body);
  return out.done();
}

function fullbox(type: string, version: number, flags: number, ...children: Array<Uint8Array | ((w: W) => void)>): Uint8Array {
  return box(type, (w) => {
    w.u8(version);
    w.u24(flags);
  }, ...children);
}

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

function sttsEntries(durations: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const d of durations) {
    const last = out[out.length - 1];
    if (last && last[1] === d) last[0]++;
    else out.push([1, d]);
  }
  return out;
}

function stbl(sampleEntry: Uint8Array, durations: number[], sizes: number[], chunkOffset: number, keyframes: number[] | null, ctts: number[] | null): Uint8Array {
  const n = sizes.length;
  const stts = sttsEntries(durations);
  return box(
    'stbl',
    fullbox('stsd', 0, 0, (w) => w.u32(1), sampleEntry),
    fullbox('stts', 0, 0, (w) => {
      w.u32(stts.length);
      for (const [c, d] of stts) {
        w.u32(c);
        w.u32(d);
      }
    }),
    ...(ctts
      ? [
          fullbox('ctts', 0, 0, (w) => {
            const e = sttsEntries(ctts);
            w.u32(e.length);
            for (const [c, d] of e) {
              w.u32(c);
              w.u32(d);
            }
          }),
        ]
      : []),
    ...(keyframes
      ? [
          fullbox('stss', 0, 0, (w) => {
            w.u32(keyframes.length);
            for (const k of keyframes) w.u32(k);
          }),
        ]
      : []),
    fullbox('stsc', 0, 0, (w) => {
      w.u32(1);
      w.u32(1); // first chunk
      w.u32(n); // samples per chunk: one chunk per track
      w.u32(1);
    }),
    fullbox('stsz', 0, 0, (w) => {
      w.u32(0);
      w.u32(n);
      for (const s of sizes) w.u32(s);
    }),
    chunkOffset > 0xffffffff
      ? fullbox('co64', 0, 0, (w) => {
          w.u32(1);
          w.u64(chunkOffset);
        })
      : fullbox('stco', 0, 0, (w) => {
          w.u32(1);
          w.u32(chunkOffset);
        }),
  );
}

function trak(id: number, kind: 'vide' | 'soun', timescale: number, duration: number, movieDuration: number, w: number, h: number, stblBox: Uint8Array): Uint8Array {
  return box(
    'trak',
    fullbox('tkhd', 0, 3, (x) => {
      x.u32(0);
      x.u32(0);
      x.u32(id);
      x.u32(0);
      x.u32(movieDuration);
      x.u32(0);
      x.u32(0);
      x.u16(0);
      x.u16(0);
      x.u16(kind === 'soun' ? 0x0100 : 0);
      x.u16(0);
      for (const v of MATRIX) x.u32(v);
      x.u32(kind === 'vide' ? w << 16 : 0);
      x.u32(kind === 'vide' ? h << 16 : 0);
    }),
    box(
      'mdia',
      fullbox('mdhd', 0, 0, (x) => {
        x.u32(0);
        x.u32(0);
        x.u32(timescale);
        x.u32(duration);
        x.u16(0x55c4); // 'und'
        x.u16(0);
      }),
      fullbox('hdlr', 0, 0, (x) => {
        x.u32(0);
        x.str(kind);
        x.u32(0);
        x.u32(0);
        x.u32(0);
        x.str(kind === 'vide' ? 'PulseForm Video\0' : 'PulseForm Audio\0');
      }),
      box(
        'minf',
        kind === 'vide'
          ? fullbox('vmhd', 0, 1, (x) => {
              x.u16(0);
              x.u16(0);
              x.u16(0);
              x.u16(0);
            })
          : fullbox('smhd', 0, 0, (x) => {
              x.u16(0);
              x.u16(0);
            }),
        box('dinf', fullbox('dref', 0, 0, (x) => x.u32(1), fullbox('url ', 0, 1))),
        stblBox,
      ),
    ),
  );
}

function avc1(width: number, height: number, avcC: Uint8Array): Uint8Array {
  return box(
    'avc1',
    (w) => {
      w.bytes(new Uint8Array(6));
      w.u16(1); // data reference index
      w.u16(0);
      w.u16(0);
      w.u32(0);
      w.u32(0);
      w.u32(0);
      w.u16(width);
      w.u16(height);
      w.u32(0x00480000);
      w.u32(0x00480000);
      w.u32(0);
      w.u16(1);
      const name = 'PulseForm';
      w.u8(name.length);
      w.str(name);
      w.bytes(new Uint8Array(31 - name.length));
      w.u16(0x0018);
      w.u16(0xffff);
    },
    box('avcC', avcC),
  );
}

function descriptor(tag: number, body: Uint8Array): Uint8Array {
  const w = new W();
  w.u8(tag);
  // 4-byte expandable length
  const n = body.length;
  w.bytes([0x80 | ((n >> 21) & 0x7f), 0x80 | ((n >> 14) & 0x7f), 0x80 | ((n >> 7) & 0x7f), n & 0x7f]);
  w.bytes(body);
  return w.done();
}

/** AudioSpecificConfig for AAC-LC when the encoder doesn't provide one. */
export function aacConfig(sampleRate: number, channels: number): Uint8Array {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const fi = Math.max(0, rates.indexOf(sampleRate));
  return new Uint8Array([(2 << 3) | (fi >> 1), ((fi & 1) << 7) | (channels << 3)]);
}

function mp4a(sampleRate: number, channels: number, asc: Uint8Array, bitrate: number): Uint8Array {
  const dsi = descriptor(0x05, asc);
  const dcd = (() => {
    const w = new W();
    w.u8(0x40); // AAC
    w.u8(0x15); // audio stream
    w.u24(0);
    w.u32(bitrate);
    w.u32(bitrate);
    w.bytes(dsi);
    return descriptor(0x04, w.done());
  })();
  const sl = descriptor(0x06, new Uint8Array([0x02]));
  const esd = (() => {
    const w = new W();
    w.u16(2); // ES_ID
    w.u8(0);
    w.bytes(dcd);
    w.bytes(sl);
    return descriptor(0x03, w.done());
  })();
  return box('mp4a', audioEntryHeader(channels, sampleRate), fullbox('esds', 0, 0, esd));
}

function audioEntryHeader(channels: number, sampleRate: number) {
  return (w: W) => {
    w.bytes(new Uint8Array(6));
    w.u16(1);
    w.u32(0);
    w.u32(0);
    w.u16(channels);
    w.u16(16);
    w.u16(0);
    w.u16(0);
    w.u32(Math.min(65535, sampleRate) << 16);
  };
}

function opusEntry(sampleRate: number, channels: number, head?: Uint8Array): Uint8Array {
  // OpusHead: "OpusHead"(8) version(1) channels(1) preSkip(2 LE) rate(4 LE) gain(2 LE) family(1)
  let preSkip = 312;
  let inputRate = sampleRate;
  if (head && head.length >= 19) {
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    preSkip = dv.getUint16(10, true);
    inputRate = dv.getUint32(12, true);
  }
  const dOps = box('dOps', (w) => {
    w.u8(0);
    w.u8(channels);
    w.u16(preSkip);
    w.u32(inputRate);
    w.u16(0);
    w.u8(0);
  });
  return box('Opus', audioEntryHeader(channels, 48000), dOps);
}

export function muxMp4(input: MuxInput): Uint8Array {
  const VTS = 90000;
  const v = input.video;
  // decode order is output order (no B-frames requested); dts is monotonic
  const vDur = v.map((s) => Math.max(1, Math.round((s.dur * VTS) / 1e6)));
  const vSizes = v.map((s) => s.data.length);
  const keys = v.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
  const vTotal = vDur.reduce((a, b) => a + b, 0);
  let dts = 0;
  const cttsRaw = v.map((s, i) => {
    const o = Math.round((s.pts * VTS) / 1e6) - dts;
    dts += vDur[i];
    return o;
  });
  const ctts = cttsRaw.some((x) => x !== 0) && cttsRaw.every((x) => x >= 0) ? cttsRaw : null;

  const a = input.audio;
  const ATS = a ? (a.codec === 'opus' ? 48000 : a.sampleRate) : 1;
  const aDur = a ? a.samples.map((s) => Math.max(1, Math.round((s.dur * ATS) / 1e6))) : [];
  const aSizes = a ? a.samples.map((s) => s.data.length) : [];
  const aTotal = aDur.reduce((x, y) => x + y, 0);

  const movieDur = Math.round(Math.max(vTotal / VTS, a ? aTotal / ATS : 0) * 1000);
  const ftyp = box('ftyp', (w) => {
    w.str('isom');
    w.u32(0x200);
    w.str('isomiso2avc1mp41');
  });

  const build = (vOff: number, aOff: number) =>
    box(
      'moov',
      fullbox('mvhd', 0, 0, (w) => {
        w.u32(0);
        w.u32(0);
        w.u32(1000);
        w.u32(movieDur);
        w.u32(0x00010000);
        w.u16(0x0100);
        w.u16(0);
        w.u32(0);
        w.u32(0);
        for (const m of MATRIX) w.u32(m);
        for (let i = 0; i < 6; i++) w.u32(0);
        w.u32(a ? 3 : 2);
      }),
      trak(1, 'vide', VTS, vTotal, movieDur, input.width, input.height, stbl(avc1(input.width, input.height, input.avcC), vDur, vSizes, vOff, keys, ctts)),
      ...(a
        ? [
            trak(
              2,
              'soun',
              ATS,
              aTotal,
              movieDur,
              0,
              0,
              stbl(
                a.codec === 'aac' ? mp4a(a.sampleRate, a.channels, a.description ?? aacConfig(a.sampleRate, a.channels), 192000) : opusEntry(48000, a.channels, a.description),
                aDur,
                aSizes,
                aOff,
                null,
                null,
              ),
            ),
          ]
        : []),
    );

  const vBytes = vSizes.reduce((x, y) => x + y, 0);
  const aBytes = aSizes.reduce((x, y) => x + y, 0);
  // two passes: moov size does not depend on the offsets' values
  const moov0 = build(0, 0);
  const mdatHeader = 16; // 64-bit size header
  const vOff = ftyp.length + moov0.length + mdatHeader;
  const aOff = vOff + vBytes;
  const moov = build(vOff, aOff);
  const total = ftyp.length + moov.length + mdatHeader + vBytes + aBytes;
  const out = new Uint8Array(total);
  let o = 0;
  out.set(ftyp, o);
  o += ftyp.length;
  out.set(moov, o);
  o += moov.length;
  const dv = new DataView(out.buffer);
  dv.setUint32(o, 1);
  out.set([0x6d, 0x64, 0x61, 0x74], o + 4); // 'mdat'
  dv.setUint32(o + 8, Math.floor((mdatHeader + vBytes + aBytes) / 2 ** 32));
  dv.setUint32(o + 12, (mdatHeader + vBytes + aBytes) >>> 0);
  o += mdatHeader;
  for (const s of v) {
    out.set(s.data, o);
    o += s.data.length;
  }
  if (a)
    for (const s of a.samples) {
      out.set(s.data, o);
      o += s.data.length;
    }
  return out;
}
