import type { AnalysisResult } from '../analysis/types';
import { Rng, mixSeed, hashString } from '../core/random';

/**
 * The Visual Director: rules over measured audio features choose a coherent
 * creative direction. No model call is involved. Every choice traces back to a
 * measurement, so it is explainable and reproducible.
 */

export type SceneFamily = 'electric' | 'laser' | 'cosmic' | 'liquid' | 'festival';

export const FAMILY_INFO: Record<SceneFamily, { name: string; tagline: string }> = {
  electric: { name: 'Electric Energy', tagline: 'Lightning filaments, plasma core, bass-driven surges' },
  laser: { name: 'Laser Dimension', tagline: 'Beam corridors and geometric light architecture' },
  cosmic: { name: 'Cosmic Universe', tagline: 'Nebula clouds and slow celestial motion' },
  liquid: { name: 'Liquid Morph', tagline: 'Chrome fluid sculpture that breathes with the groove' },
  festival: { name: 'Festival Overdrive', tagline: 'Layered stage geometry, drops that detonate' },
};

export type CameraStyle = 'orbit' | 'dolly' | 'handheld' | 'flythrough' | 'locked';

export interface Palette {
  name: string;
  /** hex colors, ordered: deep, primary, secondary, accent, hot */
  colors: [string, string, string, string, string];
  background: string;
}

export interface ArtDirection {
  id: string;
  family: SceneFamily;
  seed: number;
  palette: Palette;
  camera: CameraStyle;
  /** 0..1 how many layers/objects */
  complexity: number;
  /** 0..2 multiplier on audio coupling */
  reactivity: number;
  /** 0..1.3 multiplier on the intensity curve */
  intensity: number;
  /** human-readable reasons, each tied to a measurement */
  rationale: string[];
  /** a short title for the proposal card */
  title: string;
}

/** The PulseForm signature gradient from the brand mark. */
export const SIGNATURE: Palette = {
  name: 'PulseForm',
  colors: ['#0b1a4a', '#2f6bff', '#8a3dff', '#ff3dd6', '#ff8a3d'],
  background: '#030308',
};

/** Palettes offered on the phone remote (index is sent over the session). */
export const REMOTE_PALETTES: Palette[] = [
  SIGNATURE,
  { name: 'Glacier', colors: ['#03141f', '#00c2ff', '#3d7bff', '#9b5cff', '#ffffff'], background: '#000' },
  { name: 'Ember', colors: ['#1a0505', '#ff3d6e', '#ff8a3d', '#ffd23d', '#ffffff'], background: '#000' },
  { name: 'Aurora', colors: ['#05140d', '#2dffb3', '#00b7ff', '#7a5cff', '#ff5cf4'], background: '#000' },
];

function hsl(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

const PALETTE_NAMES = ['Ion', 'Aurora', 'Ember', 'Abyss', 'Solar', 'Neon Tide', 'Ultraviolet', 'Glacier', 'Inferno', 'Prism'];

/** Seeded palette shaped by brightness (hue range) and energy (saturation, temperature). */
export function makePalette(rng: Rng, brightness: number, energy: number, family: SceneFamily): Palette {
  if (rng.chance(0.22)) return SIGNATURE;
  const baseHue =
    family === 'cosmic' ? rng.range(200, 300)
    : family === 'electric' ? rng.range(185, 250)
    : family === 'laser' ? rng.pick([0, 120, 280, 320, 180]) + rng.range(-15, 15)
    : family === 'liquid' ? rng.range(0, 360)
    : rng.range(0, 360);
  const spread = 35 + 70 * energy + rng.range(-10, 20);
  const sat = 0.75 + 0.2 * energy;
  const hot = baseHue + (brightness > 0.6 ? 150 : 110) + rng.range(-20, 20);
  return {
    name: rng.pick(PALETTE_NAMES),
    colors: [
      hsl(baseHue - 10, 0.8, 0.12),
      hsl(baseHue, sat, 0.55),
      hsl(baseHue + spread, sat, 0.58),
      hsl(baseHue + spread * 2, sat, 0.62),
      hsl(hot, 1, 0.6),
    ],
    background: hsl(baseHue, 0.5, 0.025),
  };
}

function d(a: AnalysisResult, key: string): number {
  return a.descriptors.find((x) => x.key === key)?.value ?? 0;
}

/** Suitability of each family for this song, from measured features. */
export function scoreFamilies(a: AnalysisResult): Record<SceneFamily, { score: number; why: string }> {
  const energy = d(a, 'energy');
  const bass = d(a, 'bass');
  const bright = d(a, 'brightness');
  const density = d(a, 'density');
  const pulse = a.beatGrid.hasPulse ? 1 : 0;
  const drops = a.drops.length;
  const smooth = 1 - d(a, 'texture');
  const bpm = a.beatGrid.bpm ?? 0;
  return {
    electric: {
      score: 0.4 + 0.35 * bass + 0.25 * energy + 0.1 * Math.min(drops, 2),
      why: `bass weight ${Math.round(bass * 100)}% drives plasma surges`,
    },
    laser: {
      score: 0.2 + 0.45 * pulse * density + 0.25 * (bpm >= 118 && bpm <= 140 ? 1 : 0.4) * pulse + 0.15 * bright,
      why: pulse ? `${bpm} BPM steady grid suits synchronized beams` : 'no steady grid, beams would feel random',
    },
    cosmic: {
      score: 0.25 + 0.6 * (1 - energy) + 0.2 * (1 - pulse) + 0.1 * (1 - bright),
      why: energy < 0.4 ? 'low, spacious energy suits slow celestial motion' : 'works as a contrast choice',
    },
    liquid: {
      score: 0.3 + 0.35 * smooth + 0.3 * (energy > 0.3 && energy < 0.7 ? 1 : 0.3) + 0.1 * pulse,
      why: `tonal texture and mid energy suit fluid motion`,
    },
    festival: {
      score: 0.1 + 0.55 * energy + 0.25 * Math.min(drops, 2) / 2 + 0.15 * density * pulse,
      why: drops ? `${drops} detected drop${drops > 1 ? 's' : ''} to detonate` : 'high energy throughout',
    },
  };
}

function cameraFor(rng: Rng, family: SceneFamily, energy: number): CameraStyle {
  const options: Record<SceneFamily, CameraStyle[]> = {
    electric: ['orbit', 'dolly', 'handheld'],
    laser: ['flythrough', 'dolly', 'locked'],
    cosmic: ['orbit', 'flythrough', 'dolly'],
    liquid: ['orbit', 'locked', 'dolly'],
    festival: ['handheld', 'orbit', 'flythrough'],
  };
  const o = options[family];
  return energy > 0.7 && rng.chance(0.5) ? o[o.length - 1] : rng.pick(o);
}

/**
 * Three proposals per song: the best-scoring family, then two contrasting
 * options. Seeds derive from the audio fingerprint and a variation counter,
 * so "fresh variation" changes everything except the musical reasoning.
 */
export function proposeDirections(a: AnalysisResult, variation = 0): ArtDirection[] {
  const scores = scoreFamilies(a);
  const ranked = (Object.keys(scores) as SceneFamily[]).sort((x, y) => scores[y].score - scores[x].score);
  const base = mixSeed(hashString(a.fingerprint), variation);
  const rng = new Rng(base);
  // top pick + next two, but nudge in variation so fresh variations also explore families
  const order = variation ? [ranked[0], ...rng.fork('order').shuffle(ranked.slice(1)).slice(0, 2)] : ranked.slice(0, 3);
  const energy = d(a, 'energy');
  const bright = d(a, 'brightness');
  return order.map((family, i) => {
    const r = rng.fork(`p${i}`);
    const seed = mixSeed(base, family, i);
    const palette = makePalette(r, bright, energy, family);
    const complexity = Math.min(1, 0.45 + 0.4 * energy + r.range(-0.1, 0.15));
    const reactivity = 0.85 + 0.4 * d(a, 'contrast') + r.range(-0.1, 0.1);
    const camera = cameraFor(r, family, energy);
    const rationale = [
      scores[family].why,
      a.beatGrid.hasPulse ? `motion locked to the ${a.beatGrid.bpm} BPM grid (estimated)` : 'free-flowing motion: no steady pulse detected',
      a.drops.length
        ? `${a.drops.length} drop${a.drops.length > 1 ? 's' : ''} at ${a.drops.map((x) => fmtTime(x)).join(', ')} get full impact; everything else is held back`
        : 'no drops detected, so intensity follows the loudness envelope',
      `${palette.name} palette in ${bright > 0.55 ? 'bright' : 'deep'} tones, from the measured spectral centroid`,
    ];
    return {
      id: `${family}-${seed.toString(36)}`,
      family,
      seed,
      palette,
      camera,
      complexity,
      reactivity,
      intensity: 1,
      rationale,
      title: `${FAMILY_INFO[family].name}`,
    };
  });
}

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, '0')}`;
}

