/**
 * Sample-accurate audio transport built on AudioBufferSourceNode.
 * `currentTime` is derived from the AudioContext clock: the single source of
 * truth that every visual frame reads.
 */
export class AudioTransport {
  readonly ctx: AudioContext;
  readonly buffer: AudioBuffer;
  private src: AudioBufferSourceNode | null = null;
  readonly output: GainNode;
  private startedAt = 0; // ctx time when playback (re)started
  private offset = 0; // song time at startedAt
  private _playing = false;
  onEnded?: () => void;

  constructor(ctx: AudioContext, buffer: AudioBuffer) {
    this.ctx = ctx;
    this.buffer = buffer;
    this.output = ctx.createGain();
    this.output.connect(ctx.destination);
  }

  get duration(): number {
    return this.buffer.duration;
  }

  get playing(): boolean {
    return this._playing;
  }

  get currentTime(): number {
    if (!this._playing) return this.offset;
    // compensate output latency so visuals line up with what is heard
    const lat = (this.ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0;
    const t = this.offset + (this.ctx.currentTime - this.startedAt) - lat - this.ctx.baseLatency;
    return Math.min(Math.max(0, t), this.duration);
  }

  async play(): Promise<void> {
    if (this._playing) return;
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (this.offset >= this.duration - 0.05) this.offset = 0;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.output);
    src.onended = () => {
      if (this.src !== src) return;
      this._playing = false;
      this.offset = this.duration;
      this.src = null;
      this.onEnded?.();
    };
    this.startedAt = this.ctx.currentTime;
    src.start(0, this.offset);
    this.src = src;
    this._playing = true;
  }

  pause(): void {
    if (!this._playing) return;
    this.offset = Math.min(this.duration, this.offset + (this.ctx.currentTime - this.startedAt));
    this.stopSource();
    this._playing = false;
  }

  seek(t: number): void {
    const was = this._playing;
    if (was) this.stopSource();
    this._playing = false;
    this.offset = Math.min(Math.max(0, t), this.duration);
    if (was) void this.play();
  }

  setVolume(v: number): void {
    this.output.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  private stopSource() {
    const s = this.src;
    this.src = null;
    if (s) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    }
  }

  dispose(): void {
    this.stopSource();
    this.output.disconnect();
  }
}
