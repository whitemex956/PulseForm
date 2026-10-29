/** Minimal WebGL2 helpers: programs, full-screen triangle, render targets. */

export function compile(gl: WebGL2RenderingContext, type: number, src: string, label: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh) ?? '';
    gl.deleteShader(sh);
    throw new Error(`${label} shader failed to compile:\n${log}`);
  }
  return sh;
}

export const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export class Program {
  readonly prog: WebGLProgram;
  private locs = new Map<string, WebGLUniformLocation | null>();
  constructor(private gl: WebGL2RenderingContext, fs: string, label: string, vs = FULLSCREEN_VS) {
    const p = gl.createProgram()!;
    const v = compile(gl, gl.VERTEX_SHADER, vs, `${label} vertex`);
    const f = compile(gl, gl.FRAGMENT_SHADER, fs, `${label} fragment`);
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(`${label} program failed to link: ${gl.getProgramInfoLog(p)}`);
    }
    this.prog = p;
  }
  use(): this {
    this.gl.useProgram(this.prog);
    return this;
  }
  loc(name: string): WebGLUniformLocation | null {
    if (!this.locs.has(name)) this.locs.set(name, this.gl.getUniformLocation(this.prog, name));
    return this.locs.get(name)!;
  }
  f(name: string, ...v: number[]): this {
    const l = this.loc(name);
    if (!l) return this;
    const gl = this.gl;
    if (v.length === 1) gl.uniform1f(l, v[0]);
    else if (v.length === 2) gl.uniform2f(l, v[0], v[1]);
    else if (v.length === 3) gl.uniform3f(l, v[0], v[1], v[2]);
    else gl.uniform4f(l, v[0], v[1], v[2], v[3]);
    return this;
  }
  fv3(name: string, data: Float32Array): this {
    const l = this.loc(name);
    if (l) this.gl.uniform3fv(l, data);
    return this;
  }
  i(name: string, v: number): this {
    const l = this.loc(name);
    if (l) this.gl.uniform1i(l, v);
    return this;
  }
  tex(name: string, unit: number, t: WebGLTexture): this {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    return this.i(name, unit);
  }
  dispose(): void {
    this.gl.deleteProgram(this.prog);
  }
}

export class Target {
  tex!: WebGLTexture;
  fbo!: WebGLFramebuffer;
  width = 0;
  height = 0;
  constructor(private gl: WebGL2RenderingContext, private hdr: boolean) {}
  resize(w: number, h: number): void {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (w === this.width && h === this.height && this.tex) return;
    const gl = this.gl;
    this.dispose();
    this.width = w;
    this.height = h;
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this.hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  bind(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
  }
  dispose(): void {
    if (this.tex) this.gl.deleteTexture(this.tex);
    if (this.fbo) this.gl.deleteFramebuffer(this.fbo);
  }
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  // sRGB -> linear for lighting math
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
}
