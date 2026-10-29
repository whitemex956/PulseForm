import { b64ToBuf, bufToB64, type ControlMsg } from './protocol';

/**
 * Signalling client + one WebRTC link per remote peer.
 *
 * Each link has two data channels:
 *   "state" — unordered, maxRetransmits 0 (latest frame wins)
 *   "ctl"   — reliable, ordered (commands, scene params, clock pings)
 * If the direct channel cannot open within 8 s, or drops and cannot be
 * re-established, messages are relayed through the session server instead, so
 * the session keeps working (with more latency) rather than failing.
 */

export interface SessionCreds {
  base: string;
  sessionId: string;
  peerId: string;
  token: string;
  name: string;
}

export type LinkState = 'connecting' | 'direct' | 'relay' | 'reconnecting' | 'closed';

type ServerEvent =
  | { type: 'hello'; peerId: string; approved: boolean; name: string; peers: Array<{ peerId: string; role: string; device: string; online: boolean }> }
  | { type: 'msg'; from: string; data: SignalData }
  | { type: 'peer-joined' | 'peer-online'; peer?: { peerId: string; role: string; device: string }; peerId?: string; role?: string; device?: string }
  | { type: 'peer-offline' | 'peer-left'; peerId: string }
  | { type: 'join-request'; peer: { peerId: string; role: string; device: string } }
  | { type: 'approved'; name: string }
  | { type: 'rejected' }
  | { type: 'session-ended' };

type SignalData =
  | { kind: 'offer' | 'answer'; sdp: string; epoch: number }
  | { kind: 'ice'; candidate: RTCIceCandidateInit; epoch: number }
  | { kind: 'ctl'; msg: ControlMsg }
  | { kind: 'state'; b64: string }
  | { kind: 'restart' };

export async function api<T>(base: string, path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  return data as T;
}

export interface LinkHandlers {
  onState(from: string, buf: ArrayBuffer): void;
  onControl(from: string, msg: ControlMsg): void;
  onLinkState(peerId: string, s: LinkState): void;
  onPeer?(e: { type: string; peerId: string; role?: string; device?: string }): void;
  onSession?(e: { type: 'approved' | 'rejected' | 'session-ended' | 'server-lost' | 'server-ok' }): void;
}

const ICE: RTCConfiguration = { iceServers: [] }; // same-network only by default: no third-party STUN

class PeerLink {
  pc: RTCPeerConnection | null = null;
  state: RTCDataChannel | null = null;
  ctl: RTCDataChannel | null = null;
  status: LinkState = 'connecting';
  private epoch = 0;
  private openTimer = 0;
  private pendingIce: Array<{ epoch: number; c: RTCIceCandidateInit }> = [];

  constructor(private hub: SessionLink, readonly peerId: string, readonly initiator: boolean) {}

  /** Host: begin a new negotiation epoch. Guest: adopt the host's epoch. */
  start(nextEpoch = this.epoch + 1): void {
    (window as unknown as { __pfTest?: { log?: string[] } }).__pfTest?.log?.push(`${performance.now().toFixed(0)} ${this.initiator ? 'H' : 'G'} start e${nextEpoch}`);
    this.epoch = nextEpoch;
    this.teardown();
    const pc = new RTCPeerConnection(ICE);
    this.pc = pc;
    const epoch = this.epoch;
    pc.onicecandidate = (e) => {
      if (e.candidate && epoch === this.epoch) this.hub.signal(this.peerId, { kind: 'ice', candidate: e.candidate.toJSON(), epoch });
    };
    pc.onconnectionstatechange = () => {
      if (epoch !== this.epoch) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') this.degrade();
    };
    if (this.initiator) {
      this.attach(pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 }));
      this.attach(pc.createDataChannel('ctl', { ordered: true }));
      void (async () => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.hub.signal(this.peerId, { kind: 'offer', sdp: offer.sdp!, epoch });
      })();
    } else {
      pc.ondatachannel = (e) => this.attach(e.channel);
    }
    window.clearTimeout(this.openTimer);
    this.openTimer = window.setTimeout(() => {
      if (this.status !== 'direct') this.setStatus('relay');
    }, 8000);
  }

  private attach(ch: RTCDataChannel) {
    ch.binaryType = 'arraybuffer';
    if (ch.label === 'state') this.state = ch;
    else this.ctl = ch;
    ch.onopen = () => {
      if (this.state?.readyState === 'open' && this.ctl?.readyState === 'open') {
        window.clearTimeout(this.openTimer);
        this.setStatus('direct');
      }
    };
    ch.onclose = () => {
      if (this.pc && this.status === 'direct') this.degrade();
    };
    ch.onmessage = (e) => {
      if (ch.label === 'state') this.hub.handlers.onState(this.peerId, e.data as ArrayBuffer);
      else this.hub.handlers.onControl(this.peerId, JSON.parse(e.data as string));
    };
  }

  /** Direct link dropped: relay immediately, and retry the direct link. */
  private degrade() {
    if (this.status === 'closed') return;
    this.setStatus('relay');
    window.setTimeout(() => {
      if (this.status !== 'direct' && this.status !== 'closed' && this.initiator) this.start();
    }, 2500);
    if (!this.initiator) this.hub.signal(this.peerId, { kind: 'restart' });
  }

  private chain: Promise<void> = Promise.resolve();
  /** Signalling messages are handled strictly one at a time, in arrival order. */
  onSignal(d: SignalData): Promise<void> {
    this.chain = this.chain.then(() => this.handle(d)).catch(() => {});
    return this.chain;
  }

  private async handle(d: SignalData) {
    const dbg = (window as unknown as { __pfTest?: { log?: string[] } }).__pfTest?.log;
    dbg?.push(`${performance.now().toFixed(0)} ${this.initiator ? 'H' : 'G'} recv ${d.kind} e${'epoch' in d ? d.epoch : '-'} cur e${this.epoch} sig ${this.pc?.signalingState}`);
    if (d.kind === 'restart') {
      if (this.initiator) this.start();
      return;
    }
    if (d.kind === 'offer' && !this.initiator) {
      if (d.epoch < this.epoch) return; // stale
      if (d.epoch !== this.epoch || !this.pc) this.start(d.epoch);
      const pc = this.pc!;
      await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      this.hub.signal(this.peerId, { kind: 'answer', sdp: ans.sdp!, epoch: d.epoch });
      await this.flushIce();
    } else if (d.kind === 'answer' && this.initiator && d.epoch === this.epoch && this.pc) {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
      await this.flushIce();
    } else if (d.kind === 'ice') {
      // candidates can overtake the offer through the relay; keep them for their epoch
      if (d.epoch === this.epoch && this.pc?.remoteDescription) await this.pc.addIceCandidate(d.candidate).catch(() => {});
      else if (d.epoch >= this.epoch) this.pendingIce.push({ epoch: d.epoch, c: d.candidate });
    }
  }

  private async flushIce() {
    const keep: typeof this.pendingIce = [];
    for (const p of this.pendingIce) {
      if (p.epoch === this.epoch) await this.pc?.addIceCandidate(p.c).catch(() => {});
      else if (p.epoch > this.epoch) keep.push(p);
    }
    this.pendingIce = keep;
  }

  sendState(buf: ArrayBuffer): void {
    if (this.status === 'direct' && this.state?.readyState === 'open') {
      if (this.state.bufferedAmount < 64_000) this.state.send(buf);
    } else if (this.status === 'relay') {
      this.hub.relayState(this.peerId, buf);
    }
  }

  sendCtl(msg: ControlMsg): void {
    if (this.status === 'direct' && this.ctl?.readyState === 'open') this.ctl.send(JSON.stringify(msg));
    else this.hub.signal(this.peerId, { kind: 'ctl', msg });
  }

  setStatus(s: LinkState) {
    if (this.status === s) return;
    this.status = s;
    this.hub.handlers.onLinkState(this.peerId, s);
  }

  teardown() {
    this.state?.close();
    this.ctl?.close();
    this.pc?.close();
    this.pc = this.state = this.ctl = null;
  }

  close() {
    window.clearTimeout(this.openTimer);
    this.setStatus('closed');
    this.teardown();
  }
}

/** One participant's connection to a session: signalling + links to peers. */
export class SessionLink {
  readonly creds: SessionCreds;
  readonly handlers: LinkHandlers;
  readonly links = new Map<string, PeerLink>();
  private es: EventSource | null = null;
  private relayBudget = new Map<string, number>();
  readonly isHost: boolean;
  serverOk = true;

  constructor(creds: SessionCreds, handlers: LinkHandlers) {
    this.creds = creds;
    this.handlers = handlers;
    this.isHost = creds.peerId === 'host';
  }

  open(): void {
    const es = new EventSource(`${this.creds.base}/api/events?token=${encodeURIComponent(this.creds.token)}`);
    this.es = es;
    es.onmessage = (e) => void this.onEvent(JSON.parse(e.data) as ServerEvent);
    es.onerror = () => {
      // EventSource reconnects by itself; surface the state meanwhile
      if (this.serverOk) {
        this.serverOk = false;
        this.handlers.onSession?.({ type: 'server-lost' });
      }
      // token rejected (server restarted): stop retrying
      void api(this.creds.base, '/api/time').catch(() => {});
    };
    es.onopen = () => {
      if (!this.serverOk) {
        this.serverOk = true;
        this.handlers.onSession?.({ type: 'server-ok' });
      }
    };
  }

  private ensureLink(peerId: string): PeerLink {
    let l = this.links.get(peerId);
    if (!l) {
      // the host always initiates, so both sides agree who sends the offer
      l = new PeerLink(this, peerId, this.isHost);
      this.links.set(peerId, l);
      this.handlers.onLinkState(peerId, 'connecting');
    }
    return l;
  }

  private async onEvent(e: ServerEvent) {
    switch (e.type) {
      case 'hello':
        if (this.isHost) for (const p of e.peers) if (p.peerId !== 'host' && p.online) this.ensureLink(p.peerId).start();
        if (!this.isHost && e.approved) this.ensureLink('host');
        break;
      case 'peer-joined':
      case 'peer-online': {
        const pid = e.peer?.peerId ?? e.peerId!;
        this.handlers.onPeer?.({ type: e.type, peerId: pid, role: e.peer?.role ?? e.role, device: e.peer?.device ?? e.device });
        // negotiate once the guest is actually listening for signals
        if (this.isHost && pid !== 'host' && e.type === 'peer-online') this.ensureLink(pid).start();
        break;
      }
      case 'peer-offline':
      case 'peer-left': {
        this.handlers.onPeer?.({ type: e.type, peerId: e.peerId });
        const l = this.links.get(e.peerId);
        if (l && e.type === 'peer-left') {
          l.close();
          this.links.delete(e.peerId);
        } else l?.setStatus('reconnecting');
        break;
      }
      case 'join-request':
        this.handlers.onPeer?.({ type: 'join-request', peerId: e.peer.peerId, role: e.peer.role, device: e.peer.device });
        break;
      case 'approved':
        this.handlers.onSession?.({ type: 'approved' });
        this.ensureLink('host');
        break;
      case 'rejected':
      case 'session-ended':
        this.handlers.onSession?.({ type: e.type });
        this.close(false);
        break;
      case 'msg': {
        const d = e.data;
        if (d.kind === 'ctl') this.handlers.onControl(e.from, d.msg);
        else if (d.kind === 'state') this.handlers.onState(e.from, b64ToBuf(d.b64));
        else await this.ensureLink(e.from).onSignal(d);
        break;
      }
    }
  }

  signal(to: string, data: SignalData): void {
    void api(this.creds.base, '/api/send', { to, data }, this.creds.token).catch(() => {});
  }

  /** Relay is rate-limited to 15 frames/s to protect the server. */
  relayState(to: string, buf: ArrayBuffer): void {
    const now = performance.now();
    if (now - (this.relayBudget.get(to) ?? 0) < 66) return;
    this.relayBudget.set(to, now);
    this.signal(to, { kind: 'state', b64: bufToB64(buf) });
  }

  broadcastState(buf: ArrayBuffer): void {
    for (const l of this.links.values()) l.sendState(buf);
  }

  sendCtl(to: string, msg: ControlMsg): void {
    this.ensureLink(to).sendCtl(msg);
  }

  broadcastCtl(msg: ControlMsg): void {
    for (const l of this.links.values()) l.sendCtl(msg);
  }

  linkState(peerId: string): LinkState {
    return this.links.get(peerId)?.status ?? 'closed';
  }

  /** For tests: drop the direct connection to simulate a network hiccup. */
  breakDirect(peerId: string): void {
    const l = this.links.get(peerId);
    l?.pc?.close();
    l?.state?.close();
  }

  close(notify = true): void {
    if (notify) void api(this.creds.base, '/api/leave', {}, this.creds.token).catch(() => {});
    this.es?.close();
    for (const l of this.links.values()) l.close();
    this.links.clear();
  }
}
