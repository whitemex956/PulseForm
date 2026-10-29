import { estimateTempo } from '../analysis/tempo';
import { HOP_SIZE } from '../analysis/frameExtractor';
import type { LiveFrameMsg } from '../audio/live.worklet';
import { emptyState, motionRate, type VisualState } from '../timeline/timeline';

/**
 * Turns the worklet's raw per-frame measurements into smooth, normalized,
 * musically useful signals in real time:
 *  - automatic gain (so a quiet room mic and a loud file look comparable),
 *  - attack/release envelopes per band,
 *  - adaptive-threshold onset detection,
 *  - rolling tempo estimate (estimated) and a phase-locked beat clock,
 *  - silence and transition detection.
 *
 * Output is the same VisualState that pre-analyzed files produce, so every
 * world consumes one interface.
 */

const WAVE_SECONDS = 6;
const ONSET_SECONDS = 8;

export interface LiveStats {
  /** dBFS of the latest frame */
  levelDb: number;
  /** true when the input has been near-silent for > 0.4 s */
  silent: boolean;
  bpm: number | null;
  tempoConfidence: number;
  /** ms from the newest analyzed sample to now (analysis + message latency) */
  analysisLatencyMs: number;
  framesPerSecond: number;
  transitions: number;
}

class Env {
  v = 0;
  constructor(private attack: number, private release: number) {}
  step(x: number, dt: number): number {
    const tau = x > this.v ? this.attack : this.release;
    this.v += (1 - Math.exp(-dt / tau)) * (x - this.v);
    return this.v;
  }
}

/** Slow automatic gain: tracks a decaying peak reference per signal. */
class AutoGain {
  ref: number;
  constructor(private floor: number, private decayPerSec = 0.12) {
    this.ref = floor;
  }
  norm(x: number, dt: number): number {
    if (x > this.ref) this.ref = x;
    else this.ref = Math.max(this.floor, this.ref * Math.exp(-this.decayPerSec * dt));
    return Math.min(1, x / this.ref);
  }
}

export class LiveAnalyzer {
  readonly sampleRate: number;
  readonly hop: number;
  /** min/max ring buffer for the scrolling waveform */
  readonly waveMin: Float32Array;
  readonly waveMax: Float32Array;
  waveWrite = 0;
  /** latest spectrum (smoothed, 0..1) */
  readonly spectrum = new Float32Array(48);
  readonly spectrumPeak = new Float32Array(48);
  readonly stats: LiveStats = { levelDb: -120, silent: true, bpm: null, tempoConfidence: 0, analysisLatencyMs: 0, framesPerSecond: 0, transitions: 0 };

  private lowG = new AutoGain(1e-4);
  private midG = new AutoGain(1e-4);
  private highG = new AutoGain(1e-5);
  private fluxG = new AutoGain(0.5, 0.08);
  private lowFluxG = new AutoGain(0.02, 0.08);
  private specG = new AutoGain(0.02, 0.1);
  private eLow = new Env(0.012, 0.18);
  private eMid = new Env(0.02, 0.22);
  private eHigh = new Env(0.008, 0.12);
  private eEnergy = new Env(0.6, 1.6);
  private eLong = new Env(6, 6);
  private dbMin = -50;
  private dbMax = -20;

  private onsetBuf: Float32Array;
  private onsetW = 0;
  private onsetFilled = 0;
  private fluxMean = 0;
  private fluxVar = 1;
  private lowMean = 0;
  private lowVar = 1;
  private lastOnsetT = -1;
  private lastKickT = -10;
  private kickStr = 0;
  private lastSnareT = -10;
  private lastHatT = -10;
  private lastTransientT = -10;
  private transientStr = 0;
  private silentSince = -1;
  private lastTempoAt = 0;

  // beat clock
  private beatPeriod = 0.5;
  private beatAnchor = 0; // audio time of a beat
  private hasPulse = false;

  // transitions
  private shortVec = [0, 0, 0];
  private longVec = [0, 0, 0];
  private lastTransitionT = -10;
  private transitionT = -10;

  private lastFrameT = 0;
  private frameTimes: number[] = [];
  private latest: LiveFrameMsg | null = null;
  private motion = 0;
  private motionT = -1;
  private lastIntensity = 0;
  private startedAt = -1;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.hop = HOP_SIZE / sampleRate;
    const blocks = Math.ceil((WAVE_SECONDS * sampleRate) / 128);
    this.waveMin = new Float32Array(blocks);
    this.waveMax = new Float32Array(blocks);
    this.onsetBuf = new Float32Array(Math.ceil(ONSET_SECONDS / this.hop));
  }

  /** Feed one worklet frame. `nowCtx` is AudioContext.currentTime at receipt. */
  push(f: LiveFrameMsg, nowCtx: number): void {
    const dt = this.lastFrameT ? Math.min(0.1, Math.max(0.001, f.t - this.lastFrameT)) : this.hop;
    this.lastFrameT = f.t;
    if (this.startedAt < 0) this.startedAt = f.t;
    this.latest = f;

    // waveform ring
    for (let i = 0; i < f.wave.length; i += 2) {
      this.waveMin[this.waveWrite] = f.wave[i];
      this.waveMax[this.waveWrite] = f.wave[i + 1];
      this.waveWrite = (this.waveWrite + 1) % this.waveMin.length;
    }

    // spectrum: log magnitude with AGC, fast attack / slower fall
    let smax = 0;
    for (let i = 0; i < f.bands.length; i++) smax = Math.max(smax, f.bands[i]);
    this.specG.norm(smax, dt);
    for (let i = 0; i < this.spectrum.length; i++) {
      const v = Math.min(1, Math.max(0, 1 + Math.log10((f.bands[i] ?? 0) / this.specG.ref + 1e-6) / 2.6));
      const cur = this.spectrum[i];
      this.spectrum[i] = v > cur ? cur + (v - cur) * 0.6 : cur + (v - cur) * 0.18;
      this.spectrumPeak[i] = Math.max(this.spectrum[i], this.spectrumPeak[i] - dt * 0.35);
    }

    // level + silence
    const db = 20 * Math.log10(f.rms + 1e-9);
    this.stats.levelDb = db;
    if (db < -55) {
      if (this.silentSince < 0) this.silentSince = f.t;
    } else this.silentSince = -1;
    this.stats.silent = this.silentSince >= 0 && f.t - this.silentSince > 0.4;

    // relative energy: track the room's dynamic range slowly
    if (db > -70) {
      this.dbMax = Math.max(db, this.dbMax - dt * 0.4);
      this.dbMin = Math.min(db, this.dbMin + dt * 0.4);
      if (this.dbMax - this.dbMin < 12) this.dbMin = this.dbMax - 12;
    }
    const rel = Math.min(1, Math.max(0, (db - this.dbMin) / (this.dbMax - this.dbMin)));
    this.eEnergy.step(this.stats.silent ? 0 : rel, dt);
    this.eLong.step(this.stats.silent ? 0 : rel, dt);

    // bands: compress (sqrt power) then AGC, then envelopes
    const low = this.lowG.norm(Math.sqrt(f.low), dt);
    const mid = this.midG.norm(Math.sqrt(f.mid), dt);
    const high = this.highG.norm(Math.sqrt(f.high), dt);
    const gate = this.stats.silent ? 0 : 1;
    this.eLow.step(low * gate, dt);
    this.eMid.step(mid * gate, dt);
    this.eHigh.step(high * gate, dt);

    // onset envelope = 0.5 z(flux) + 0.5 z(lowFlux), same mix as offline
    const a = 1 - Math.exp(-dt / 2);
    this.fluxMean += a * (f.flux - this.fluxMean);
    this.fluxVar += a * ((f.flux - this.fluxMean) ** 2 - this.fluxVar);
    this.lowMean += a * (f.lowFlux - this.lowMean);
    this.lowVar += a * ((f.lowFlux - this.lowMean) ** 2 - this.lowVar);
    const zf = Math.max(0, (f.flux - this.fluxMean) / Math.sqrt(this.fluxVar + 1e-9));
    const zl = Math.max(0, (f.lowFlux - this.lowMean) / Math.sqrt(this.lowVar + 1e-12));
    const onset = this.stats.silent ? 0 : 0.5 * zf + 0.5 * zl;
    this.onsetBuf[this.onsetW] = onset;
    this.onsetW = (this.onsetW + 1) % this.onsetBuf.length;
    this.onsetFilled = Math.min(this.onsetBuf.length, this.onsetFilled + 1);

    // transient detection (absolute gate stops room noise from triggering)
    const lowN = this.lowFluxG.norm(f.lowFlux, dt);
    const fullN = this.fluxG.norm(f.flux, dt);
    if (!this.stats.silent && onset > 1.6 && f.fluxAbs > 0.25 && f.t - this.lastOnsetT > 0.07) {
      this.lastOnsetT = f.t;
      this.lastTransientT = f.t;
      this.transientStr = Math.min(1, onset / 4);
      const hiShare = f.highFlux / Math.max(1e-6, f.flux);
      if (lowN > 0.45 && zl > 1.2) {
        this.lastKickT = f.t;
        this.kickStr = Math.min(1, 0.4 + lowN * 0.7);
        this.lockBeat(f.t);
      } else if (hiShare > 0.55) this.lastHatT = f.t;
      else this.lastSnareT = f.t;
    }
    void fullN;

    // tempo once per second over the last 8 s of onset envelope
    if (f.t - this.lastTempoAt > 1 && this.onsetFilled > this.onsetBuf.length * 0.6) {
      this.lastTempoAt = f.t;
      const ordered = new Float32Array(this.onsetFilled);
      const start = (this.onsetW - this.onsetFilled + this.onsetBuf.length) % this.onsetBuf.length;
      for (let i = 0; i < this.onsetFilled; i++) ordered[i] = this.onsetBuf[(start + i) % this.onsetBuf.length];
      const est = estimateTempo(ordered, this.hop);
      const conf = est.confidence;
      this.stats.tempoConfidence = this.stats.tempoConfidence * 0.6 + conf * 0.4;
      const period = 60 / est.bpm;
      if (conf > 0.15) {
        // hysteresis: only switch tempo when the new one is clearly different and confident
        if (!this.hasPulse || Math.abs(period - this.beatPeriod) / this.beatPeriod > 0.04) this.beatPeriod = period;
        else this.beatPeriod = this.beatPeriod * 0.8 + period * 0.2;
      }
      this.hasPulse = this.stats.tempoConfidence > 0.14 && !this.stats.silent;
      this.stats.bpm = this.hasPulse ? Math.round((60 / this.beatPeriod) * 10) / 10 : null;
    }
    if (this.stats.silent) {
      this.hasPulse = false;
      this.stats.bpm = null;
    }

    // transitions: compare short (2 s) vs long (10 s) band balance (estimate)
    const vec = [this.eLow.v, this.eMid.v, this.eHigh.v];
    const as = 1 - Math.exp(-dt / 2), al = 1 - Math.exp(-dt / 10);
    let dist = 0;
    for (let i = 0; i < 3; i++) {
      this.shortVec[i] += as * (vec[i] - this.shortVec[i]);
      this.longVec[i] += al * (vec[i] - this.longVec[i]);
      dist += (this.shortVec[i] - this.longVec[i]) ** 2;
    }
    if (Math.sqrt(dist) > 0.32 && f.t - this.lastTransitionT > 8 && f.t - this.startedAt > 6) {
      this.lastTransitionT = f.t;
      this.transitionT = f.t;
      this.stats.transitions++;
    }

    // diagnostics
    this.stats.analysisLatencyMs = Math.max(0, (nowCtx - f.t) * 1000);
    this.frameTimes.push(f.t);
    while (this.frameTimes.length && f.t - this.frameTimes[0] > 1) this.frameTimes.shift();
    this.stats.framesPerSecond = this.frameTimes.length;
  }

  /** Phase-lock the beat clock to a kick near the predicted beat. */
  private lockBeat(t: number) {
    const p = this.beatPeriod;
    const k = Math.round((t - this.beatAnchor) / p);
    const predicted = this.beatAnchor + k * p;
    const err = t - predicted;
    if (Math.abs(err) < p * 0.25) this.beatAnchor = predicted + err * 0.35;
    else if (!this.hasPulse) this.beatAnchor = t;
  }

  /** VisualState at audio-context time `now` (interpolation-free; uses latest analysis). */
  stateAt(now: number, out: VisualState = emptyState()): VisualState {
    const t = now;
    out.t = t;
    out.duration = Infinity;
    out.progress = 0;
    out.hasPulse = this.hasPulse;
    out.bpm = this.stats.bpm ?? 60;
    const p = this.hasPulse ? this.beatPeriod : 4;
    const bt = (t - this.beatAnchor) / p;
    out.beatTime = bt;
    out.beatIndex = Math.floor(bt);
    out.beatPhase = bt - Math.floor(bt);
    out.beatPulse = this.hasPulse ? Math.exp(-(out.beatPhase * p) / (p * 0.22)) : 0;
    out.barIndex = Math.floor(bt / 4);
    out.barPhase = (bt / 4) - Math.floor(bt / 4);
    out.downbeatPulse = this.hasPulse && out.beatIndex % 4 === 0 ? out.beatPulse : 0;
    out.low = this.eLow.v;
    out.mid = this.eMid.v;
    out.high = this.eHigh.v;
    out.energy = this.eEnergy.v;
    out.kick = this.kickStr * Math.exp(-Math.max(0, t - this.lastKickT) / 0.12);
    out.snare = Math.exp(-Math.max(0, t - this.lastSnareT) / 0.1);
    out.hat = Math.exp(-Math.max(0, t - this.lastHatT) / 0.05);
    out.transient = this.transientStr * Math.exp(-Math.max(0, t - this.lastTransientT) / 0.09);
    if (this.stats.silent) out.kick = out.snare = out.hat = out.transient = 0;
    out.section = this.stats.silent ? 'ambient' : this.eEnergy.v > this.eLong.v + 0.15 ? 'peak' : this.eEnergy.v < this.eLong.v - 0.2 ? 'breakdown' : 'verse';
    out.sectionIndex = this.stats.transitions;
    out.sectionProgress = 0;
    out.build = 0;
    out.sinceDrop = t - this.transitionT;
    out.dropImpact = this.eEnergy.v > this.eLong.v ? Math.exp(-out.sinceDrop / 1.8) : 0;
    out.anticipation = 0;
    // live intensity: energy relative to recent history, with restraint
    const lift = Math.max(0, this.eEnergy.v - this.eLong.v * 0.6);
    out.intensity = this.stats.silent ? 0.04 : Math.min(1, 0.18 + 0.55 * this.eEnergy.v + 0.4 * lift);
    out.flash = Math.max(out.dropImpact * 0.8, out.intensity > 0.8 ? out.downbeatPulse * 0.4 : 0);
    // integrate the motion clock (live is not replayable, so integration is fine)
    if (this.motionT >= 0 && t > this.motionT) this.motion += motionRate(out.intensity, out.energy) * Math.min(0.1, t - this.motionT);
    this.motionT = t;
    this.lastIntensity = out.intensity;
    out.motion = this.motion;
    return out;
  }

  get latestFrame(): LiveFrameMsg | null {
    return this.latest;
  }
}
