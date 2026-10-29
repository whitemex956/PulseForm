/** QR encoder round-trip: encode, rasterize, decode with OpenCV (python3 + cv2). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeQR } from '../src/core/qr';

function hasCv2(): boolean {
  try {
    execFileSync('python3', ['-c', 'import cv2']);
    return true;
  } catch {
    return false;
  }
}

function decode(text: string): string {
  const q = encodeQR(text);
  const scale = 8, quiet = 4;
  const n = (q.size + quiet * 2) * scale;
  const px = Buffer.alloc(n * n, 255);
  for (let y = 0; y < q.size; y++)
    for (let x = 0; x < q.size; x++)
      if (q.modules[y * q.size + x])
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) px[((y + quiet) * scale + dy) * n + (x + quiet) * scale + dx] = 0;
  const dir = mkdtempSync(join(tmpdir(), 'qr-'));
  const f = join(dir, 'q.pgm');
  writeFileSync(f, Buffer.concat([Buffer.from(`P5 ${n} ${n} 255\n`), px]));
  return execFileSync('python3', ['-c', `import cv2,sys\nimg=cv2.imread(sys.argv[1],0)\nd=cv2.QRCodeDetector()\nv,_,_=d.detectAndDecode(img)\nprint(v,end='')`, f]).toString();
}

const cases = [
  'http://192.168.1.20:5173/?join=482913',
  'https://pulseform.local/pair?c=ABCDEF&s=0123456789abcdef0123456789abcdef',
  'x',
  'A'.repeat(120), // forces a multi-block version (v8+)
  'https://example.com/' + 'p'.repeat(180),
];
for (const c of cases) {
  test(`QR round-trip: ${c.slice(0, 40)}${c.length > 40 ? '…' : ''} (${c.length} bytes)`, { skip: !hasCv2() && 'python3 cv2 not available' }, () => {
    assert.equal(decode(c), c);
  });
}
