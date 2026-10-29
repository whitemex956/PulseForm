import type { VisualState } from '../timeline/timeline';
import type { SectionKind } from '../analysis/types';

/**
 * Wire protocol between paired devices. Only derived analysis numbers, scene
 * parameters and control commands travel — never audio.
 *
 * State frames are a fixed binary layout (~100 bytes) sent ~30 times a second
 * on an unordered, no-retransmit data channel: a late frame is useless, so it is
 * dropped rather than delaying newer ones.
 */

export const STATE_FIELDS = [
  'hostTime', 'low', 'mid', 'high', 'energy', 'kick', 'snare', 'hat', 'transient', 'intensity', 'flash',
  'beatPhase', 'beatPulse', 'downbeatPulse', 'beatTime', 'motion', 'dropImpact', 'build', 'bpm', 'hasPulse',
  'section', 'shapeA', 'shapeB', 'morph', 'progress', 'seq',
] as const;
const IDX = Object.fromEntries(STATE_FIELDS.map((k, i) => [k, i])) as Record<(typeof STATE_FIELDS)[number], number>;
export const STATE_LEN = STATE_FIELDS.length;
const MAGIC = 0x50460001; // "PF" v1

const SECTIONS: SectionKind[] = ['intro', 'verse', 'build', 'drop', 'breakdown', 'peak', 'outro', 'ambient'];

export interface WireFrame {
  hostTime: number;
  seq: number;
  state: VisualState;
  shapeA: number;
  shapeB: number;
  morph: number;
}

export function encodeState(s: VisualState, hostTime: number, shapes: { shapeA: number; shapeB: number; morph: number }, seq: number): ArrayBuffer {
  const buf = new ArrayBuffer(4 + STATE_LEN * 8);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC);
  const put = (k: (typeof STATE_FIELDS)[number], v: number) => dv.setFloat64(4 + IDX[k] * 8, v);
  put('hostTime', hostTime);
  put('low', s.low);
  put('mid', s.mid);
  put('high', s.high);
  put('energy', s.energy);
  put('kick', s.kick);
  put('snare', s.snare);
  put('hat', s.hat);
  put('transient', s.transient);
  put('intensity', s.intensity);
  put('flash', s.flash);
  put('beatPhase', s.beatPhase);
  put('beatPulse', s.beatPulse);
  put('downbeatPulse', s.downbeatPulse);
  put('beatTime', s.beatTime);
  put('motion', s.motion);
  put('dropImpact', s.dropImpact);
  put('build', s.build);
  put('bpm', s.bpm);
  put('hasPulse', s.hasPulse ? 1 : 0);
  put('section', Math.max(0, SECTIONS.indexOf(s.section)));
  put('shapeA', shapes.shapeA);
  put('shapeB', shapes.shapeB);
  put('morph', shapes.morph);
  put('progress', s.progress);
  put('seq', seq);
  return buf;
}

export function decodeState(buf: ArrayBuffer, into: VisualState): WireFrame | null {
  if (buf.byteLength !== 4 + STATE_LEN * 8) return null;
  const dv = new DataView(buf);
  if (dv.getUint32(0) !== MAGIC) return null;
  const g = (k: (typeof STATE_FIELDS)[number]) => dv.getFloat64(4 + IDX[k] * 8);
  into.low = g('low');
  into.mid = g('mid');
  into.high = g('high');
  into.energy = g('energy');
  into.kick = g('kick');
  into.snare = g('snare');
  into.hat = g('hat');
  into.transient = g('transient');
  into.intensity = g('intensity');
  into.flash = g('flash');
  into.beatPhase = g('beatPhase');
  into.beatPulse = g('beatPulse');
  into.downbeatPulse = g('downbeatPulse');
  into.beatTime = g('beatTime');
  into.motion = g('motion');
  into.dropImpact = g('dropImpact');
  into.build = g('build');
  into.bpm = g('bpm');
  into.hasPulse = g('hasPulse') > 0.5;
  into.section = SECTIONS[Math.round(g('section'))] ?? 'verse';
  into.progress = g('progress');
  return { hostTime: g('hostTime'), seq: g('seq'), state: into, shapeA: g('shapeA'), shapeB: g('shapeB'), morph: g('morph') };
}

/** Linear blend of two decoded states (for jitter-buffered playout). */
export function lerpState(a: VisualState, b: VisualState, k: number, out: VisualState): VisualState {
  const L = (x: number, y: number) => x + (y - x) * k;
  out.low = L(a.low, b.low);
  out.mid = L(a.mid, b.mid);
  out.high = L(a.high, b.high);
  out.energy = L(a.energy, b.energy);
  out.kick = L(a.kick, b.kick);
  out.snare = L(a.snare, b.snare);
  out.hat = L(a.hat, b.hat);
  out.transient = L(a.transient, b.transient);
  out.intensity = L(a.intensity, b.intensity);
  out.flash = L(a.flash, b.flash);
  out.beatPulse = L(a.beatPulse, b.beatPulse);
  out.downbeatPulse = L(a.downbeatPulse, b.downbeatPulse);
  out.beatTime = L(a.beatTime, b.beatTime);
  out.beatPhase = out.beatTime - Math.floor(out.beatTime);
  out.motion = L(a.motion, b.motion);
  out.dropImpact = L(a.dropImpact, b.dropImpact);
  out.build = L(a.build, b.build);
  out.bpm = b.bpm;
  out.hasPulse = b.hasPulse;
  out.section = b.section;
  out.progress = L(a.progress, b.progress);
  return out;
}

// ---------- control messages (reliable channel) ----------

export type Command =
  | { cmd: 'listen' }
  | { cmd: 'stop' }
  | { cmd: 'play' }
  | { cmd: 'pause' }
  | { cmd: 'seek'; value: number }
  | { cmd: 'intensity'; value: number }
  | { cmd: 'palette'; value: number }
  | { cmd: 'surprise' }
  | { cmd: 'reducedMotion'; value: boolean }
  | { cmd: 'photosensitive'; value: boolean };

export interface SceneParams {
  world: string;
  seed: number;
  colors: string[];
  paletteName: string;
  camera: number;
  complexity: number;
  intensity: number;
  reducedMotion: boolean;
  photosensitive: boolean;
}

export interface HostStatus {
  source: string;
  tone: 'live' | 'idle' | 'warn' | 'error';
  canPlay: boolean;
  playing: boolean;
  listening: boolean;
  duration: number | null;
  position: number | null;
  trackName: string | null;
}

export type ControlMsg =
  | { type: 'hello'; role: string; device: string; app: string }
  | { type: 'ping'; id: number; t0: number }
  | { type: 'pong'; id: number; t0: number; t1: number }
  | { type: 'cmd'; id: number; body: Command }
  | { type: 'ack'; id: number; ok: boolean; error?: string }
  | { type: 'scene'; scene: SceneParams }
  | { type: 'status'; status: HostStatus }
  | { type: 'frame-b64'; data: string }; // relay fallback for state frames

export function bufToB64(b: ArrayBuffer): string {
  let s = '';
  const u = new Uint8Array(b);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
export function b64ToBuf(s: string): ArrayBuffer {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
