/**
 * Render lab (test-only): loads a test track, analyzes it, and exposes
 * window.lab.renderAt(t, opts) so automated tests can render exact frames.
 */
import { analyzeAudio } from '../analysis/analyze';
import { Timeline } from '../timeline/timeline';
import { Engine } from '../render/engine';
import { LiquidForm } from '../render/worlds/liquid';
import { hexToRgb } from '../render/gl';
import { proposeDirections, SIGNATURE } from '../director/director';
import type { WorldParams } from '../render/world';

declare global {
  interface Window { lab: any }
}

function paletteArray(colors: readonly string[]): Float32Array {
  const a = new Float32Array(15);
  colors.slice(0, 5).forEach((c, i) => a.set(hexToRgb(c), i * 3));
  return a;
}

async function load(name: string) {
  const res = await fetch(`test-audio/${name}.wav`);
  const ctx = new OfflineAudioContext(2, 44100, 44100);
  const buf = await ctx.decodeAudioData(await res.arrayBuffer());
  const ch = [buf.getChannelData(0), buf.getChannelData(Math.min(1, buf.numberOfChannels - 1))];
  const analysis = analyzeAudio(ch, buf.sampleRate);
  return { analysis, timeline: new Timeline(analysis) };
}

const canvas = document.getElementById('c') as HTMLCanvasElement;
const engine = new Engine(canvas);
engine.register(new LiquidForm());
const tracks: Record<string, Awaited<ReturnType<typeof load>>> = {};

window.lab = {
  engine,
  async load(name: string) {
    tracks[name] = tracks[name] ?? (await load(name));
    return { duration: tracks[name].analysis.duration, drops: tracks[name].analysis.drops, directions: proposeDirections(tracks[name].analysis).map((d) => ({ family: d.family, palette: d.palette.colors })) };
  },
  renderAt(name: string, t: number, o: Partial<WorldParams> & { colors?: string[]; noFlash?: boolean } = {}) {
    const tr = tracks[name];
    const s = tr.timeline.stateAt(t);
    const p: WorldParams = {
      seed: o.seed ?? 0x5eed1234,
      palette: paletteArray(o.colors ?? SIGNATURE.colors),
      complexity: o.complexity ?? 0.7,
      intensity: o.intensity ?? 1,
      motionScale: o.motionScale ?? 1,
      shapeA: o.shapeA ?? 1,
      shapeB: o.shapeB ?? 1,
      morph: o.morph ?? 0,
      camera: o.camera ?? 0,
    };
    if (o.noFlash) s.flash = 0;
    engine.render('liquid', s, p, performance.now());
    return { low: s.low, mid: s.mid, high: s.high, kick: s.kick, intensity: s.intensity, section: s.section, stats: { ...engine.stats } };
  },
};
document.title = 'lab-ready';
