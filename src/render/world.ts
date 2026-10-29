import type { VisualState } from '../timeline/timeline';

/**
 * Every visual world implements this one interface and receives audio only
 * through VisualState. No world contains audio logic of its own.
 */

export interface WorldParams {
  seed: number;
  /** linear-RGB palette: deep, primary, secondary, accent, hot (5 × vec3) */
  palette: Float32Array;
  /** 0..1 layers/detail */
  complexity: number;
  /** 0..1.3 overall intensity multiplier (user control) */
  intensity: number;
  /** 0..1 — 1 normal, lower in reduced-motion mode */
  motionScale: number;
  /** discrete shape/composition selection driven by the director (world-specific meaning) */
  shapeA: number;
  shapeB: number;
  /** 0..1 morph from shapeA to shapeB */
  morph: number;
  /** camera style index (world-specific) */
  camera: number;
}

export interface FrameInput {
  s: VisualState;
  p: WorldParams;
  width: number;
  height: number;
  /** 0..3 quality tier chosen by the adaptive governor */
  quality: number;
  /** vertical framing: fraction of height to lift the subject (keeps it above the waveform band) */
  frameOffset: number;
  /** optional texture of another world, shown as stage content (Festival Mode) */
  screen?: WebGLTexture;
}

export interface World {
  readonly id: string;
  /** the world renders its own strobes, so the engine skips the full-screen flash wash */
  readonly ownFlash?: boolean;
  init(gl: WebGL2RenderingContext): void;
  /** Draw into the currently bound framebuffer (HDR, linear). */
  render(f: FrameInput): void;
  dispose(): void;
}
