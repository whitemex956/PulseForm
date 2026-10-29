import { decodeState, encodeState, lerpState, type Command, type ControlMsg, type HostStatus, type SceneParams } from './protocol';
import { SessionLink, api, type LinkState, type SessionCreds } from './link';
import { emptyState, type VisualState } from '../timeline/timeline';

const hostNow = () => performance.now() / 1000;

export interface PeerInfo {
  peerId: string;
  role: string;
  device: string;
  link: LinkState;
  online: boolean;
}

/** Desktop side: owns the music analysis and broadcasts it. */
export class SessionHost {
  readonly link: SessionLink;
  code: string;
  codeExpiresAt: number;
  peers = new Map<string, PeerInfo>();
  pending: Array<{ peerId: string; role: string; device: string }> = [];
  private seq = 0;
  private lastSent = 0;
  private scene: SceneParams | null = null;
  private status: HostStatus | null = null;
  onChange?: () => void;
  onCommand?: (c: Command, from: string) => Promise<void> | void;
  stats = { framesSent: 0 };

  private constructor(creds: SessionCreds, code: string, exp: number) {
    this.code = code;
    this.codeExpiresAt = exp;
    this.link = new SessionLink(creds, {
      onState: () => {},
      onControl: (from, m) => void this.onControl(from, m),
      onLinkState: (pid, s) => {
        const p = this.peers.get(pid);
        if (p) p.link = s;
        if ((s === 'direct' || s === 'relay') && this.scene) {
          this.link.sendCtl(pid, { type: 'scene', scene: this.scene });
          if (this.status) this.link.sendCtl(pid, { type: 'status', status: this.status });
        }
        this.onChange?.();
      },
      onPeer: (e) => {
        if (e.type === 'join-request') this.pending.push({ peerId: e.peerId, role: e.role ?? 'remote', device: e.device ?? '' });
        else if (e.type === 'peer-left') this.peers.delete(e.peerId);
        else {
          const prev = this.peers.get(e.peerId);
          this.peers.set(e.peerId, {
            peerId: e.peerId,
            role: e.role ?? prev?.role ?? 'remote',
            device: e.device ?? prev?.device ?? '',
            link: prev?.link ?? 'connecting',
            online: e.type !== 'peer-offline',
          });
        }
        this.onChange?.();
      },
    });
  }

  static async create(base: string, name: string): Promise<SessionHost> {
    const r = await api<{ sessionId: string; peerId: string; token: string; code: string; codeExpiresAt: number; name: string }>(base, '/api/session', { name, device: 'desktop' });
    const h = new SessionHost({ base, sessionId: r.sessionId, peerId: r.peerId, token: r.token, name: r.name }, r.code, r.codeExpiresAt);
    h.link.open();
    return h;
  }

  async refreshCode(): Promise<void> {
    const r = await api<{ code: string; codeExpiresAt: number }>(this.link.creds.base, '/api/code', {}, this.link.creds.token);
    this.code = r.code;
    this.codeExpiresAt = r.codeExpiresAt;
    this.onChange?.();
  }

  async approve(peerId: string, allow: boolean): Promise<void> {
    await api(this.link.creds.base, '/api/approve', { peerId, allow }, this.link.creds.token);
    this.pending = this.pending.filter((p) => p.peerId !== peerId);
    this.onChange?.();
  }

  /** Call every render frame; sends at most 30 frames/s. */
  tick(s: VisualState, shapes: { shapeA: number; shapeB: number; morph: number }): void {
    const now = hostNow();
    // 0.8 tolerance: timer jitter must not halve the rate by skipping alternate ticks
    if (now - this.lastSent < 0.8 / 30 || this.link.links.size === 0) return;
    this.lastSent = now;
    this.link.broadcastState(encodeState(s, now, shapes, this.seq++));
    this.stats.framesSent++;
  }

  setScene(scene: SceneParams): void {
    if (JSON.stringify(scene) === JSON.stringify(this.scene)) return;
    this.scene = scene;
    this.link.broadcastCtl({ type: 'scene', scene });
  }

  setStatus(status: HostStatus): void {
    if (JSON.stringify(status) === JSON.stringify(this.status)) return;
    this.status = status;
    this.link.broadcastCtl({ type: 'status', status });
  }

  private async onControl(from: string, m: ControlMsg) {
    if (m.type === 'ping') this.link.sendCtl(from, { type: 'pong', id: m.id, t0: m.t0, t1: hostNow() });
    else if (m.type === 'cmd') {
      try {
        await this.onCommand?.(m.body, from);
        this.link.sendCtl(from, { type: 'ack', id: m.id, ok: true });
      } catch (e) {
        this.link.sendCtl(from, { type: 'ack', id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  end(): void {
    this.link.close(true);
  }
}

export interface GuestStats {
  link: LinkState;
  rttMs: number;
  offsetMs: number;
  /** how far behind the host's live analysis the rendered frame is */
  frameAgeMs: number;
  playoutMs: number;
  framesPerSecond: number;
  lastCommandMs: number;
  stale: boolean;
}

/** Phone / TV side: receives analysis and renders it in sync. */
export class SessionGuest {
  readonly link: SessionLink;
  readonly role: string;
  scene: SceneParams | null = null;
  status: HostStatus | null = null;
  approved: boolean;
  ended = false;
  private frames: Array<{ t: number; s: VisualState; shapeA: number; shapeB: number; morph: number }> = [];
  private offset = 0; // host clock − local clock (s)
  private samples: Array<{ rtt: number; offset: number }> = [];
  private pingId = 0;
  private pingTimer = 0;
  private cmdId = 0;
  private waiting = new Map<number, { t: number; resolve: (ok: boolean) => void }>();
  private recvTimes: number[] = [];
  private jitter = 0.01;
  private lastArrival = 0;
  readonly stats: GuestStats = { link: 'connecting', rttMs: 0, offsetMs: 0, frameAgeMs: 0, playoutMs: 80, framesPerSecond: 0, lastCommandMs: 0, stale: true };
  onChange?: () => void;
  shapes = { shapeA: 1, shapeB: 1, morph: 0 };

  private constructor(creds: SessionCreds, role: string, approved: boolean) {
    this.role = role;
    this.approved = approved;
    this.link = new SessionLink(creds, {
      onState: (_from, buf) => this.onFrame(buf),
      onControl: (_from, m) => this.onControl(m),
      onLinkState: (_pid, s) => {
        this.stats.link = s;
        this.onChange?.();
      },
      onSession: (e) => {
        if (e.type === 'approved') this.approved = true;
        if (e.type === 'rejected' || e.type === 'session-ended') this.ended = true;
        this.onChange?.();
      },
    });
    this.pingTimer = window.setInterval(() => this.ping(), 1000);
  }

  static async join(base: string, opts: { code?: string; sessionId?: string; role: string; device: string }): Promise<SessionGuest> {
    const r = await api<{ sessionId: string; peerId: string; token: string; approved: boolean; name: string }>(base, '/api/join', opts);
    const g = new SessionGuest({ base, sessionId: r.sessionId, peerId: r.peerId, token: r.token, name: r.name }, opts.role, r.approved);
    g.link.open();
    return g;
  }

  get hostName(): string {
    return this.link.creds.name;
  }

  private ping() {
    // staleness is tracked even when nothing renders (remote control mode)
    this.stats.stale = !this.lastArrival || performance.now() / 1000 - this.lastArrival > 1.5;
    this.onChange?.();
    if (this.stats.link === 'closed' || this.stats.link === 'connecting') return;
    this.link.sendCtl('host', { type: 'ping', id: ++this.pingId, t0: performance.now() / 1000 });
  }

  private onControl(m: ControlMsg) {
    if (m.type === 'pong') {
      const t2 = performance.now() / 1000;
      const rtt = t2 - m.t0;
      const offset = m.t1 - (m.t0 + rtt / 2);
      this.samples.push({ rtt, offset });
      if (this.samples.length > 12) this.samples.shift();
      // NTP-style: trust the sample with the smallest round trip
      const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      // slew rather than jump to avoid visible hitches
      this.offset = this.samples.length < 3 ? best.offset : this.offset + (best.offset - this.offset) * 0.3;
      this.stats.rttMs = best.rtt * 1000;
      this.stats.offsetMs = this.offset * 1000;
    } else if (m.type === 'scene') {
      this.scene = m.scene;
      this.onChange?.();
    } else if (m.type === 'status') {
      this.status = m.status;
      this.onChange?.();
    } else if (m.type === 'ack') {
      const w = this.waiting.get(m.id);
      if (w) {
        this.stats.lastCommandMs = (performance.now() - w.t);
        w.resolve(m.ok);
        this.waiting.delete(m.id);
      }
    }
  }

  private onFrame(buf: ArrayBuffer) {
    const s = emptyState();
    const f = decodeState(buf, s);
    if (!f) return;
    const now = performance.now() / 1000;
    if (this.lastArrival) {
      const gap = now - this.lastArrival;
      this.jitter = this.jitter * 0.95 + Math.abs(gap - 1 / 30) * 0.05;
    }
    this.lastArrival = now;
    this.stats.stale = false;
    this.recvTimes.push(now);
    while (this.recvTimes.length && now - this.recvTimes[0] > 1) this.recvTimes.shift();
    this.stats.framesPerSecond = this.recvTimes.length;
    this.frames.push({ t: f.hostTime, s, shapeA: f.shapeA, shapeB: f.shapeB, morph: f.morph });
    this.frames.sort((a, b) => a.t - b.t);
    while (this.frames.length > 60) this.frames.shift();
  }

  /** Interpolated state for local time `now` (performance.now()/1000). */
  stateAt(now: number, out: VisualState): VisualState {
    // playout delay: enough to cover network jitter, small enough to feel live
    const playout = Math.min(0.25, Math.max(0.05, 1 / 30 + 3 * this.jitter));
    this.stats.playoutMs = playout * 1000;
    const target = now + this.offset - playout;
    const fr = this.frames;
    const newest = fr[fr.length - 1];
    if (!newest) {
      this.stats.stale = true;
      return Object.assign(out, emptyState(), { intensity: 0.1, motion: now * 0.35, t: now });
    }
    const age = now + this.offset - newest.t;
    this.stats.frameAgeMs = age * 1000;
    this.stats.stale = age > 1.5;
    let i = fr.length - 1;
    while (i > 0 && fr[i].t > target) i--;
    const a = fr[i], b = fr[Math.min(fr.length - 1, i + 1)];
    if (b.t > a.t && target >= a.t && target <= b.t) lerpState(a.s, b.s, (target - a.t) / (b.t - a.t), out);
    else {
      Object.assign(out, newest.s);
      // keep drifting gently instead of freezing while frames are late
      out.motion = newest.s.motion + Math.max(0, target - newest.t) * 0.4;
    }
    this.shapes = { shapeA: b.shapeA, shapeB: b.shapeB, morph: b.morph };
    if (this.stats.stale) {
      // connection lost: fade toward a calm idle instead of a frozen frame
      const k = Math.min(1, (age - 1.5) / 2);
      out.intensity *= 1 - 0.85 * k;
      out.low *= 1 - k;
      out.mid *= 1 - k;
      out.high *= 1 - k;
      out.kick = out.snare = out.hat = out.transient = out.flash = 0;
    }
    out.t = now;
    out.duration = Infinity;
    return out;
  }

  command(body: Command): Promise<boolean> {
    const id = ++this.cmdId;
    return new Promise((resolve) => {
      this.waiting.set(id, { t: performance.now(), resolve });
      this.link.sendCtl('host', { type: 'cmd', id, body });
      window.setTimeout(() => {
        if (this.waiting.delete(id)) resolve(false);
      }, 5000);
    });
  }

  leave(): void {
    window.clearInterval(this.pingTimer);
    this.link.close(true);
  }
}
