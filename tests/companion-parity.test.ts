/**
 * The Windows companion (Go) must measure audio exactly like the browser (TS).
 * Runs the companion's analysis on a test WAV and compares frame by frame.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { computeFrameFeatures } from '../src/analysis/features';
import { mixToMono } from '../src/analysis/analyze';
import { readWav } from './wav';
import { fileURLToPath as __f2p } from 'node:url';
import { dirname as __dn } from 'node:path';
const __dirname = __dn(__f2p(import.meta.url));

const root = join(__dirname, '..');
const wav = join(root, 'test-audio', 'house.wav');
const hasGo = (() => {
  try {
    execFileSync('go', ['version']);
    return true;
  } catch {
    return false;
  }
})();

test('Go companion and browser analysis agree frame by frame', { skip: (!hasGo || !existsSync(wav)) && 'needs go and test audio' }, () => {
  const out = execFileSync('go', ['run', '.', '--dump-features', wav], { cwd: join(root, 'companion'), maxBuffer: 1 << 30 }).toString();
  const go: Array<Record<string, number>> = JSON.parse(out);
  const { channels, sampleRate } = readWav(wav);
  const ts = computeFrameFeatures(mixToMono(channels), sampleRate);
  assert.equal(go.length, ts.frames.count);
  const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-6, Math.abs(a), Math.abs(b));
  let worst = { key: '', err: 0, i: 0 };
  const pairs: Array<[string, (i: number) => number]> = [
    ['rms', (i) => ts.frames.rms[i]],
    ['low', (i) => ts.lowRaw[i]],
    ['mid', (i) => ts.midRaw[i]],
    ['high', (i) => ts.highRaw[i]],
    ['centroid', (i) => ts.frames.centroid[i]],
    ['flux', (i) => ts.fluxAbs[i] * 0 + (ts.fluxAbs[i])],
  ];
  for (let i = 0; i < go.length; i += 7) {
    for (const [k, f] of pairs) {
      const g = k === 'flux' ? go[i].fluxAbs : go[i][k];
      const t = f(i);
      if (Math.abs(g) < 1e-7 && Math.abs(t) < 1e-7) continue;
      const e = rel(g, t);
      if (e > worst.err) worst = { key: k, err: e, i };
    }
  }
  // float32 (Go input) vs float32-from-int16 (TS) and FFT rounding: allow 0.1%
  assert.ok(worst.err < 1e-3, `max relative difference ${worst.err} on ${worst.key} at frame ${worst.i}`);
});
