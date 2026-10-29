# PulseForm — Architecture

PulseForm turns an uploaded song into an original, music-reactive 3D experience.
Everything runs in the browser. Audio never leaves the device.

```
UPLOAD ─► ANALYZE ─► GENERATE ─► EXPERIENCE ─► EXPORT
 File      Worker      Director     Player        Frame-by-frame
 decode    DSP         + seeds      (audio clock) WebCodecs → MP4
```

## Modules

| Module | Path | Responsibility |
|---|---|---|
| Audio analysis | `src/analysis/` | Pure TypeScript DSP over decoded PCM. Runs in a Web Worker in the app, in Node for tests. No DOM. |
| Timeline | `src/timeline/` | Turns an `AnalysisResult` into a pure function `stateAt(t)`: every visual parameter at audio time `t`. |
| Director | `src/director/` | Rules over measured features choose scene family, palette, camera style and intensity curve. Produces 3 proposals per song from a seed. |
| Render engine | `src/render/` | Three.js renderer, post-processing, scene registry. Scenes implement `update(state, t)` and hold no time-accumulated state. |
| Scenes | `src/render/scenes/` | Electric Energy, Laser Dimension, Cosmic Universe, Liquid Morph, Festival Overdrive. |
| Export | `src/export/` | Renders frames at `t = i / fps` offscreen, encodes H.264 with WebCodecs, muxes original audio into MP4, then validates the file by decoding it. |
| UI | `src/ui/` | React screens: Upload, Analyze, Proposals, Player (bottom waveform scrubber), Export. |

## Key invariants

1. **Audio time is the only clock.** Rendering reads `audio.currentTime`, or `i / fps` during export. Scenes compute everything from `t`. Pausing, seeking, replaying and export therefore always match.
2. **Determinism.** Seeded PRNG (`mulberry32`) keyed by `fingerprint ⊕ variation`. The same song with the same seed gives the same visuals, frame for frame.
3. **Measured vs estimated.** Every descriptor carries `provenance: 'measured' | 'estimated'` and a `basis`. The UI shows both.
4. **Honest progress.** Analysis progress events come from the real pipeline stages. Export reports "complete" only after the MP4 decodes and its duration matches.

## Audio analysis (implemented)

- STFT: 2048-sample Hann window, 512 hop, centred frames.
- Measurements per frame: RMS, low/mid/high band energy, spectral centroid, flatness, log spectral flux, low-band linear flux (kick-weighted), high-band flux.
- Tempo: autocorrelation of the onset envelope with a log-Gaussian tempo prior (Ellis 2007), plus an octave check.
- Beats: dynamic-programming beat tracker (Ellis 2007). Then a half-beat phase correction (kick on the beat) and a constant-tempo grid fit that carries the beat through drum-less breakdowns.
- Downbeats: bar phase chosen by kick weight plus harmonic change.
- Structure: bar-level feature vectors, box-kernel Foote novelty, and peak picking. Sections are then labelled by rules (intro/build/drop/breakdown/peak/outro).
- Descriptors: energy, loudness, brightness, bass weight, density, contrast, texture, drops, mood.

Acceptance (all passing, `npm test`):

| Check | Target | Result |
|---|---|---|
| Tempo error | < 1% | 124.0 / 124, 150.0 / 150 |
| Beat F-measure (±70 ms) | ≥ 0.90 | 0.996 / 0.996 |
| Drops detected | within 1 beat, no false drops | 77.42 vs 77.42 s; 25.61, 76.82 vs 25.60, 76.80 s |
| Ambient pulse | none | none, 0 drops |
| Energy ordering | ambient < house < energy | 0.15 < 0.49 < 0.74 |

These are synthetic tracks with exact ground truth. Real-world accuracy will be lower on music with tempo drift, swing or no clear kick.
