import { useCallback, useEffect, useRef, useState } from 'react';
import { Engine } from '../render/engine';
import { WORLDS } from '../render/worlds';
import { paletteToArray } from '../director/runtime';
import { SIGNATURE, REMOTE_PALETTES, fmtTime } from '../director/director';
import { emptyState, type VisualState } from '../timeline/timeline';
import { SessionGuest } from '../session/controllers';
import { api } from '../session/link';
import type { WorldParams } from '../render/world';
import { IconPlay, IconPause, IconShuffle, IconExpand, Mark } from './icons';

/**
 * Paired-device experience: TV display, phone remote, or phone viewer.
 * Renders from analysis received over the session; never touches audio.
 */

type Role = 'display' | 'remote' | 'viewer';

const isPhone = () => /iPhone|Android.+Mobile/i.test(navigator.userAgent) || Math.min(window.innerWidth, window.innerHeight) < 500;

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/SMART-TV|Tizen|Web0S|BRAVIA|AFT|CrKey|TV/i.test(ua)) return 'TV';
  return 'Browser';
}

const COLORS = REMOTE_PALETTES.map((p) => p.colors);

export function GuestApp() {
  const params = new URLSearchParams(location.search);
  const urlCode = params.get('join') ?? '';
  const urlRole = params.get('role') as Role | null;
  const [role, setRole] = useState<Role>(urlRole ?? (isPhone() ? 'remote' : 'display'));
  const [guest, setGuest] = useState<SessionGuest | null>(null);
  const [code, setCode] = useState(urlCode);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nearby, setNearby] = useState<Array<{ sessionId: string; name: string }>>([]);
  const [, force] = useState(0);
  const autoTried = useRef(false);

  const join = useCallback(async (opts: { code?: string; sessionId?: string }) => {
    setBusy(true);
    setError(null);
    try {
      const g = await SessionGuest.join(location.origin, { ...opts, role: role === 'viewer' ? 'viewer' : role, device: deviceName() });
      g.onChange = () => force((x) => x + 1);
      setGuest(g);
      try {
        sessionStorage.setItem('pulseform.guest', JSON.stringify({ role }));
      } catch {
        /* ignore */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [role]);

  // discovery: sessions on this local server
  useEffect(() => {
    if (guest) return;
    let stop = false;
    const poll = async () => {
      try {
        const r = await api<{ sessions: Array<{ sessionId: string; name: string }> }>(location.origin, '/api/sessions');
        if (!stop) setNearby(r.sessions);
      } catch {
        if (!stop) setNearby([]);
      }
    };
    void poll();
    const t = window.setInterval(poll, 3000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [guest]);

  useEffect(() => {
    if (urlCode.length === 6 && !autoTried.current) {
      autoTried.current = true;
      void join({ code: urlCode });
    }
  }, [urlCode, join]);

  useEffect(() => () => guest?.leave(), [guest]);

  if (guest && !guest.ended) {
    if (!guest.approved) {
      return (
        <div className="guest-pair">
          <Mark className="pair-mark" />
          <h1>Waiting for approval</h1>
          <p>Confirm “{deviceName()}” on {guest.hostName}.</p>
        </div>
      );
    }
    return role === 'remote' ? <Remote guest={guest} onView={() => setRole('viewer')} /> : <Display guest={guest} role={role} onRemote={() => setRole('remote')} />;
  }

  return (
    <div className="guest-pair">
      <Mark className="pair-mark" />
      <h1>{guest?.ended ? 'Session ended' : 'Connect to PulseForm'}</h1>
      <p>Enter the 6-digit code shown on your desktop under Connect display.</p>
      <form
        className="code-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.length === 6) void join({ code });
        }}
      >
        <input
          id="pair-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          aria-label="Pairing code"
          placeholder="000000"
        />
        <button className="btn primary" disabled={code.length !== 6 || busy} type="submit">{busy ? 'Connecting…' : 'Connect'}</button>
      </form>
      <div className="seg role-seg" role="group" aria-label="Use this device as">
        <button aria-pressed={role === 'remote'} onClick={() => setRole('remote')}>Remote</button>
        <button aria-pressed={role === 'display'} onClick={() => setRole('display')}>Display</button>
        <button aria-pressed={role === 'viewer'} onClick={() => setRole('viewer')}>Visualizer</button>
      </div>
      {error && <p className="intro-error" role="alert">{error}</p>}
      {nearby.length > 0 && (
        <div className="nearby">
          <h4>On this network</h4>
          {nearby.map((s) => (
            <button key={s.sessionId} className="source-row" onClick={() => void join({ sessionId: s.sessionId })}>
              <b>{s.name}</b>
              <span>Ask to join. Approve on the desktop.</span>
            </button>
          ))}
        </div>
      )}
      <p className="fineprint">Paired devices receive analysis numbers only. No audio is sent.</p>
    </div>
  );
}

function useArt(canvas: React.RefObject<HTMLCanvasElement | null>, guest: SessionGuest, frameOffset: number) {
  const stateRef = useRef<VisualState>(emptyState());
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    let engine: Engine;
    try {
      engine = new Engine(c);
    } catch {
      return;
    }
    engine.settings.frameOffset = frameOffset;
    const testDpr = (window as unknown as { __pfTest?: { dpr?: number } }).__pfTest?.dpr;
    if (testDpr) engine.settings.maxDpr = testDpr;
    let raf = 0;
    let palKey = '';
    let pal = paletteToArray(SIGNATURE);
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const s = guest.stateAt(now / 1000, stateRef.current);
      const sc = guest.scene;
      const key = sc?.colors.join(',') ?? '';
      if (sc && key !== palKey) {
        palKey = key;
        pal = paletteToArray({ name: sc.paletteName, colors: sc.colors as [string, string, string, string, string], background: '#000' });
      }
      engine.settings.reducedMotion = sc?.reducedMotion ?? false;
      engine.settings.photosensitive = sc?.photosensitive ?? false;
      const wid = WORLDS.some((w) => w.id === sc?.world) ? sc!.world : 'liquid';
      if (!engine.hasWorld(wid)) engine.register(WORLDS.find((w) => w.id === wid)!.create());
      const stageId = wid === 'festival' && sc?.stage && WORLDS.some((w) => w.id === sc.stage) ? sc.stage : null;
      if (stageId && !engine.hasWorld(stageId)) engine.register(WORLDS.find((w) => w.id === stageId)!.create());
      engine.settings.stageWorld = stageId;
      engine.render(wid, s, {
        seed: sc?.seed ?? 0x5eed1234,
        palette: pal,
        complexity: sc?.complexity ?? 0.7,
        intensity: sc?.intensity ?? 1,
        motionScale: 1,
        shapeA: guest.shapes.shapeA,
        shapeB: guest.shapes.shapeB,
        morph: guest.shapes.morph,
        camera: sc?.camera ?? 0,
      }, now);
    };
    raf = requestAnimationFrame(loop);
    (window as unknown as { pulseform: unknown }).pulseform = { guest, engine, state: stateRef };
    return () => {
      cancelAnimationFrame(raf);
      engine.dispose();
    };
  }, [canvas, guest, frameOffset]);
  return stateRef;
}

function linkLabel(g: SessionGuest): { text: string; tone: string } {
  const s = g.stats;
  if (g.ended) return { text: 'Session ended', tone: 'error' };
  if (s.link === 'direct' && !s.stale) return { text: `Connected · ${Math.round(s.rttMs)} ms`, tone: 'live' };
  if (s.link === 'relay' && !s.stale) return { text: 'Connected via server', tone: 'warn' };
  if (s.link === 'connecting') return { text: 'Connecting…', tone: 'idle' };
  return { text: 'Reconnecting…', tone: 'warn' };
}

function Display({ guest, role, onRemote }: { guest: SessionGuest; role: Role; onRemote: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useArt(ref, guest, role === 'viewer' ? 0.04 : 0);
  const [, tick] = useState(0);
  const [showUi, setShowUi] = useState(true);
  useEffect(() => {
    const t = window.setInterval(() => tick((x) => x + 1), 500);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    let timer = window.setTimeout(() => setShowUi(false), 4000);
    const wake = () => {
      setShowUi(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setShowUi(false), 4000);
    };
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
  }, []);
  const l = linkLabel(guest);
  const trouble = l.tone !== 'live';
  return (
    <div className={`app display-mode${showUi || trouble ? '' : ' idle'}`}>
      <canvas ref={ref} className="art" aria-label="Audio-reactive sculpture from the paired desktop" role="img" />
      <div className={`display-status status-pill ${l.tone}${trouble ? ' sticky' : ''}`} role="status" aria-live="polite">
        <i aria-hidden />
        <span>{trouble ? l.text : `${guest.hostName} · ${guest.status?.source ?? ''}`}</span>
      </div>
      {role === 'viewer' && (
        <div className="viewer-actions chrome">
          <button className="btn" onClick={onRemote}>Remote</button>
          <button className="icon-btn" aria-label="Full screen" onClick={() => void document.documentElement.requestFullscreen?.().catch(() => {})}><IconExpand /></button>
        </div>
      )}
    </div>
  );
}

function Remote({ guest, onView }: { guest: SessionGuest; onView: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    (window as unknown as { pulseform: unknown }).pulseform = { guest };
  }, [guest]);
  const [intensity, setIntensity] = useState(guest.scene?.intensity ?? 1);
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    const t = window.setInterval(() => tick((x) => x + 1), 250);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    if (guest.scene) setIntensity(guest.scene.intensity);
  }, [guest.scene?.intensity]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (label: string, body: Parameters<SessionGuest['command']>[0]) => {
    setPending(label);
    const ok = await guest.command(body);
    setPending(ok ? null : 'failed');
    if (!ok) window.setTimeout(() => setPending(null), 2000);
  };
  const st = guest.status;
  const sc = guest.scene;
  const l = linkLabel(guest);
  const canPlay = st?.canPlay;
  return (
    <div className="remote">
      <header className="remote-head">
        <div className="wordmark"><Mark /><span>PulseForm</span></div>
        <div className={`status-pill ${l.tone}`} role="status"><i aria-hidden /><span>{l.text}</span></div>
      </header>
      <section className="remote-now">
        <div className="eyebrow">{guest.hostName}</div>
        <div className="remote-source">{st?.source ?? 'Waiting for the desktop…'}</div>
        {st?.duration && st.position !== null && (
          <div className="remote-seek">
            <span className="time">{fmtTime(st.position)}</span>
            <input type="range" min={0} max={st.duration} step={0.5} value={st.position} aria-label="Seek" onChange={(e) => void send('seek', { cmd: 'seek', value: Number(e.target.value) })} />
            <span className="time dim">{fmtTime(st.duration)}</span>
          </div>
        )}
      </section>
      <button
        className={`remote-primary${st?.listening || st?.playing ? ' on' : ''}`}
        data-testid="remote-primary"
        onClick={() => {
          if (canPlay) void send('play', { cmd: st?.playing ? 'pause' : 'play' });
          else void send('listen', { cmd: st?.listening ? 'stop' : 'listen' });
        }}
        aria-label={canPlay ? (st?.playing ? 'Pause' : 'Play') : st?.listening ? 'Stop listening' : 'Listen'}
      >
        {canPlay ? (st?.playing ? <IconPause /> : <IconPlay />) : st?.listening ? <span className="stop-sq" aria-hidden /> : <span className="pulse-dot" aria-hidden />}
        <span>{canPlay ? (st?.playing ? 'Pause' : 'Play') : st?.listening ? 'Stop listening' : 'Listen'}</span>
      </button>
      <div className="remote-field">
        <label htmlFor="remote-intensity">Intensity <output>{Math.round(intensity * 100)}%</output></label>
        <input
          id="remote-intensity"
          type="range"
          min={0.2}
          max={1.3}
          step={0.01}
          value={intensity}
          onChange={(e) => {
            const v = Number(e.target.value);
            setIntensity(v);
            void send('intensity', { cmd: 'intensity', value: v });
          }}
        />
      </div>
      <div className="remote-field">
        <label>World</label>
        <div className="remote-worlds" role="group" aria-label="Visual world">
          {WORLDS.map((w) => (
            <button key={w.id} aria-pressed={sc?.world === w.id} onClick={() => void send('world', { cmd: 'world', value: w.id })} data-testid={`remote-world-${w.id}`}>
              <span className="world-swatch" style={{ background: w.swatch }} />
              {w.name}
            </button>
          ))}
        </div>
      </div>
      <div className="remote-field">
        <label>Colour</label>
        <div className="palettes" role="group" aria-label="Palette">
          {COLORS.map((c, i) => (
            <button key={i} aria-label={`Palette ${i + 1}`} aria-pressed={sc?.colors.join() === c.join()} style={{ background: `linear-gradient(90deg, ${c.slice(1, 5).join(',')})` }} onClick={() => void send('palette', { cmd: 'palette', value: i })} />
          ))}
        </div>
      </div>
      <div className="remote-row">
        <button className="btn" onClick={() => void send('surprise', { cmd: 'surprise' })}><IconShuffle />Surprise me</button>
        <button className="btn ghost" onClick={onView}>View on this phone</button>
      </div>
      <div className="remote-toggles">
        <label className="toggle-row">
          <span className="toggle-label">Reduce motion</span>
          <button className="switch" role="switch" aria-checked={!!sc?.reducedMotion} aria-label="Reduce motion" onClick={() => void send('rm', { cmd: 'reducedMotion', value: !sc?.reducedMotion })} />
        </label>
        <label className="toggle-row">
          <span className="toggle-label">No flashes</span>
          <button className="switch" role="switch" aria-checked={!!sc?.photosensitive} aria-label="No flashes" onClick={() => void send('ps', { cmd: 'photosensitive', value: !sc?.photosensitive })} />
        </label>
      </div>
      <footer className="remote-foot">
        {pending === 'failed' ? <span className="intro-error">The desktop didn’t respond. Check it’s still open.</span> : <span className="band-note">Last command {Math.round(guest.stats.lastCommandMs)} ms · link {guest.stats.link}</span>}
      </footer>
    </div>
  );
}
