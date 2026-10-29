import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioHub, type SourceStatus } from '../audio/hub';
import { computePeaks, ACCEPTED } from '../audio/decode';
import type { AnalysisResult, ProgressEvent, AnalysisStage } from '../analysis/types';
import type { WorkerOut } from '../audio/analysis.worker';
import { Timeline, emptyState, type VisualState } from '../timeline/timeline';
import { Engine } from '../render/engine';
import { WORLDS, worldName } from '../render/worlds';
import { FAMILY_INFO, proposeDirections, type ArtDirection } from '../director/director';
import { DirectorRuntime, defaultDirector, SHAPES } from '../director/runtime';
import { SIGNATURE, makePalette, REMOTE_PALETTES, type Palette } from '../director/director';
import { Rng } from '../core/random';
import { drawFileWave, drawLiveWave, drawSpectrum, type FilePeaks } from './waveDraw';
import {
  IconPlay, IconPause, IconSliders, IconShuffle, IconExpand, IconClose, IconUpload, IconCheck, Mark, IconSparkle, IconExport,
} from './icons';
import { loadPrefs, savePrefs, loadWorlds, saveWorlds, type SavedWorld } from './prefs';
import { fmtTime } from '../director/director';
import { SessionHost } from '../session/controllers';
import type { Command } from '../session/protocol';
import { encodeQR, qrToSvg } from '../core/qr';
import { ExportSheet } from './ExportSheet';
import { api } from '../session/link';

type Sheet = null | 'source' | 'visual' | 'settings' | 'connect' | 'export';
type BandView = 'wave' | 'spectrum';

interface FileSession {
  name: string;
  buffer: AudioBuffer;
  analysis: AnalysisResult;
  timeline: Timeline;
  peaks: FilePeaks;
}

const STAGES: Array<{ key: AnalysisStage | 'decode'; label: string }> = [
  { key: 'decode', label: 'Decoding audio' },
  { key: 'spectrum', label: 'Measuring spectrum' },
  { key: 'onsets', label: 'Finding attacks' },
  { key: 'tempo', label: 'Estimating tempo' },
  { key: 'beats', label: 'Tracking beats' },
  { key: 'structure', label: 'Mapping sections' },
  { key: 'descriptors', label: 'Describing the sound' },
];

const PALETTES: Palette[] = (() => {
  const out: Palette[] = [SIGNATURE];
  const r = new Rng(7);
  for (let i = 0; i < 7; i++) out.push(makePalette(r, 0.3 + 0.1 * i, 0.4 + 0.07 * i, 'liquid'));
  return out;
})();

function statusText(s: SourceStatus, silent: boolean): { text: string; tone: 'live' | 'idle' | 'warn' | 'error' } {
  switch (s.kind) {
    case 'none':
      return { text: 'Not listening', tone: 'idle' };
    case 'mic':
      if (s.state === 'requesting') return { text: 'Waiting for microphone permission…', tone: 'idle' };
      if (s.state === 'listening') return silent ? { text: 'Listening · silence — play music nearby', tone: 'warn' } : { text: 'Listening · Microphone', tone: 'live' };
      if (s.state === 'stopped') return { text: 'Stopped listening', tone: 'idle' };
      return { text: 'message' in s ? s.message : 'Microphone unavailable', tone: 'error' };
    case 'file':
      return { text: s.state === 'playing' ? `Playing · ${s.name}` : s.state === 'ended' ? `Finished · ${s.name}` : `Paused · ${s.name}`, tone: s.state === 'playing' ? 'live' : 'idle' };
    case 'companion':
      if (s.state === 'connected') return silent ? { text: 'PC audio · silence — play something', tone: 'warn' } : { text: `Listening · PC audio${s.message ? ` (${s.message})` : ''}`, tone: 'live' };
      return { text: s.state === 'connecting' ? 'Connecting to Windows companion…' : s.message ?? 'Companion disconnected', tone: s.state === 'lost' ? 'error' : 'idle' };
    case 'remote':
      return { text: s.state === 'receiving' ? 'Receiving from paired desktop' : 'Paired desktop disconnected', tone: s.state === 'receiving' ? 'live' : 'error' };
  }
}

const prefs0 = loadPrefs();

export function App() {
  const artRef = useRef<HTMLCanvasElement>(null);
  const bandRef = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const hub = useMemo(() => new AudioHub('live.worklet.js'), []);
  const engineRef = useRef<Engine | null>(null);
  const directorRef = useRef<DirectorRuntime>(defaultDirector());
  const fileRef = useRef<FileSession | null>(null);
  const stateRef = useRef<VisualState>(emptyState());
  const [prefs, setPrefs] = useState(loadPrefs);
  const [status, setStatus] = useState<SourceStatus>({ kind: 'none', state: 'idle' });
  const [silent, setSilent] = useState(true);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [band, setBand] = useState<BandView>('wave');
  const [idle, setIdle] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [glError, setGlError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState<{ name: string; stage: string; progress: number; details: Record<string, string>; error?: string } | null>(null);
  const [fileInfo, setFileInfo] = useState<{ name: string; duration: number; bpm: number | null } | null>(null);
  const [playT, setPlayT] = useState(0);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [worlds, setWorlds] = useState<SavedWorld[]>(loadWorlds);
  const [paletteIdx, setPaletteIdx] = useState(0);
  const [, force] = useState(0);
  const [diag, setDiag] = useState({ fps: 0, ms: 0, scale: 0, tier: 0, latency: 0, out: 0, afps: 0, bpm: '—', level: -120, suppressed: 0 });
  const hoverRef = useRef<number | null>(null);
  hoverRef.current = hoverT;
  const bandViewRef = useRef(band);
  bandViewRef.current = band;
  const variation = useRef(0);
  const introRef = useRef(true);
  const [world, setWorldState] = useState<string>(() => (WORLDS.some((w) => w.id === prefs0.world) ? prefs0.world : 'liquid'));
  const worldRef = useRef(world);
  worldRef.current = world;
  const [proposals, setProposals] = useState<ArtDirection[]>([]);
  const hostRef = useRef<SessionHost | null>(null);
  const lastShapes = useRef({ shapeA: 1, shapeB: 1, morph: 0 });
  const [host, setHost] = useState<SessionHost | null>(null);
  const [pairUrl, setPairUrl] = useState<string>('');
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [, hostTick] = useState(0);

  const flash = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((t) => (t === m ? null : t)), 2600);
  }, []);

  // ---------- engine + render loop ----------
  useEffect(() => {
    const canvas = artRef.current!;
    let engine: Engine;
    try {
      engine = new Engine(canvas);
    } catch (e) {
      setGlError(e instanceof Error ? e.message : String(e));
      return;
    }
    engineRef.current = engine;
    // automated tests on software GPUs lower the pixel ratio to keep frames moving
    const testDpr = (window as unknown as { __pfTest?: { dpr?: number } }).__pfTest?.dpr;
    if (testDpr) engine.settings.maxDpr = testDpr;
    let raf = 0;
    let lastDiag = 0;
    let lastUi = 0;
    let idleMotion = 0;
    let lastWall = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dir = directorRef.current;
      const st = hub.status;
      const s = stateRef.current;
      let params;
      if (st.kind === 'file' && fileRef.current && hub.transport) {
        const t = hub.transport.currentTime;
        fileRef.current.timeline.stateAt(t, s);
        params = dir.paramsFile(s);
        if (now - lastUi > 100) {
          lastUi = now;
          setPlayT(t);
        }
      } else if ((st.kind === 'mic' && st.state === 'listening') || (st.kind === 'companion' && st.state === 'connected')) {
        hub.analyzer!.stateAt(hub.audioTime, s);
        params = dir.paramsLive(s, hub.analyzer!.stats.transitions);
      } else {
        // Idle: no audio is being analyzed, so the sculpture only drifts slowly.
        const dt = Math.min(0.1, (now - lastWall) / 1000);
        idleMotion += dt * 0.35;
        Object.assign(s, emptyState(), { t: now / 1000, motion: idleMotion, intensity: 0.12, duration: Infinity });
        params = dir.paramsIdle();
      }
      lastWall = now;
      engine.settings.reducedMotion = prefsRef.current.reducedMotion;
      engine.settings.photosensitive = prefsRef.current.photosensitive;
      engine.settings.quality = prefsRef.current.quality;
      // lift the sculpture while the intro copy is on screen
      const target = introRef.current ? 0.2 : 0.08;
      engine.settings.frameOffset += (target - engine.settings.frameOffset) * 0.06;
      const wid = worldRef.current;
      if (!engine.hasWorld(wid)) engine.register(WORLDS.find((w) => w.id === wid)!.create());
      const stageId = wid === 'festival' ? prefsRef.current.stage : null;
      if (stageId && !engine.hasWorld(stageId)) engine.register(WORLDS.find((w) => w.id === stageId)!.create());
      engine.settings.stageWorld = stageId;
      engine.render(wid, s, params, now);
      lastShapes.current = { shapeA: params.shapeA, shapeB: params.shapeB, morph: params.morph };

      // bottom band
      const bc = bandRef.current;
      if (bc) {
        if (st.kind === 'file' && fileRef.current && bandViewRef.current === 'wave') {
          const f = fileRef.current;
          drawFileWave(bc, f.peaks, f.analysis.duration, hub.transport?.currentTime ?? 0, { drops: f.analysis.drops, sections: f.analysis.sections.map((x) => ({ start: x.start, kind: x.kind })) }, hoverRef.current);
        } else if (hub.analyzer) {
          if (bandViewRef.current === 'spectrum') drawSpectrum(bc, hub.analyzer);
          else drawLiveWave(bc, hub.analyzer, hub.analyzer.stats.silent);
        } else {
          const g = bc.getContext('2d')!;
          g.clearRect(0, 0, bc.width, bc.height);
        }
      }
      if (now - lastDiag > 400) {
        lastDiag = now;
        const a = hub.analyzer;
        setSilent(a ? a.stats.silent : true);
        const ctx = hub.ctx as (AudioContext & { outputLatency?: number }) | null;
        setDiag({
          fps: engine.stats.fps,
          ms: engine.stats.frameMs,
          scale: engine.stats.renderScale,
          tier: engine.stats.quality,
          latency: a?.stats.analysisLatencyMs ?? 0,
          out: ((ctx?.outputLatency ?? 0) + (ctx?.baseLatency ?? 0)) * 1000,
          afps: a?.stats.framesPerSecond ?? 0,
          bpm: a?.stats.bpm ? `${a.stats.bpm} (est.)` : fileRef.current?.analysis.beatGrid.bpm ? `${fileRef.current.analysis.beatGrid.bpm} (est.)` : '—',
          level: a?.stats.levelDb ?? -120,
          suppressed: engine.stats.flashesSuppressed,
        });
      }
    };
    raf = requestAnimationFrame(loop);
    (window as unknown as { pulseform: unknown }).pulseform = { hub, engine, state: stateRef, director: directorRef };
    return () => {
      cancelAnimationFrame(raf);
      engine.dispose();
      engineRef.current = null;
    };
  }, [hub]);

  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  useEffect(() => savePrefs(prefs), [prefs]);
  useEffect(() => hub.subscribe(setStatus), [hub]);
  useEffect(() => {
    directorRef.current.settings.intensity = prefs.intensity;
  }, [prefs.intensity]);

  // ---------- immersive auto-hide ----------
  const active = (status.kind === 'mic' && status.state === 'listening') || (status.kind === 'file' && status.state === 'playing') || (status.kind === 'companion' && status.state === 'connected');
  useEffect(() => {
    let timer = 0;
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      if (active && !sheet) timer = window.setTimeout(() => setIdle(true), 3200);
    };
    wake();
    const evs = ['pointermove', 'pointerdown', 'keydown', 'touchstart'] as const;
    evs.forEach((e) => window.addEventListener(e, wake, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      evs.forEach((e) => window.removeEventListener(e, wake));
    };
  }, [active, sheet]);

  // ---------- screen wake lock while active ----------
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    navigator.wakeLock.request('screen').then((l) => (lock = l)).catch(() => {});
    return () => void lock?.release().catch(() => {});
  }, [active]);

  // ---------- recover after backgrounding ----------
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible' && hub.ctx && hub.ctx.state !== 'running' && hub.status.kind === 'mic' && hub.status.state === 'listening') {
        hub.ctx.resume().catch(() => flash('Tap anywhere to resume listening'));
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [hub, flash]);

  // ---------- actions ----------
  const listen = useCallback(async () => {
    setSheet(null);
    fileRef.current = null;
    setProposals([]);
    setFileInfo(null);
    await hub.startMic();
  }, [hub]);

  const stop = useCallback(() => {
    if (hub.status.kind === 'companion') hub.stopCompanionSource();
    else if (hub.status.kind === 'mic') hub.stopMic();
    else if (hub.status.kind === 'file') hub.pauseFile();
  }, [hub]);

  const togglePrimary = useCallback(() => {
    const s = hub.status;
    if (s.kind === 'file') {
      if (s.state === 'playing') hub.pauseFile();
      else void hub.playFile();
      return;
    }
    if ((s.kind === 'mic' && s.state === 'listening') || s.kind === 'companion') stop();
    else void listen();
  }, [hub, listen, stop]);

  const openFile = useCallback(async (file: File) => {
    setSheet(null);
    setAnalyzing({ name: file.name, stage: 'decode', progress: 0, details: {} });
    try {
      const ctx = await hub.ensureContext();
      const buffer = await ctx.decodeAudioData(await file.arrayBuffer()).catch(() => {
        throw new Error('This browser could not decode that file. Try MP3, WAV, M4A or FLAC.');
      });
      if (buffer.duration < 3) throw new Error('That clip is shorter than 3 seconds.');
      if (buffer.duration > 20 * 60) throw new Error('Songs up to 20 minutes are supported.');
      const channels = [buffer.getChannelData(0).slice()];
      if (buffer.numberOfChannels > 1) channels.push(buffer.getChannelData(1).slice());
      setAnalyzing((a) => a && { ...a, stage: 'spectrum', progress: 0, details: { ...a.details, decode: `${fmtTime(buffer.duration)} · ${(buffer.sampleRate / 1000).toFixed(1)} kHz` } });
      const peaks = computePeaks(channels, 2400);
      const analysis = await new Promise<AnalysisResult>((resolve, reject) => {
        const w = new Worker('analysis.worker.js');
        w.onmessage = (e: MessageEvent<WorkerOut>) => {
          const m = e.data;
          if (m.type === 'progress') {
            const ev: ProgressEvent = m.event;
            setAnalyzing((a) => a && { ...a, stage: ev.stage, progress: ev.progress, details: ev.detail ? { ...a.details, [ev.stage]: ev.detail } : a.details });
          } else if (m.type === 'done') {
            w.terminate();
            resolve(m.result);
          } else {
            w.terminate();
            reject(new Error(m.message));
          }
        };
        w.onerror = (e) => reject(new Error(e.message || 'Analysis failed.'));
        w.postMessage({ channels, sampleRate: buffer.sampleRate }, channels.map((c) => c.buffer));
      });
      const timeline = new Timeline(analysis);
      fileRef.current = { name: file.name, buffer, analysis, timeline, peaks };
      const dir = directorRef.current;
      const props = proposeDirections(analysis, 0).map((d) => ({ ...d, family: d.family as string })) as ArtDirection[];
      setProposals(props);
      applyProposalRef.current(props[0]);
      dir.planFor(analysis);
      await hub.loadFile(buffer, file.name);
      setFileInfo({ name: file.name, duration: analysis.duration, bpm: analysis.beatGrid.bpm });
      setAnalyzing(null);
      setBand('wave');
      await hub.playFile();
    } catch (e) {
      setAnalyzing((a) => a && { ...a, error: e instanceof Error ? e.message : String(e) });
    }
  }, [hub]);

  const seekTo = useCallback((t: number) => {
    hub.transport?.seek(t);
    setPlayT(t);
  }, [hub]);

  const surprise = useCallback(() => {
    variation.current++;
    directorRef.current.surprise(fileRef.current?.analysis ?? null, variation.current);
    setPaletteIdx(-1);
    force((x) => x + 1);
    flash('New visual identity');
  }, [flash]);

  const setWorld = useCallback((id: string) => {
    const engine = engineRef.current;
    if (!WORLDS.some((w) => w.id === id) || id === worldRef.current) return;
    if (engine) {
      if (!engine.hasWorld(id)) engine.register(WORLDS.find((w) => w.id === id)!.create());
      const dir = directorRef.current;
      engine.transition(worldRef.current, id, dir.paramsIdle(), performance.now() / 1000);
    }
    worldRef.current = id;
    setWorldState(id);
    setPrefs((p) => ({ ...p, world: id }));
  }, []);

  const applyProposal = useCallback((d: ArtDirection) => {
    const dir = directorRef.current;
    dir.settings.seed = d.seed;
    dir.settings.camera = ['orbit', 'dolly', 'locked', 'handheld', 'flythrough'].indexOf(d.camera) % 3;
    dir.settings.complexity = d.complexity;
    dir.setPalette(d.palette);
    if (fileRef.current) dir.planFor(fileRef.current.analysis);
    setPaletteIdx(-1);
    setWorld(d.family);
  }, [setWorld]);

  const applyProposalRef = useRef(applyProposal);
  applyProposalRef.current = applyProposal;

  const choosePalette = (i: number) => {
    setPaletteIdx(i);
    directorRef.current.setPalette(PALETTES[i] ?? SIGNATURE);
  };
  const choosePaletteRef = useRef(choosePalette);
  choosePaletteRef.current = (i: number) => {
    // remote palette indices map to the shared remote set
    setPaletteIdx(-1);
    directorRef.current.setPalette(REMOTE_PALETTES[i] ?? SIGNATURE);
  };

  const saveWorld = () => {
    const d = directorRef.current.settings;
    const w: SavedWorld = { id: `${Date.now()}`, name: `${d.palette.name} ${SHAPES[(d.seed >>> 3) % 4]}`, seed: d.seed, palette: d.palette, camera: d.camera, intensity: d.intensity, savedAt: Date.now() };
    const next = [w, ...worlds].slice(0, 12);
    setWorlds(next);
    saveWorlds(next);
    flash('World saved on this device');
  };

  const loadWorld = (w: SavedWorld) => {
    const d = directorRef.current;
    d.settings.seed = w.seed;
    d.settings.camera = w.camera;
    d.setPalette(w.palette);
    if (fileRef.current) d.planFor(fileRef.current.analysis);
    setPrefs((p) => ({ ...p, intensity: w.intensity }));
    flash(`Loaded ${w.name}`);
  };

  const toggleFullscreen = useCallback(() => {
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => flash('Full screen isn’t available here'));
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else flash('On iPhone, add PulseForm to your Home Screen for full screen');
  }, [flash]);

  // ---------- connected devices ----------
  const startSession = useCallback(async () => {
    setSessionError(null);
    try {
      const h = await SessionHost.create(location.origin, `${navigator.platform?.includes('Win') ? 'Windows PC' : 'Desktop'} · PulseForm`);
      h.onChange = () => hostTick((x) => x + 1);
      hostRef.current = h;
      setHost(h);
      // phones need the computer's network address, not localhost
      let origin = location.origin;
      try {
        const a = await api<{ addresses: string[]; port: number; secure: boolean }>(location.origin, '/api/addresses');
        if (/localhost|127\.0\.0\.1/.test(location.hostname) && a.addresses[0]) origin = `${a.secure ? 'https' : 'http'}://${a.addresses[0]}:${a.port}`;
      } catch {
        /* keep current origin */
      }
      setPairUrl(`${origin}/?join=${h.code}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSessionError(/404|not found|Failed to fetch|JSON/i.test(msg) ? 'Pairing needs the PulseForm session server. Start it with “npm run serve”.' : msg);
    }
  }, []);

  const endSession = useCallback(() => {
    hostRef.current?.end();
    hostRef.current = null;
    setHost(null);
  }, []);

  useEffect(() => {
    if (host) setPairUrl((u) => u.replace(/join=\d{6}/, `join=${host.code}`));
  }, [host, host?.code]);

  // remote commands from paired phones
  useEffect(() => {
    if (!host) return;
    host.onCommand = async (c: Command) => {
      switch (c.cmd) {
        case 'listen':
          await listen();
          if (hub.status.kind === 'mic' && hub.status.state !== 'listening') throw new Error('message' in hub.status ? hub.status.message : 'Microphone did not start');
          if (hub.ctx?.state !== 'running') throw new Error('Click once on the desktop to allow audio, then try again.');
          break;
        case 'stop':
          stop();
          break;
        case 'play':
          await hub.playFile();
          break;
        case 'pause':
          hub.pauseFile();
          break;
        case 'seek':
          seekTo(c.value);
          break;
        case 'intensity':
          setPrefs((p) => ({ ...p, intensity: Math.min(1.3, Math.max(0.2, c.value)) }));
          break;
        case 'palette':
          choosePaletteRef.current(c.value);
          break;
        case 'surprise':
          surprise();
          break;
        case 'world':
          setWorld(c.value);
          break;
        case 'reducedMotion':
          setPrefs((p) => ({ ...p, reducedMotion: c.value }));
          break;
        case 'photosensitive':
          setPrefs((p) => ({ ...p, photosensitive: c.value }));
          break;
      }
    };
  }, [host, hub, listen, stop, seekTo, surprise, setWorld]);

  // stream analysis to paired devices at 30 Hz, independent of the local frame rate
  useEffect(() => {
    if (!host) return;
    const s = emptyState();
    const t = window.setInterval(() => {
      const st = hub.status;
      if (st.kind === 'file' && fileRef.current && hub.transport) fileRef.current.timeline.stateAt(hub.transport.currentTime, s);
      else if (hub.analyzer && st.kind === 'mic' && st.state === 'listening') hub.analyzer.stateAt(hub.audioTime, s);
      else Object.assign(s, stateRef.current);
      host.tick(s, lastShapes.current);
    }, 1000 / 30);
    return () => window.clearInterval(t);
  }, [host, hub]);

  // keep paired devices up to date
  useEffect(() => {
    if (!host) return;
    const t = window.setInterval(() => {
      const d = directorRef.current.settings;
      const pr = prefsRef.current;
      host.setScene({ world: worldRef.current, stage: pr.stage, seed: d.seed, colors: [...d.palette.colors], paletteName: d.palette.name, camera: d.camera, complexity: d.complexity, intensity: pr.intensity, reducedMotion: pr.reducedMotion, photosensitive: pr.photosensitive });
      const st = hub.status;
      const txt = statusText(st, hub.analyzer?.stats.silent ?? true);
      host.setStatus({
        source: txt.text,
        tone: txt.tone,
        canPlay: st.kind === 'file',
        playing: st.kind === 'file' && st.state === 'playing',
        listening: st.kind === 'mic' && st.state === 'listening',
        duration: hub.transport?.duration ?? null,
        position: hub.transport ? Math.round(hub.transport.currentTime) : null,
        trackName: st.kind === 'file' ? st.name : null,
      });
    }, 250);
    return () => window.clearInterval(t);
  }, [host, hub]);

  useEffect(() => () => hostRef.current?.end(), []);

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === ' ') {
        e.preventDefault();
        togglePrimary();
      } else if (e.key === 'f') toggleFullscreen();
      else if (e.key === 's') surprise();
      else if (e.key === 'Escape') setSheet(null);
      else if (e.key === 'ArrowRight' && hub.transport) seekTo(hub.transport.currentTime + 5);
      else if (e.key === 'ArrowLeft' && hub.transport) seekTo(hub.transport.currentTime - 5);
      else if (e.key === 'd') setPrefs((p) => ({ ...p, diagnostics: !p.diagnostics }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePrimary, toggleFullscreen, surprise, seekTo, hub]);

  // ---------- render ----------
  const st = statusText(status, silent);
  const isFile = status.kind === 'file';
  const listening = (status.kind === 'mic' && status.state === 'listening') || status.kind === 'companion';
  const playing = isFile && status.state === 'playing';
  const showIntro = !active && !isFile && !analyzing && status.kind !== 'companion';
  introRef.current = showIntro;
  const micError = status.kind === 'mic' && ['denied', 'unavailable', 'lost', 'error'].includes(status.state);

  const onBandPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isFile || band !== 'wave' || !fileInfo) return;
    const r = e.currentTarget.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * fileInfo.duration;
    if (e.type === 'pointerdown' || (e.buttons & 1)) seekTo(t);
    setHoverT(t);
  };

  return (
    <div className={`app${idle ? ' idle' : ''}${prefs.diagnostics ? ' diag-on' : ''}`}>
      <canvas ref={artRef} className="art" aria-label={`Audio-reactive visual: ${worldName(world)}`} role="img" />
      {glError && (
        <div className="gl-error" role="alert">
          <h2>Graphics unavailable</h2>
          <p>{glError} PulseForm needs WebGL 2. Try an up-to-date Chrome, Edge or Safari.</p>
        </div>
      )}

      <header className="topbar chrome">
        <div className="wordmark"><Mark /><span>PulseForm</span></div>
        <div className={`status-pill ${st.tone}`} role="status" aria-live="polite">
          <i aria-hidden />
          <span>{st.text}</span>
        </div>
        <div className="top-actions">
          <button className="icon-btn" onClick={toggleFullscreen} aria-label="Full screen (F)"><IconExpand /></button>
        </div>
      </header>

      {showIntro && (
        <section className="intro" aria-labelledby="intro-title">
          <h1 id="intro-title">See what you hear.</h1>
          <p>Play music nearby and PulseForm listens through your microphone. Or play a song file.</p>
          <div className="intro-actions">
            <button className="btn listen-btn" onClick={() => void listen()} data-testid="listen">
              <span className="pulse-dot" aria-hidden />Listen
            </button>
            <button className="btn ghost" onClick={() => fileInput.current?.click()} data-testid="choose-file">
              <IconUpload />Play a song file
            </button>
          </div>
          {micError && <p className="intro-error" role="alert">{(status as { message: string }).message}</p>}
          <p className="fineprint">Audio is analyzed on this device. Nothing is recorded or uploaded.</p>
        </section>
      )}

      <section className="band chrome-soft" aria-label={band === 'wave' ? (isFile ? 'Song waveform and position' : 'Live waveform') : 'Frequency spectrum'}>
        <div className="band-head">
          <div className="seg small" role="group" aria-label="Bottom view">
            <button aria-pressed={band === 'wave'} onClick={() => setBand('wave')}>Waveform</button>
            <button aria-pressed={band === 'spectrum'} onClick={() => setBand('spectrum')}>Spectrum</button>
          </div>
          {isFile && fileInfo ? (
            <div className="time-row"><span className="time">{fmtTime(playT)}</span><span className="time dim">{fmtTime(fileInfo.duration)}</span></div>
          ) : (
            <div className="time-row"><span className="band-note">{band === 'wave' ? 'Last 6 seconds' : '30 Hz – 16 kHz'}</span></div>
          )}
        </div>
        <div
          className={`band-canvas${isFile && band === 'wave' ? ' seekable' : ''}`}
          onPointerDown={onBandPointer}
          onPointerMove={onBandPointer}
          onPointerLeave={() => setHoverT(null)}
          role={isFile && band === 'wave' ? 'slider' : undefined}
          aria-label={isFile ? 'Seek' : undefined}
          aria-valuemin={isFile ? 0 : undefined}
          aria-valuemax={isFile ? fileInfo?.duration : undefined}
          aria-valuenow={isFile ? Math.round(playT) : undefined}
          tabIndex={isFile ? 0 : -1}
          onKeyDown={(e) => {
            if (!hub.transport) return;
            if (e.key === 'ArrowRight') seekTo(hub.transport.currentTime + 5);
            if (e.key === 'ArrowLeft') seekTo(hub.transport.currentTime - 5);
          }}
        >
          <canvas ref={bandRef} />
          {hoverT !== null && isFile && band === 'wave' && fileInfo && (
            <span className="hover-time" style={{ left: `${(hoverT / fileInfo.duration) * 100}%` }}>{fmtTime(hoverT)}</span>
          )}
        </div>
      </section>

      <nav className="dock chrome" aria-label="Player controls">
        <button className="icon-btn" onClick={() => setSheet(sheet === 'source' ? null : 'source')} aria-label="Audio source" aria-expanded={sheet === 'source'}>
          <svg className="i" viewBox="0 0 24 24" aria-hidden><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></svg>
        </button>
        <button className="icon-btn" onClick={() => setSheet(sheet === 'visual' ? null : 'visual')} aria-label="Change visual" aria-expanded={sheet === 'visual'}><IconSparkle /></button>
        <button hidden={showIntro} className={`primary-btn${listening || playing ? ' on' : ''}`} onClick={togglePrimary} data-testid="primary" aria-label={isFile ? (playing ? 'Pause' : 'Play') : listening ? 'Stop listening' : 'Listen'}>
          {isFile ? (playing ? <IconPause /> : <IconPlay />) : listening ? <span className="stop-sq" aria-hidden /> : <span className="pulse-dot" aria-hidden />}
          <span>{isFile ? (playing ? 'Pause' : 'Play') : listening ? 'Stop' : 'Listen'}</span>
        </button>
        <label className="intensity" title="Visual intensity">
          <span className="sr-only">Visual intensity</span>
          <input type="range" min={0.2} max={1.3} step={0.01} value={prefs.intensity} onChange={(e) => setPrefs((p) => ({ ...p, intensity: Number(e.target.value) }))} aria-label="Visual intensity" />
        </label>
        {isFile && (
          <button className="icon-btn" onClick={() => setSheet(sheet === 'export' ? null : 'export')} aria-label="Export video" aria-expanded={sheet === 'export'} data-testid="export-open"><IconExport /></button>
        )}
        <button className="icon-btn" onClick={() => setSheet(sheet === 'connect' ? null : 'connect')} aria-label="Connect a display" aria-expanded={sheet === 'connect'}>
          <svg className="i" viewBox="0 0 24 24" aria-hidden><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /><path d="M12 16v4" /></svg>
        </button>
        <button className="icon-btn" onClick={() => setSheet(sheet === 'settings' ? null : 'settings')} aria-label="Settings" aria-expanded={sheet === 'settings'}><IconSliders /></button>
      </nav>

      <input ref={fileInput} type="file" accept={ACCEPTED} hidden onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f) void openFile(f);
      }} />

      {sheet && <div className="scrim" onClick={() => setSheet(null)} aria-hidden />}

      {sheet === 'source' && (
        <div className="sheet" role="dialog" aria-label="Audio source">
          <div className="sheet-head"><h2>Audio source</h2><button className="icon-btn" onClick={() => setSheet(null)} aria-label="Close"><IconClose /></button></div>
          <button className={`source-row${status.kind === 'mic' ? ' current' : ''}`} onClick={() => void listen()}>
            <b>Microphone</b><span>Hears music playing out loud near this device. Room noise affects the result.</span>
          </button>
          <button className={`source-row${isFile ? ' current' : ''}`} onClick={() => fileInput.current?.click()}>
            <b>Song file</b><span>A file you own, analyzed on this device. Full waveform, seeking and export.</span>
          </button>
          <button className={`source-row${status.kind === 'companion' ? ' current' : ''}`} onClick={() => { setSheet(null); void hub.startCompanion(); }} data-testid="source-companion">
            <b>Windows companion</b><span>Reacts to the sound your PC is playing, from apps that allow it. Needs PulseForm Companion running on this PC. Protected audio stays silent.</span>
          </button>
          <div className="source-row disabled" aria-disabled>
            <b>Paired desktop</b><span>For headphone listening on iPhone: receive the analysis from your desktop. No audio is sent between devices.</span>
          </div>
          <p className="fineprint left">PulseForm can’t read audio inside Spotify, Apple Music or other apps. It reacts only to sources listed here.</p>
        </div>
      )}

      {sheet === 'visual' && (
        <div className="sheet" role="dialog" aria-label="Change visual">
          <div className="sheet-head"><h2>Visual</h2><button className="icon-btn" onClick={() => setSheet(null)} aria-label="Close"><IconClose /></button></div>
          {proposals.length > 0 && (
            <>
              <h4>Suggested for this song</h4>
              <div className="proposals-row">
                {proposals.map((d, i) => (
                  <button key={d.id} className={`proposal${world === d.family && directorRef.current.settings.seed === d.seed ? ' current' : ''}`} onClick={() => applyProposal(d)} data-testid={`proposal-${i}`}>
                    <ProposalPreview direction={d} file={fileRef.current} />
                    <span className="proposal-name">{FAMILY_INFO[d.family].name}{i === 0 && <i className="best">Best match</i>}</span>
                    <span className="proposal-why">{d.rationale[0]}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          <h4>World</h4>
          <div className="world-grid" role="group" aria-label="Visual world">
            {WORLDS.map((w) => (
              <button key={w.id} className={`world${world === w.id ? ' current' : ''}`} aria-pressed={world === w.id} onClick={() => setWorld(w.id)} data-testid={`world-${w.id}`}>
                <span className="world-swatch" style={{ background: w.swatch }} />
                <span><b>{w.name}</b><small>{w.tagline}</small></span>
              </button>
            ))}
          </div>
          {world === 'festival' && (
            <>
              <h4>On the big screen</h4>
              <div className="seg stage-seg" role="group" aria-label="Stage screen content">
                {WORLDS.filter((w) => w.id !== 'festival').map((w) => (
                  <button key={w.id} aria-pressed={prefs.stage === w.id} onClick={() => setPrefs((p) => ({ ...p, stage: w.id }))}>{w.name.split(' ')[0]}</button>
                ))}
              </div>
            </>
          )}
          <h4>Colour</h4>
          <div className="palettes" role="group" aria-label="Palette">
            {PALETTES.map((p, i) => (
              <button key={i} aria-pressed={paletteIdx === i} aria-label={p.name} title={p.name} style={{ background: `linear-gradient(90deg, ${p.colors.slice(1).join(',')})` }} onClick={() => choosePalette(i)} />
            ))}
          </div>
          <div className="sheet-actions">
            <button className="btn" onClick={surprise}><IconShuffle />Surprise me</button>
            <button className="btn ghost" onClick={saveWorld}>Save this world</button>
          </div>
          {worlds.length > 0 && (
            <>
              <h4>Saved worlds</h4>
              <ul className="saved">
                {worlds.map((w) => (
                  <li key={w.id}>
                    <button onClick={() => loadWorld(w)}>
                      <i style={{ background: `linear-gradient(90deg, ${w.palette.colors.slice(1).join(',')})` }} />
                      {w.name}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {sheet === 'settings' && (
        <div className="sheet" role="dialog" aria-label="Settings">
          <div className="sheet-head"><h2>Settings</h2><button className="icon-btn" onClick={() => setSheet(null)} aria-label="Close"><IconClose /></button></div>
          <Toggle label="Reduce motion" hint="Slower camera, gentler deformation, no shake." on={prefs.reducedMotion} set={(v) => setPrefs((p) => ({ ...p, reducedMotion: v }))} />
          <Toggle label="Photosensitivity: no flashes" hint="Removes all flashes. Flashes are always limited to 3 per second." on={prefs.photosensitive} set={(v) => setPrefs((p) => ({ ...p, photosensitive: v }))} />
          <Toggle label="Show diagnostics" hint="Frame rate, render scale and audio-to-visual latency." on={prefs.diagnostics} set={(v) => setPrefs((p) => ({ ...p, diagnostics: v }))} />
          <div className="field">
            <label>Graphics quality</label>
            <div className="seg" role="group" aria-label="Graphics quality">
              {(['auto', 0, 1, 2, 3] as const).map((q) => (
                <button key={String(q)} aria-pressed={prefs.quality === q} onClick={() => setPrefs((p) => ({ ...p, quality: q }))}>{q === 'auto' ? 'Auto' : ['Low', 'Medium', 'High', 'Ultra'][q]}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {sheet === 'connect' && (
        <div className="sheet" role="dialog" aria-label="Connect a display">
          <div className="sheet-head"><h2>Connect a device</h2><button className="icon-btn" onClick={() => setSheet(null)} aria-label="Close"><IconClose /></button></div>
          {!host ? (
            <>
              <p className="sheet-p">Use your phone as a remote, or show the visual full screen on a TV browser. Devices receive analysis numbers only, never audio.</p>
              {sessionError && <p className="intro-error" role="alert">{sessionError}</p>}
              <div className="sheet-actions"><button className="btn primary" onClick={() => void startSession()} data-testid="start-session">Start pairing</button></div>
            </>
          ) : (
            <>
              {host.pending.map((r) => (
                <div className="join-req" key={r.peerId}>
                  <span>{r.device} wants to join as {r.role}</span>
                  <span style={{ display: 'flex', gap: 6 }}>
                    <button className="btn ghost" onClick={() => void host.approve(r.peerId, false)}>Deny</button>
                    <button className="btn primary" onClick={() => void host.approve(r.peerId, true)} data-testid="approve">Allow</button>
                  </span>
                </div>
              ))}
              <div className="pair-card">
                <div className="qr" aria-label="QR code to pair a phone" role="img" dangerouslySetInnerHTML={{ __html: pairUrl ? qrToSvg(encodeQR(pairUrl), 2) : '' }} />
                <div>
                  <div className="eyebrow">Pairing code</div>
                  <div className="pair-code" data-testid="pair-code">{host.code}</div>
                  <div className="pair-hint">Scan with your phone camera, or open <b>{pairUrl.replace(/\?.*/, '')}</b> on the TV and enter the code.</div>
                </div>
              </div>
              <h4>Connected</h4>
              {host.peers.size === 0 && <p className="sheet-p">No devices yet.</p>}
              {[...host.peers.values()].map((p) => (
                <div className="peer-row" key={p.peerId}>
                  <span>{p.device} · {p.role === 'display' ? 'Display' : p.role === 'viewer' ? 'Visualizer' : 'Remote'}</span>
                  <span className={`tag ${p.link}`}>{!p.online ? 'offline' : p.link === 'direct' ? 'direct' : p.link === 'relay' ? 'via server' : p.link}</span>
                </div>
              ))}
              <div className="sheet-actions">
                <button className="btn ghost" onClick={() => void host.refreshCode().then(() => hostTick((x) => x + 1))}>New code</button>
                <button className="btn ghost" onClick={endSession}>End session</button>
              </div>
            </>
          )}
        </div>
      )}

      {sheet === 'export' && fileRef.current && (
        <ExportSheet
          song={fileRef.current}
          world={world}
          stage={prefs.stage}
          director={{ ...directorRef.current.settings }}
          reducedMotion={prefs.reducedMotion}
          photosensitive={prefs.photosensitive}
          position={playT}
          onClose={() => setSheet(null)}
          onBusy={(busy) => {
            if (busy) hub.pauseFile();
          }}
        />
      )}

      {analyzing && (
        <div className="modal-wrap" role="dialog" aria-label="Preparing song">
          <div className="analyze-card">
            <div className="track-head">
              <div className="track-art" />
              <div style={{ minWidth: 0 }}>
                <div className="track-title">{analyzing.name}</div>
                <div className="track-meta">{analyzing.error ? 'Could not prepare this file' : 'Analyzing on this device'}</div>
              </div>
            </div>
            {analyzing.error ? (
              <>
                <p className="intro-error" role="alert">{analyzing.error}</p>
                <div className="sheet-actions"><button className="btn" onClick={() => setAnalyzing(null)}>Close</button></div>
              </>
            ) : (
              <ol className="stages">
                {STAGES.map((s, i) => {
                  const cur = STAGES.findIndex((x) => x.key === analyzing.stage);
                  const state = i < cur || (i === cur && analyzing.progress >= 1) ? 'done' : i === cur ? 'active' : '';
                  return (
                    <li key={s.key} className={`stage ${state}`} style={{ ['--p' as string]: `${Math.round((i === cur ? analyzing.progress : 0) * 100)}%` }}>
                      <span className="dot">{state === 'done' && <IconCheck />}</span>
                      <span>{s.label}</span>
                      <span className="detail">{analyzing.details[s.key] ?? (state === 'active' ? <span className="skeleton" style={{ display: 'inline-block', width: 64, height: 10 }} /> : '')}</span>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>
      )}

      {prefs.diagnostics && (
        <aside className="diag" aria-label="Diagnostics">
          <div><b>{diag.fps}</b> fps · {diag.ms.toFixed(1)} ms</div>
          <div>render {Math.round(diag.scale * 100)}% · tier {diag.tier}</div>
          <div>analysis {diag.afps}/s · +{diag.latency.toFixed(0)} ms</div>
          <div>output latency {diag.out.toFixed(0)} ms</div>
          <div>level {diag.level.toFixed(0)} dBFS · BPM {diag.bpm}</div>
          <div>flashes held back {diag.suppressed}</div>
        </aside>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function Toggle({ label, hint, on, set }: { label: string; hint: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <div className="toggle-row">
      <div><div className="toggle-label">{label}</div><div className="toggle-hint">{hint}</div></div>
      <button className="switch" role="switch" aria-checked={on} aria-label={label} onClick={() => set(!on)} />
    </div>
  );
}

/**
 * Animated preview of a proposal: renders a short flipbook of the song's most
 * intense moment in an offscreen engine, then loops it. Real frames, real audio
 * analysis — not a stock thumbnail.
 */
function ProposalPreview({ direction, file }: { direction: ArtDirection; file: FileSession | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const out = ref.current;
    if (!out || !file) return;
    let stop = false;
    let raf = 0;
    const frames: ImageBitmap[] = [];
    (async () => {
      const off = document.createElement('canvas');
      off.width = 240;
      off.height = 300;
      off.style.cssText = 'position:fixed;left:-9999px;width:240px;height:300px';
      document.body.appendChild(off);
      let engine: Engine | null = null;
      try {
        engine = new Engine(off);
        engine.settings.quality = 1;
        engine.settings.maxDpr = 1;
        engine.settings.frameOffset = 0;
        engine.register(WORLDS.find((w) => w.id === direction.family)!.create());
        const dir = new DirectorRuntime({ seed: direction.seed, palette: direction.palette, intensity: 1, complexity: direction.complexity, camera: 0 });
        dir.planFor(file.analysis);
        const a = file.analysis;
        const t0 = a.drops[0] ?? a.sections.reduce((b, s) => (s.energy > b.energy ? s : b), a.sections[0]).start;
        const s = emptyState();
        for (let i = 0; i < 16 && !stop; i++) {
          file.timeline.stateAt(t0 + 0.5 + i / 8, s);
          engine.render(direction.family, s, dir.paramsFile(s), i * 125);
          frames.push(await createImageBitmap(off));
          await new Promise((r) => setTimeout(r, 0));
        }
      } catch {
        /* preview is optional */
      } finally {
        engine?.dispose();
        off.remove();
      }
      const g = out.getContext('2d')!;
      let i = 0;
      let last = 0;
      const loop = (now: number) => {
        if (stop) return;
        raf = requestAnimationFrame(loop);
        if (now - last < 125 || !frames.length) return;
        last = now;
        out.width = 240;
        out.height = 300;
        g.drawImage(frames[i++ % frames.length], 0, 0);
      };
      raf = requestAnimationFrame(loop);
    })();
    return () => {
      stop = true;
      cancelAnimationFrame(raf);
      frames.forEach((f) => f.close());
    };
  }, [direction, file]);
  return <canvas ref={ref} className="proposal-canvas" aria-hidden />;
}
