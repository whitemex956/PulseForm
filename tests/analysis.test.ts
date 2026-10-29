/**
 * Acceptance tests for the audio intelligence engine against the synthetic
 * test tracks (regenerate with `python3 tools/synth_test_tracks.py`).
 *
 * Criteria:
 *  - tempo within 1% of ground truth for pulsed tracks
 *  - beat F-measure >= 0.9 at ±70 ms tolerance
 *  - ambient track reports no steady pulse
 *  - every ground-truth drop detected within 1 beat, no false drops
 *  - energy descriptor ordering: ambient < house < energy
 *  - analysis is deterministic (same input -> identical output)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeAudio } from '../src/analysis/analyze';
import type { AnalysisResult } from '../src/analysis/types';
import { readWav } from './wav';
import { fileURLToPath as __f2p } from 'node:url';
import { dirname as __dn } from 'node:path';
const __dirname = __dn(__f2p(import.meta.url));

const dir = join(__dirname, '..', 'test-audio');
const have = existsSync(join(dir, 'ground_truth.json'));
const truth = have ? JSON.parse(readFileSync(join(dir, 'ground_truth.json'), 'utf8')) : {};
const cache: Record<string, AnalysisResult> = {};
const run = (name: string) => {
  if (!cache[name]) {
    const { channels, sampleRate } = readWav(join(dir, `${name}.wav`));
    cache[name] = analyzeAudio(channels, sampleRate);
  }
  return cache[name];
};

function beatF(est: number[], bpm: number, first: number, end: number): number {
  const per = 60 / bpm;
  const ref: number[] = [];
  for (let x = first; x < end; x += per) ref.push(x);
  const hit = (a: number[], b: number[]) => a.filter((x) => b.some((y) => Math.abs(x - y) <= 0.07)).length;
  const P = hit(est, ref) / Math.max(1, est.length);
  const R = hit(ref, est) / ref.length;
  return (2 * P * R) / (P + R || 1);
}

const skip = !have && 'test audio missing — run tools/synth_test_tracks.py';

for (const name of ['house', 'energy']) {
  test(`${name}: tempo within 1%`, { skip }, () => {
    const r = run(name);
    assert.ok(r.beatGrid.hasPulse);
    const err = Math.abs((r.beatGrid.bpm ?? 0) - truth[name].bpm) / truth[name].bpm;
    assert.ok(err < 0.01, `bpm ${r.beatGrid.bpm} vs ${truth[name].bpm}`);
  });
  test(`${name}: beat F-measure >= 0.9`, { skip }, () => {
    const r = run(name);
    const gt = truth[name];
    const f = beatF(r.beatGrid.beats, gt.bpm, gt.first_beat, gt.sections[gt.sections.length - 1].end);
    assert.ok(f >= 0.9, `F=${f.toFixed(3)}`);
  });
  test(`${name}: drops detected within one beat, no false drops`, { skip }, () => {
    const r = run(name);
    const gt = truth[name];
    const tol = 60 / gt.bpm;
    for (const d of gt.drops) assert.ok(r.drops.some((x) => Math.abs(x - d) <= tol), `missed drop ${d}; got ${r.drops}`);
    assert.equal(r.drops.length, gt.drops.length, `drops ${r.drops}`);
  });
  test(`${name}: downbeats land on bar starts`, { skip }, () => {
    const r = run(name);
    const bar = (60 / truth[name].bpm) * 4;
    const off = r.beatGrid.downbeats.map((i) => {
      const t = r.beatGrid.beats[i];
      return Math.abs(t - Math.round(t / bar) * bar);
    });
    const ok = off.filter((o) => o < 0.07).length / off.length;
    assert.ok(ok > 0.9, `downbeat alignment ${ok}`);
  });
}

test('ambient: no steady pulse, no drops', { skip }, () => {
  const r = run('ambient');
  assert.equal(r.beatGrid.hasPulse, false);
  assert.equal(r.beatGrid.bpm, null);
  assert.equal(r.drops.length, 0);
});

test('energy descriptor orders tracks ambient < house < energy', { skip }, () => {
  const e = (n: string) => run(n).descriptors.find((d) => d.key === 'energy')!.value;
  assert.ok(e('ambient') < e('house') && e('house') < e('energy'), `${e('ambient')} ${e('house')} ${e('energy')}`);
});

test('every descriptor declares provenance', { skip }, () => {
  for (const n of ['ambient', 'house', 'energy']) {
    for (const d of run(n).descriptors) assert.ok(d.provenance === 'measured' || d.provenance === 'estimated');
  }
});

test('analysis is deterministic', { skip }, () => {
  const { channels, sampleRate } = readWav(join(dir, 'house.wav'));
  const a = analyzeAudio(channels, sampleRate);
  const b = run('house');
  assert.equal(a.fingerprint, b.fingerprint);
  assert.deepEqual(a.beatGrid.beats, b.beatGrid.beats);
  assert.deepEqual(a.sections, b.sections);
});
