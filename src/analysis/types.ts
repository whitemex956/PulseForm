/**
 * Audio analysis result types.
 *
 * Every field is tagged in docs as either a MEASUREMENT (computed directly
 * from the decoded signal) or an ESTIMATE (an inference from measurements
 * that can be wrong). The UI surfaces this distinction.
 */

export type Provenance = 'measured' | 'estimated';

export interface FrameFeatures {
  /** seconds between frames */
  hop: number;
  /** number of frames */
  count: number;
  /** MEASURED: RMS amplitude per frame (linear, 0..1 full scale) */
  rms: Float32Array;
  /** MEASURED: band energies (linear power, normalized 0..1 per track at 98th percentile) */
  low: Float32Array; // 20-150 Hz
  mid: Float32Array; // 150-2000 Hz
  high: Float32Array; // 2-16 kHz
  /** MEASURED: spectral centroid in Hz */
  centroid: Float32Array;
  /** MEASURED: spectral flatness 0..1 (1 = noise-like) */
  flatness: Float32Array;
  /** MEASURED: onset strength (log spectral flux), normalized 0..1 */
  onset: Float32Array;
  /** MEASURED: low-band flux (kick-like attacks), normalized 0..1 */
  lowOnset: Float32Array;
  /** MEASURED: high-band flux (hat/snare attacks), normalized 0..1 */
  highOnset: Float32Array;
  /** DERIVED: smoothed loudness envelope ~1.5 s window, normalized 0..1 */
  energy: Float32Array;
}

export interface Transient {
  time: number;
  strength: number; // 0..1
  band: 'low' | 'mid' | 'high' | 'full';
}

export interface BeatGrid {
  /** ESTIMATED: whether the track has a steady pulse at all */
  hasPulse: boolean;
  /** ESTIMATED: tempo in BPM (null when no pulse) */
  bpm: number | null;
  /** ESTIMATED: 0..1 periodicity strength of the onset envelope */
  confidence: number;
  /** ESTIMATED: beat times in seconds */
  beats: number[];
  /** ESTIMATED: index into beats of each downbeat (bar start) */
  downbeats: number[];
}

export type SectionKind = 'intro' | 'verse' | 'build' | 'drop' | 'breakdown' | 'peak' | 'outro' | 'ambient';

export interface Section {
  start: number;
  end: number;
  /** ESTIMATED: role of this section */
  kind: SectionKind;
  /** MEASURED: mean normalized energy 0..1 within section */
  energy: number;
  /** MEASURED: energy slope across section (per second, normalized units) */
  slope: number;
}

export interface Descriptor {
  key: string;
  label: string;
  value: number; // 0..1
  text: string; // human readable e.g. "High"
  provenance: Provenance;
  basis: string; // which measurement it comes from
}

export interface AnalysisResult {
  version: 1;
  /** MEASURED */
  duration: number;
  sampleRate: number;
  channels: number;
  /** MEASURED: integrated loudness-ish (mean RMS in dBFS) */
  meanDb: number;
  peakDb: number;
  frames: FrameFeatures;
  transients: Transient[];
  beatGrid: BeatGrid;
  sections: Section[];
  /** ESTIMATED: times of likely drops (start of high-energy section after build/breakdown) */
  drops: number[];
  /** ESTIMATED: [start,end] of likely build-ups */
  builds: Array<[number, number]>;
  descriptors: Descriptor[];
  /** stable hash of the decoded audio, used to derive creative seeds */
  fingerprint: string;
  /** wall-clock seconds each stage took */
  timings: Record<string, number>;
}

export type AnalysisStage =
  | 'decode'
  | 'spectrum'
  | 'onsets'
  | 'tempo'
  | 'beats'
  | 'structure'
  | 'descriptors';

export interface ProgressEvent {
  stage: AnalysisStage;
  /** 0..1 within the stage */
  progress: number;
  /** optional measured detail surfaced to the UI, e.g. "124.0 BPM" */
  detail?: string;
}
