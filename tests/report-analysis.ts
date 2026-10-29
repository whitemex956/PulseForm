/** Prints analysis results for the synthetic test tracks next to ground truth. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeAudio } from '../src/analysis/analyze';
import { readWav } from './wav';

const dir = join(__dirname, '..', 'test-audio');
const truth = JSON.parse(readFileSync(join(dir, 'ground_truth.json'), 'utf8'));
const which = process.argv.slice(2);
for (const name of which.length ? which : Object.keys(truth)) {
  const { channels, sampleRate } = readWav(join(dir, `${name}.wav`));
  const t = performance.now();
  const r = analyzeAudio(channels, sampleRate);
  const gt = truth[name];
  console.log(`\n=== ${name} (${((performance.now() - t) / 1000).toFixed(2)}s analysis) ===`);
  console.log(`tempo: est ${r.beatGrid.bpm} (pulse=${r.beatGrid.hasPulse}, conf=${r.beatGrid.confidence.toFixed(2)}) | truth ${gt.bpm}`);
  console.log(`beats: ${r.beatGrid.beats.length}, first ${r.beatGrid.beats.slice(0, 4).map((x) => x.toFixed(3)).join(', ')}`);
  if (gt.bpm) {
    const per = 60 / gt.bpm;
    const end = gt.sections[gt.sections.length - 1].end;
    const ref: number[] = [];
    for (let x = gt.first_beat; x < end; x += per) ref.push(x);
    const est = r.beatGrid.beats;
    const hit = (a: number[], b: number[]) => a.filter((x) => b.some((y) => Math.abs(x - y) <= 0.07)).length;
    const P = hit(est, ref) / Math.max(1, est.length), R = hit(ref, est) / ref.length;
    const offs = est.map((x) => ((x - gt.first_beat + per / 2) % per) - per / 2);
    console.log(`beat F=${((2 * P * R) / (P + R || 1)).toFixed(3)} P=${P.toFixed(3)} R=${R.toFixed(3)} median phase err=${(offs.sort((a, b) => a - b)[offs.length >> 1] * 1000).toFixed(1)}ms`);
  }
  console.log(`downbeat beat idx: ${r.beatGrid.downbeats.slice(0, 4).join(', ')}`);
  console.log(`transients: ${r.transients.length}`);
  console.log('sections est:', r.sections.map((s) => `${s.kind}@${s.start.toFixed(1)}-${s.end.toFixed(1)} e=${s.energy.toFixed(2)} sl=${s.slope.toFixed(4)}`).join(' | '));
  console.log('sections gt :', gt.sections.map((s: any) => `${s.label}@${s.start.toFixed(1)}`).join(' | '));
  console.log(`drops est ${r.drops.map((d) => d.toFixed(2)).join(', ')} | gt ${gt.drops.map((d: number) => d.toFixed(2)).join(', ')}`);
  console.log(`builds est ${r.builds.map(([a, b]) => `${a.toFixed(1)}-${b.toFixed(1)}`).join(', ')}`);
  console.log('descriptors:', r.descriptors.map((d) => `${d.label}=${d.text}(${d.value.toFixed(2)})`).join('; '));
  console.log('timings', r.timings);
}
