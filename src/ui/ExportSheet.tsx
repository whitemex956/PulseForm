import { useEffect, useRef, useState } from 'react';
import { exportMp4, exportSupported, SIZES, type Aspect, type ExportProgress, type ExportResult } from '../export/exporter';
import type { DirectorSettings } from '../director/runtime';
import type { AnalysisResult } from '../analysis/types';
import type { Timeline } from '../timeline/timeline';
import { fmtTime } from '../director/director';
import { worldName } from '../render/worlds';
import { IconClose, IconCheck, IconExport } from './icons';

type Range = 'clip' | 'full';

interface Props {
  song: { name: string; buffer: AudioBuffer; analysis: AnalysisResult; timeline: Timeline };
  world: string;
  stage: string;
  director: DirectorSettings;
  reducedMotion: boolean;
  photosensitive: boolean;
  position: number;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
}

/** 30-second clip centred on the first drop (or the loudest section). */
function clipRange(a: AnalysisResult): [number, number] {
  const focus = a.drops[0] ?? a.sections.reduce((b, s) => (s.energy > b.energy ? s : b), a.sections[0])?.start ?? 0;
  const start = Math.max(0, Math.min(a.duration - 30, focus - 8));
  return [start, Math.min(a.duration, start + 30)];
}

const PHASE: Record<ExportProgress['phase'], string> = {
  preparing: 'Preparing',
  video: 'Rendering frames',
  audio: 'Encoding audio',
  muxing: 'Writing MP4',
  validating: 'Checking the file plays',
  done: 'Done',
};

export function ExportSheet(p: Props) {
  const [aspect, setAspect] = useState<Aspect>('9:16');
  const [range, setRange] = useState<Range>('clip');
  const [fps, setFps] = useState<30 | 60>(30);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [cs, ce] = clipRange(p.song.analysis);
  let [start, end] = range === 'clip' ? [cs, ce] : [0, p.song.analysis.duration];
  // automated tests on software GPUs export a short slice of the same range
  const testSeconds = (window as unknown as { __pfTest?: { exportSeconds?: number } }).__pfTest?.exportSeconds;
  if (testSeconds) end = Math.min(end, start + testSeconds);

  useEffect(() => () => {
    abort.current?.abort();
  }, []);
  useEffect(() => () => {
    if (result) URL.revokeObjectURL(result.url);
  }, [result]);

  const run = async () => {
    setError(null);
    setResult(null);
    const ac = new AbortController();
    abort.current = ac;
    p.onBusy(true);
    try {
      const r = await exportMp4(
        { aspect, fps, start, end, world: p.world, stage: p.stage, director: p.director, reducedMotion: p.reducedMotion, photosensitive: p.photosensitive },
        p.song,
        setProgress,
        ac.signal,
      );
      setResult(r);
      (window as unknown as { __pfLastExport?: ExportResult }).__pfLastExport = r;
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') setError(e instanceof Error ? e.message : String(e));
      setProgress(null);
    } finally {
      p.onBusy(false);
      abort.current = null;
    }
  };

  const share = async () => {
    if (!result) return;
    const file = new File([result.blob], result.fileName, { type: 'video/mp4' });
    try {
      await navigator.share?.({ files: [file], title: 'PulseForm' });
    } catch {
      /* user cancelled */
    }
  };

  const busy = progress && progress.phase !== 'done' && !result;
  const pct = progress ? Math.round((progress.phase === 'video' ? progress.frame / progress.frames : progress.phase === 'preparing' ? 0 : 1) * 100) : 0;
  const canShare = typeof navigator.canShare === 'function' && result && navigator.canShare({ files: [new File([], 'x.mp4', { type: 'video/mp4' })] });

  return (
    <div className="modal-wrap" role="dialog" aria-label="Export video">
      <div className="modal export-modal">
        <div className="sheet-head">
          <h2>Export video</h2>
          <button className="icon-btn" onClick={() => (busy ? abort.current?.abort() : p.onClose())} aria-label={busy ? 'Cancel export' : 'Close'}><IconClose /></button>
        </div>
        <p className="sub">{worldName(p.world)} · {p.song.name}</p>
        {!exportSupported() && <p className="intro-error">Video export needs a browser with WebCodecs: Chrome or Edge on desktop, or Safari 17+.</p>}

        {!result && !busy && (
          <>
            <div className="aspects" role="group" aria-label="Shape">
              {(Object.keys(SIZES) as Aspect[]).map((a) => {
                const [w, h] = SIZES[a];
                const k = 34 / Math.max(w, h);
                return (
                  <button key={a} aria-pressed={aspect === a} onClick={() => setAspect(a)} data-testid={`aspect-${a}`}>
                    <span className="frame" style={{ width: w * k, height: h * k }} />
                    <span>{a === '9:16' ? 'Portrait' : a === '16:9' ? 'Landscape' : 'Square'}<br /><small>{w}×{h}</small></span>
                  </button>
                );
              })}
            </div>
            <div className="field">
              <label>Length</label>
              <div className="seg" role="group" aria-label="Length">
                <button aria-pressed={range === 'clip'} onClick={() => setRange('clip')} data-testid="range-clip">30 s around the drop</button>
                <button aria-pressed={range === 'full'} onClick={() => setRange('full')}>Whole song</button>
              </div>
              <p className="toggle-hint">{fmtTime(start)} – {fmtTime(end)} · {Math.round(end - start)} s</p>
            </div>
            <div className="field">
              <label>Frame rate</label>
              <div className="seg" role="group" aria-label="Frame rate">
                <button aria-pressed={fps === 30} onClick={() => setFps(30)}>30 fps</button>
                <button aria-pressed={fps === 60} onClick={() => setFps(60)}>60 fps</button>
              </div>
            </div>
            {error && <p className="intro-error" role="alert">{error}</p>}
            <div className="actions">
              <button className="btn glow" onClick={() => void run()} disabled={!exportSupported()} data-testid="export-start"><IconExport />Export MP4</button>
            </div>
            <p className="fineprint left">Rendered frame by frame on this device from your song’s analysis, with the original audio. Only export music you have the rights to share.</p>
          </>
        )}

        {busy && progress && (
          <div className="export-progress" aria-live="polite">
            <div className="export-phase">{PHASE[progress.phase]}</div>
            <div className="progress"><div style={{ width: `${pct}%` }} /></div>
            <div className="export-stats">
              <span>{progress.phase === 'video' ? `frame ${progress.frame} / ${progress.frames}` : `${progress.frames} frames`}</span>
              <span>{progress.eta !== null && progress.phase === 'video' ? `about ${fmtTime(progress.eta)} left` : ''}</span>
            </div>
            <div className="actions"><button className="btn ghost" onClick={() => abort.current?.abort()}>Cancel</button></div>
          </div>
        )}

        {result && (
          <div className="export-done">
            <video src={result.url} controls playsInline aria-label="Exported video preview" />
            <div className="check"><IconCheck />Plays back · {result.duration.toFixed(1)} s · {result.width}×{result.height}</div>
            <div className="check"><IconCheck />Picture decoded · {result.videoCodec.startsWith('avc1') ? 'H.264' : result.videoCodec}</div>
            <div className={result.validation.audioOk === false ? 'check warn' : 'check'}>
              <IconCheck />
              {result.validation.audioOk === null ? `Audio track · ${result.audioCodec} (not checked in this browser)` : result.validation.audioOk ? `Audio decoded · ${result.audioCodec}` : 'Audio track did not decode in this browser'}
            </div>
            <div className="actions">
              {canShare && <button className="btn" onClick={() => void share()}>Share</button>}
              <a className="btn glow" href={result.url} download={result.fileName} data-testid="export-download">Download · {(result.bytes / 1e6).toFixed(1)} MB</a>
            </div>
            {result.audioCodec === 'Opus' && <p className="fineprint left">This browser has no AAC encoder, so the audio is Opus. It plays in browsers, VLC and most apps; some older Apple apps need AAC.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
