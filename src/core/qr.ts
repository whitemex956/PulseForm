/**
 * Minimal QR Code encoder (ISO/IEC 18004): byte mode, error correction level M,
 * versions 1–10 (up to 213 bytes). Enough for pairing URLs; no dependencies.
 * Verified in tests by decoding the output with OpenCV's QR detector.
 */

// [totalCodewords, ecPerBlock, [blocks, dataPerBlock][]] for level M
const VERSIONS: Array<[number, number, Array<[number, number]>]> = [
  [0, 0, []],
  [26, 10, [[1, 16]]],
  [44, 16, [[1, 28]]],
  [70, 26, [[1, 44]]],
  [100, 18, [[2, 32]]],
  [134, 24, [[2, 43]]],
  [172, 16, [[4, 27]]],
  [196, 18, [[4, 31]]],
  [242, 22, [[2, 38], [2, 39]]],
  [292, 22, [[3, 36], [2, 37]]],
  [346, 26, [[4, 43], [1, 44]]],
];
const ALIGN: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// ---------- GF(256) Reed–Solomon ----------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(n: number): number[] {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

function rsEncode(data: number[], ec: number): number[] {
  const gen = rsGenerator(ec);
  const res = new Array(ec).fill(0);
  for (const d of data) {
    const factor = d ^ res.shift()!;
    res.push(0);
    for (let i = 0; i < ec; i++) res[i] ^= mul(gen[i + 1], factor);
  }
  return res;
}

// ---------- BCH for format / version info ----------
function bch(value: number, poly: number, polyBits: number, dataBits: number): number {
  let v = value << (polyBits - 1);
  for (let i = dataBits + polyBits - 2; i >= polyBits - 1; i--) if ((v >> i) & 1) v ^= poly << (i - (polyBits - 1));
  return (value << (polyBits - 1)) | v;
}

export interface QrMatrix {
  size: number;
  /** row-major, true = dark */
  modules: boolean[];
}

export function encodeQR(text: string): QrMatrix {
  const bytes = Array.from(new TextEncoder().encode(text));
  let ver = 1;
  for (; ver <= 10; ver++) {
    const dataCap = VERSIONS[ver][2].reduce((s, [b, d]) => s + b * d, 0);
    const bits = 4 + (ver < 10 ? 8 : 16) + bytes.length * 8;
    if (bits <= dataCap * 8) break;
  }
  if (ver > 10) throw new Error('Text too long for this QR encoder');
  const [, ecLen, groups] = VERSIONS[ver];
  const dataCap = groups.reduce((s, [b, d]) => s + b * d, 0);

  // bit stream
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, dataCap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0; data.length < dataCap; pad++) data.push(pad % 2 ? 0x11 : 0xec);

  // blocks + interleave
  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let off = 0;
  for (const [n, d] of groups) {
    for (let i = 0; i < n; i++) {
      const blk = data.slice(off, off + d);
      off += d;
      blocks.push(blk);
      ecBlocks.push(rsEncode(blk, ecLen));
    }
  }
  const final: number[] = [];
  const maxD = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.length) final.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const b of ecBlocks) final.push(b[i]);

  // matrix
  const size = ver * 4 + 17;
  const mod = new Array<boolean>(size * size).fill(false);
  const fn = new Array<boolean>(size * size).fill(false);
  const set = (x: number, y: number, dark: boolean, isFn = true) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    mod[y * size + x] = dark;
    if (isFn) fn[y * size + x] = true;
  };
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, d !== 2 && d !== 4);
      }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  for (let i = 8; i < size - 8; i++) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }
  const al = ALIGN[ver];
  for (const ay of al)
    for (const ax of al) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === al[al.length - 1]) || (ax === al[al.length - 1] && ay === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  // reserve format areas
  for (let i = 0; i < 9; i++) {
    if (!fn[8 * size + i]) set(i, 8, false);
    if (!fn[i * size + 8]) set(8, i, false);
  }
  for (let i = 0; i < 8; i++) {
    set(size - 1 - i, 8, false);
    set(8, size - 1 - i, false);
  }
  set(8, size - 8, true); // dark module
  // version info (v7+)
  if (ver >= 7) {
    const v = bch(ver, 0x1f25, 13, 6);
    for (let i = 0; i < 18; i++) {
      const bit = ((v >> i) & 1) === 1;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, bit);
      set(b, a, bit);
    }
  }

  // data placement (zig-zag)
  let bitIdx = 0;
  const totalBits = final.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fn[y * size + x]) continue;
        if (bitIdx < totalBits) mod[y * size + x] = ((final[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1) === 1;
        bitIdx++;
      }
    }
  }

  // masks
  const masks: Array<(x: number, y: number) => boolean> = [
    (x, y) => (x + y) % 2 === 0,
    (_x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  let best: boolean[] | null = null;
  let bestScore = Infinity;
  for (let k = 0; k < 8; k++) {
    const m = mod.slice();
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y * size + x] && masks[k](x, y)) m[y * size + x] = !m[y * size + x];
    const full = placeFormat(m, size, k);
    const sc = penalty(full, size);
    if (sc < bestScore) {
      bestScore = sc;
      best = full;
    }
  }
  return { size, modules: best! };
}

/** Write the 15 format bits in both standard locations. */
function placeFormat(m: boolean[], size: number, maskId: number): boolean[] {
  const fmt = bch((0b00 << 3) | maskId, 0x537, 11, 5) ^ 0x5412; // level M = 00
  const out = m.slice();
  const bit = (i: number) => ((fmt >> i) & 1) === 1;
  // first copy: around the top-left finder
  for (let i = 0; i <= 5; i++) out[i * size + 8] = bit(i); // (x=8, y=0..5)
  out[7 * size + 8] = bit(6);
  out[8 * size + 8] = bit(7);
  out[8 * size + 7] = bit(8);
  for (let i = 9; i < 15; i++) out[8 * size + (14 - i)] = bit(i); // (x=5..0, y=8)
  // second copy: split between top-right and bottom-left
  for (let i = 0; i < 8; i++) out[8 * size + (size - 1 - i)] = bit(i); // (x=size-1..size-8, y=8)
  for (let i = 8; i < 15; i++) out[(size - 15 + i) * size + 8] = bit(i); // (x=8, y=size-7..size-1)
  return out;
}

function penalty(m: boolean[], size: number): number {
  let score = 0;
  const at = (x: number, y: number) => m[y * size + x];
  // rule 1: runs of 5+
  for (let y = 0; y < size; y++) {
    for (const horiz of [true, false]) {
      let run = 1;
      for (let i = 1; i < size; i++) {
        const same = horiz ? at(i, y) === at(i - 1, y) : at(y, i) === at(y, i - 1);
        if (same) run++;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
    }
  }
  // rule 2: 2x2 blocks
  for (let y = 0; y < size - 1; y++)
    for (let x = 0; x < size - 1; x++) {
      const c = at(x, y);
      if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) score += 3;
    }
  // rule 3: finder-like patterns
  const pat = [true, false, true, true, true, false, true, false, false, false, false];
  const patR = pat.slice().reverse();
  for (let y = 0; y < size; y++)
    for (let x = 0; x <= size - 11; x++) {
      let h1 = true, h2 = true, v1 = true, v2 = true;
      for (let k = 0; k < 11; k++) {
        if (at(x + k, y) !== pat[k]) h1 = false;
        if (at(x + k, y) !== patR[k]) h2 = false;
        if (at(y, x + k) !== pat[k]) v1 = false;
        if (at(y, x + k) !== patR[k]) v2 = false;
      }
      score += 40 * (+h1 + +h2 + +v1 + +v2);
    }
  // rule 4: dark balance
  const dark = m.filter(Boolean).length;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/** Render to an SVG path string (1 unit per module, with quiet zone). */
export function qrToSvg(q: QrMatrix, quiet = 4): string {
  const n = q.size + quiet * 2;
  let d = '';
  for (let y = 0; y < q.size; y++)
    for (let x = 0; x < q.size; x++) if (q.modules[y * q.size + x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
