/**
 * 2D canvas drawing for the bottom band. Kept free of React so the render loop
 * can call it every frame without re-rendering components.
 *
 * Waveform = time-domain samples (min/max per block). Spectrum = magnitudes per
 * log-spaced frequency band. They are drawn differently on purpose.
 */
import type { LiveAnalyzer } from '../live/liveAnalyzer';

export interface FilePeaks {
  min: Float32Array;
  max: Float32Array;
  rms: Float32Array;
}

function gradient(g: CanvasRenderingContext2D, w: number, alpha = 1): CanvasGradient {
  const gr = g.createLinearGradient(0, 0, w, 0);
  gr.addColorStop(0, `rgba(47,107,255,${alpha})`);
  gr.addColorStop(0.45, `rgba(138,61,255,${alpha})`);
  gr.addColorStop(0.8, `rgba(255,61,214,${alpha})`);
  gr.addColorStop(1, `rgba(255,138,61,${alpha})`);
  return gr;
}

export function fitCanvas(c: HTMLCanvasElement): { w: number; h: number; dpr: number } {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return { w, h, dpr };
}

/** Scrolling recent-audio waveform from the live analyzer's min/max ring. */
export function drawLiveWave(c: HTMLCanvasElement, a: LiveAnalyzer, silent: boolean): void {
  const g = c.getContext('2d')!;
  const { w, h, dpr } = fitCanvas(c);
  g.clearRect(0, 0, w, h);
  const ring = a.waveMin.length;
  const mid = h / 2;
  const amp = h * 0.46;
  const cols = Math.floor(w / (2 * dpr));
  const per = ring / cols;
  const top: number[] = [];
  const bot: number[] = [];
  for (let x = 0; x < cols; x++) {
    let lo = 0, hi = 0;
    const s0 = Math.floor(x * per), s1 = Math.max(s0 + 1, Math.floor((x + 1) * per));
    for (let s = s0; s < s1; s++) {
      const i = (a.waveWrite + s) % ring; // oldest → newest, left → right
      if (a.waveMin[i] < lo) lo = a.waveMin[i];
      if (a.waveMax[i] > hi) hi = a.waveMax[i];
    }
    top.push(mid - Math.min(1, hi) * amp);
    bot.push(mid - Math.max(-1, lo) * amp);
  }
  const step = w / cols;
  // fill
  g.beginPath();
  g.moveTo(0, top[0]);
  for (let x = 1; x < cols; x++) g.lineTo(x * step, top[x]);
  for (let x = cols - 1; x >= 0; x--) g.lineTo(x * step, bot[x]);
  g.closePath();
  g.fillStyle = gradient(g, w, silent ? 0.25 : 0.55);
  g.fill();
  // glow outline (two passes: wide soft, then crisp)
  for (const [lw, al] of [[6 * dpr, 0.18], [1.4 * dpr, 0.95]] as const) {
    g.lineWidth = lw;
    g.strokeStyle = gradient(g, w, al);
    g.beginPath();
    g.moveTo(0, top[0]);
    for (let x = 1; x < cols; x++) g.lineTo(x * step, top[x]);
    g.stroke();
    g.beginPath();
    g.moveTo(0, bot[0]);
    for (let x = 1; x < cols; x++) g.lineTo(x * step, bot[x]);
    g.stroke();
  }
  // fade the oldest audio at the left edge
  const fade = g.createLinearGradient(0, 0, w * 0.12, 0);
  fade.addColorStop(0, 'rgba(0,0,0,1)');
  fade.addColorStop(1, 'rgba(0,0,0,0)');
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = fade;
  g.fillRect(0, 0, w * 0.12, h);
  g.globalCompositeOperation = 'source-over';
}

/** Spectrum bars: one bar per log-spaced band, with falling peak caps. */
export function drawSpectrum(c: HTMLCanvasElement, a: LiveAnalyzer): void {
  const g = c.getContext('2d')!;
  const { w, h, dpr } = fitCanvas(c);
  g.clearRect(0, 0, w, h);
  const n = a.spectrum.length;
  const gap = 3 * dpr;
  const bw = (w - gap * (n - 1)) / n;
  const grad = gradient(g, w, 0.95);
  for (let i = 0; i < n; i++) {
    const v = a.spectrum[i];
    const bh = Math.max(2 * dpr, v * h * 0.92);
    const x = i * (bw + gap);
    g.fillStyle = grad;
    g.globalAlpha = 0.35 + 0.65 * v;
    roundRect(g, x, h - bh, bw, bh, Math.min(bw / 2, 4 * dpr));
    g.globalAlpha = 0.9;
    const py = h - a.spectrumPeak[i] * h * 0.92 - 3 * dpr;
    g.fillRect(x, py, bw, 2 * dpr);
  }
  g.globalAlpha = 1;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.lineTo(x + w, y + h);
  g.lineTo(x, y + h);
  g.arcTo(x, y, x + r, y, r);
  g.closePath();
  g.fill();
}

export interface FileMarks {
  drops: number[];
  sections: Array<{ start: number; kind: string }>;
}

/** Full-track waveform with real playback progress, section and drop marks. */
export function drawFileWave(
  c: HTMLCanvasElement,
  peaks: FilePeaks,
  duration: number,
  t: number,
  marks: FileMarks,
  hoverT: number | null,
): void {
  const g = c.getContext('2d')!;
  const { w, h, dpr } = fitCanvas(c);
  g.clearRect(0, 0, w, h);
  const n = peaks.max.length;
  const mid = h / 2;
  const amp = h * 0.44;
  const barW = 2 * dpr;
  const gap = 1 * dpr;
  const cols = Math.floor(w / (barW + gap));
  const px = (t / duration) * w;
  const played = gradient(g, w, 1);
  for (let x = 0; x < cols; x++) {
    const b0 = Math.floor((x / cols) * n), b1 = Math.max(b0 + 1, Math.floor(((x + 1) / cols) * n));
    let hi = 0, lo = 0;
    for (let b = b0; b < b1; b++) {
      hi = Math.max(hi, peaks.max[b]);
      lo = Math.min(lo, peaks.min[b]);
    }
    const xx = x * (barW + gap);
    const y0 = mid - hi * amp, y1 = mid - lo * amp;
    g.fillStyle = xx <= px ? played : 'rgba(255,255,255,0.22)';
    g.fillRect(xx, y0, barW, Math.max(1, y1 - y0));
  }
  // section boundaries (estimated) as faint ticks; drops as small bright marks
  g.fillStyle = 'rgba(255,255,255,0.18)';
  for (const s of marks.sections.slice(1)) g.fillRect((s.start / duration) * w, h * 0.12, 1 * dpr, h * 0.76);
  for (const d of marks.drops) {
    const x = (d / duration) * w;
    g.fillStyle = 'rgba(255,138,61,0.95)';
    g.beginPath();
    g.arc(x, h * 0.08, 3 * dpr, 0, Math.PI * 2);
    g.fill();
  }
  // playhead
  g.fillStyle = '#fff';
  g.fillRect(px - dpr, 0, 2 * dpr, h);
  if (hoverT !== null) {
    g.fillStyle = 'rgba(255,255,255,0.4)';
    g.fillRect((hoverT / duration) * w, 0, dpr, h);
  }
}
