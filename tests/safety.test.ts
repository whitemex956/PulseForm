/**
 * Flash safety: whatever the music asks for, the guard admits at most 3 flash
 * onsets in any 1-second window (WCAG 2.3.1 general flash threshold), and
 * photosensitive mode admits none.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FlashGuard } from '../src/render/engine';

function drive(guard: FlashGuard, hz: number, seconds: number, photo = false, fps = 60) {
  const onsets: number[] = [];
  let prev = 0;
  for (let f = 0; f < seconds * fps; f++) {
    const t = f / fps;
    // square-wave request at `hz`: on for 40% of each period
    const want = (t * hz) % 1 < 0.4 ? 1 : 0;
    const out = guard.apply(want, t, photo);
    if (out > 0.05 && prev <= 0.05) onsets.push(t);
    prev = out;
  }
  return onsets;
}

test('a 10 Hz strobe request yields at most 3 flashes per second', () => {
  const on = drive(new FlashGuard(), 10, 10);
  for (let i = 0; i < on.length; i++) {
    const inWindow = on.filter((t) => t >= on[i] && t < on[i] + 1).length;
    assert.ok(inWindow <= 3, `window at ${on[i].toFixed(2)}s has ${inWindow}`);
  }
  assert.ok(on.length > 0, 'some flashes should still be admitted');
});

test('flash brightness is capped', () => {
  const g = new FlashGuard();
  let max = 0;
  for (let f = 0; f < 120; f++) max = Math.max(max, g.apply(1, f / 60, false));
  assert.ok(max <= 0.35);
});

test('photosensitive mode admits no flashes', () => {
  const on = drive(new FlashGuard(), 2, 10, true);
  assert.equal(on.length, 0);
});
