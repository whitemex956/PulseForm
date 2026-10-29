import type { Palette } from '../director/director';

export interface Prefs {
  intensity: number;
  reducedMotion: boolean;
  photosensitive: boolean;
  diagnostics: boolean;
  quality: 'auto' | 0 | 1 | 2 | 3;
}

export interface SavedWorld {
  id: string;
  name: string;
  seed: number;
  palette: Palette;
  camera: number;
  intensity: number;
  savedAt: number;
}

const KEY = 'pulseform.prefs.v1';
const WORLDS = 'pulseform.worlds.v1';

export function loadPrefs(): Prefs {
  const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const def: Prefs = { intensity: 1, reducedMotion: reduce, photosensitive: false, diagnostics: false, quality: 'auto' };
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return v ? { ...def, ...v } : def;
  } catch {
    return def;
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: preferences last for this session only */
  }
}

export function loadWorlds(): SavedWorld[] {
  try {
    return JSON.parse(localStorage.getItem(WORLDS) ?? '[]');
  } catch {
    return [];
  }
}

export function saveWorlds(w: SavedWorld[]): void {
  try {
    localStorage.setItem(WORLDS, JSON.stringify(w));
  } catch {
    /* ignore */
  }
}
