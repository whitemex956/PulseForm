import { LiveAnalyzer } from '../live/liveAnalyzer';
import type { LiveFrameMsg } from './live.worklet';
import { AudioTransport } from './player';

/**
 * Owns the AudioContext, the analysis worklet and whichever source is active.
 * Exactly one source feeds the analyzer at a time:
 *   mic      — getUserMedia, never routed to the speakers (no feedback)
 *   file     — AudioTransport playback, routed to speakers AND analyzer
 *   companion— frames arrive over localhost from the Windows companion
 */

export type SourceKind = 'none' | 'mic' | 'file' | 'companion' | 'remote';

export type SourceStatus =
  | { kind: 'none'; state: 'idle' }
  | { kind: 'mic'; state: 'requesting' | 'listening' | 'stopped' }
  | { kind: 'mic'; state: 'denied' | 'unavailable' | 'lost' | 'error'; message: string }
  | { kind: 'file'; state: 'ready' | 'playing' | 'paused' | 'ended'; name: string }
  | { kind: 'companion'; state: 'connecting' | 'connected' | 'lost'; message?: string }
  | { kind: 'remote'; state: 'receiving' | 'lost' };

type Listener = (s: SourceStatus) => void;

export class AudioHub {
  ctx: AudioContext | null = null;
  analyzer: LiveAnalyzer | null = null;
  /** analyzer matched to this page's AudioContext rate (mic and file) */
  private ctxAnalyzer: LiveAnalyzer | null = null;
  private node: AudioWorkletNode | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  transport: AudioTransport | null = null;
  private tapGain: GainNode | null = null;
  status: SourceStatus = { kind: 'none', state: 'idle' };
  private listeners = new Set<Listener>();
  private workletUrl: string;
  private onDeviceChange = () => this.checkMicHealth();

  constructor(workletUrl: string) {
    this.workletUrl = workletUrl;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  private set(s: SourceStatus) {
    this.status = s;
    this.listeners.forEach((l) => l(s));
  }

  /** Lazily create the context + worklet. Must be called from a user gesture on iOS. */
  async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      const Ctor: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      await this.ctx.audioWorklet.addModule(this.workletUrl);
      this.analyzer = this.ctxAnalyzer = new LiveAnalyzer(this.ctx.sampleRate);
      this.node = new AudioWorkletNode(this.ctx, 'pulseform-live-analyzer', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
      this.node.port.onmessage = (e: MessageEvent<LiveFrameMsg>) => {
        // worklet measurements only feed the analyzer while the worklet's own
        // input (mic or file playback) is the active source
        const k = this.status.kind;
        if (e.data?.type === 'frame' && this.ctx && (k === 'mic' || k === 'file' || k === 'none')) this.ctxAnalyzer?.push(e.data, this.ctx.currentTime);
      };
      this.tapGain = this.ctx.createGain();
      this.tapGain.connect(this.node);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    return this.ctx;
  }

  get audioTime(): number {
    return this.ctx?.currentTime ?? performance.now() / 1000;
  }

  // ---------------- microphone ----------------
  async startMic(): Promise<void> {
    this.stopAll();
    this.set({ kind: 'mic', state: 'requesting' });
    if (!navigator.mediaDevices?.getUserMedia) {
      this.set({ kind: 'mic', state: 'unavailable', message: window.isSecureContext ? 'This browser has no microphone access.' : 'Microphone needs a secure (https) connection.' });
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } },
        video: false,
      });
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError')
        this.set({ kind: 'mic', state: 'denied', message: 'Microphone access is blocked. Allow it in your browser’s site settings, then try again.' });
      else if (name === 'NotFoundError' || name === 'OverconstrainedError')
        this.set({ kind: 'mic', state: 'unavailable', message: 'No microphone was found. Connect one and try again.' });
      else if (name === 'NotSupportedError')
        this.set({ kind: 'mic', state: 'unavailable', message: 'This browser can’t provide microphone access here. Try Chrome, Edge or Safari.' });
      else if (name === 'NotReadableError')
        this.set({ kind: 'mic', state: 'error', message: 'Another app is using the microphone. Close it and try again.' });
      else this.set({ kind: 'mic', state: 'error', message: 'The microphone could not start.' });
      return;
    }
    const ctx = await this.ensureContext();
    this.micStream = stream;
    this.micSource = ctx.createMediaStreamSource(stream);
    this.micSource.connect(this.tapGain!); // analyzer only — never to speakers
    this.node?.port.postMessage({ type: 'reset' });
    for (const tr of stream.getAudioTracks()) {
      tr.addEventListener('ended', () => {
        if (this.micStream === stream) {
          this.teardownMic();
          this.set({ kind: 'mic', state: 'lost', message: 'The microphone stopped (permission revoked or device unplugged).' });
        }
      });
      tr.addEventListener('mute', () => this.checkMicHealth());
    }
    navigator.mediaDevices.addEventListener?.('devicechange', this.onDeviceChange);
    this.set({ kind: 'mic', state: 'listening' });
  }

  private checkMicHealth() {
    const tr = this.micStream?.getAudioTracks()[0];
    if (this.status.kind === 'mic' && this.status.state === 'listening' && tr && tr.readyState === 'ended') {
      this.teardownMic();
      this.set({ kind: 'mic', state: 'lost', message: 'The microphone was disconnected.' });
    }
  }

  private teardownMic() {
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.onDeviceChange);
    this.micSource?.disconnect();
    this.micSource = null;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
  }

  stopCompanionSource(): void {
    if (this.status.kind !== 'companion') return;
    this.stopCompanion();
    this.set({ kind: 'none', state: 'idle' });
  }

  stopMic(): void {
    if (this.status.kind !== 'mic') return;
    this.teardownMic();
    void this.ctx?.suspend(); // analysis stops: the worklet no longer runs
    this.set({ kind: 'mic', state: 'stopped' });
  }

  // ---------------- file ----------------
  async loadFile(buffer: AudioBuffer, name: string): Promise<AudioTransport> {
    this.stopAll();
    const ctx = await this.ensureContext();
    const tr = new AudioTransport(ctx, buffer);
    tr.output.connect(this.tapGain!);
    tr.onEnded = () => this.set({ kind: 'file', state: 'ended', name });
    this.transport = tr;
    this.node?.port.postMessage({ type: 'reset' });
    this.set({ kind: 'file', state: 'ready', name });
    return tr;
  }

  async playFile(): Promise<void> {
    if (!this.transport || this.status.kind !== 'file') return;
    await this.ensureContext();
    await this.transport.play();
    this.set({ kind: 'file', state: 'playing', name: this.status.name });
  }

  pauseFile(): void {
    if (!this.transport || this.status.kind !== 'file') return;
    this.transport.pause();
    this.set({ kind: 'file', state: 'paused', name: this.status.name });
  }

  // ---------------- Windows companion ----------------
  private companion: EventSource | null = null;
  companionUrl = 'http://127.0.0.1:7531';

  /**
   * Connect to the Windows companion on this computer. It sends measurements
   * (never audio) captured with WASAPI loopback.
   */
  async startCompanion(): Promise<void> {
    this.stopAll();
    const ctx = await this.ensureContext();
    this.set({ kind: 'companion', state: 'connecting' });
    let connected = false;
    let analyzerRate = 0;
    const es = new EventSource(`${this.companionUrl}/stream`);
    this.companion = es;
    const failTimer = window.setTimeout(() => {
      if (!connected && this.companion === es) {
        es.close();
        this.companion = null;
        this.set({ kind: 'companion', state: 'lost', message: 'The Windows companion isn’t running. Start PulseForm Companion on this PC, then try again.' });
      }
    }, 4000);
    es.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'hello') {
        connected = true;
        window.clearTimeout(failTimer);
        if (analyzerRate !== m.sampleRate) {
          // measurements are per hop at the companion's sample rate
          analyzerRate = m.sampleRate;
          this.analyzer = new LiveAnalyzer(m.sampleRate);
        }
        this.set({ kind: 'companion', state: 'connected', message: m.device });
        return;
      }
      if (m.type !== 'frame' || !this.analyzer) return;
      // place the frame on this page's audio clock
      const t = ctx.currentTime - (m.age ?? 0);
      this.analyzer.push({ ...m, t, bands: Float32Array.from(m.bands), wave: Float32Array.from(m.wave) }, ctx.currentTime);
    };
    es.onerror = () => {
      if (this.companion !== es) return;
      if (connected) this.set({ kind: 'companion', state: 'lost', message: 'Lost the Windows companion. Reconnecting…' });
      // EventSource retries automatically; a later 'hello' restores 'connected'
    };
  }

  private stopCompanion() {
    this.companion?.close();
    this.companion = null;
    if (this.ctxAnalyzer) this.analyzer = this.ctxAnalyzer;
  }

  // ---------------- companion / remote ----------------
  setExternal(s: SourceStatus): void {
    this.set(s);
  }

  /** Accept frames from a non-worklet source (companion) into the same analyzer. */
  async pushExternal(frame: LiveFrameMsg): Promise<void> {
    if (!this.analyzer) {
      await this.ensureContext();
    }
    this.analyzer?.push(frame, frame.t);
  }

  stopAll(): void {
    this.teardownMic();
    this.stopCompanion();
    if (this.transport) {
      this.transport.dispose();
      this.transport = null;
    }
    if (this.status.kind !== 'none') this.set({ kind: 'none', state: 'idle' });
  }

  dispose(): void {
    this.stopAll();
    this.node?.port.postMessage({ type: 'stop' });
    this.node?.disconnect();
    void this.ctx?.close();
    this.ctx = null;
  }
}
