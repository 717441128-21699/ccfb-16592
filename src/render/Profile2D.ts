import { createProgram } from './gl';
import type { BunkerDef } from '../physics/configs';
import type { FrameSnapshot, SandProps } from '../physics/types';

// ---------------------------------------------------------------------------
// 入沙剖面 2D 慢放：点精灵渲染沙粒，线带画沙面，四边形画杆头与球
// 坐标直接用物理世界的米制 (x,y)，用正交投影映射到裁剪空间
// ---------------------------------------------------------------------------

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
layout(location=1) in vec3 aColor;
layout(location=2) in float aSize;
uniform vec2 uScale;
uniform vec2 uOffset;
out vec3 vColor;
void main() {
  vec2 p = (aPos - uOffset) * uScale;
  gl_Position = vec4(p, 0.0, 1.0);
  gl_PointSize = aSize;
  vColor = aColor;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 frag;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float shade = 1.0 - r2 * 0.7;
  frag = vec4(vColor * shade, 1.0);
}`;

function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = (s / 100) * Math.min(l, 100 - l) / 100;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

export class Profile2D {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private posBuf: WebGLBuffer;
  private colBuf: WebGLBuffer;
  private sizeBuf: WebGLBuffer;
  private capacity = 0;
  private sandBase: [number, number, number];

  constructor(private canvas: HTMLCanvasElement, sand: SandProps, private bunker: BunkerDef) {
    const gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.prog = createProgram(gl, VERT, FRAG);
    this.sandBase = hsl(sand.hue, sand.saturation, sand.lightness);
    this.vao = gl.createVertexArray()!;
    this.posBuf = gl.createBuffer()!;
    this.colBuf = gl.createBuffer()!;
    this.sizeBuf = gl.createBuffer()!;
  }

  private ensureCap(n: number) {
    if (n <= this.capacity) return;
    const gl = this.gl;
    this.capacity = Math.max(n, 2048);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.capacity * 2 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.capacity * 3 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sizeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.capacity * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  /** 渲染一帧剖面 */
  render(snap: FrameSnapshot) {
    const gl = this.gl;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.floor(this.canvas.clientWidth * dpr);
    const H = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== W) { this.canvas.width = W; this.canvas.height = H; }
    gl.viewport(0, 0, W, H);
    gl.clearColor(0.05, 0.07, 0.1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const p = this.bunker.profile;
    // 视图窗口：x [-0.5, 1.1]，y [floorY-0.05, 0.55]
    const x0 = -0.5, x1 = 1.1;
    const y0 = p.floorY - 0.05, y1 = 0.55;
    const sx = 2 / (x1 - x0);
    const sy = 2 / (y1 - y0);
    const offX = (x0 + x1) / 2;
    const offY = (y0 + y1) / 2;
    const uScale = [sx, sy];
    const uOffset = [offX, offY];
    const toClip = (x: number, y: number): [number, number] => [(x - offX) * sx, (y - offY) * sy];

    this.drawSurface(toClip, p, x0, x1);
    this.drawLip(toClip);
    this.drawBallMarker(toClip);

    // 沙粒 + 球 + 杆头点
    const n = snap.grainCount;
    this.ensureCap(n + 2);
    const pos = new Float32Array((n + 2) * 2);
    const col = new Float32Array((n + 2) * 3);
    const sz = new Float32Array(n + 2);
    pos.set(snap.grains.subarray(0, n * 2), 0);
    for (let i = 0; i < n; i++) {
      const shade = 0.8 + ((i * 37) % 10) / 28;
      col[i * 3] = this.sandBase[0] * shade;
      col[i * 3 + 1] = this.sandBase[1] * shade;
      col[i * 3 + 2] = this.sandBase[2] * shade;
      sz[i] = 3.2 * dpr + ((i * 13) % 3) * 0.5;
    }
    // 球
    pos[n * 2] = snap.ballX; pos[n * 2 + 1] = snap.ballY;
    col[n * 3] = 0.95; col[n * 3 + 1] = 0.95; col[n * 3 + 2] = 0.92;
    sz[n] = 11 * dpr;
    // 杆头质心标记
    pos[(n + 1) * 2] = snap.clubX; pos[(n + 1) * 2 + 1] = snap.clubY;
    col[(n + 1) * 3] = 0.45; col[(n + 1) * 3 + 1] = 0.55; col[(n + 1) * 3 + 2] = 0.7;
    sz[n + 1] = 8 * dpr;

    gl.useProgram(this.prog);
    gl.uniform2fv(gl.getUniformLocation(this.prog, 'uScale'), uScale);
    gl.uniform2fv(gl.getUniformLocation(this.prog, 'uOffset'), uOffset);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, col);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sizeBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, sz);
    gl.drawArrays(gl.POINTS, 0, n + 2);

    this.drawClub(snap, toClip);
    this.drawLabels(toClip);
    gl.bindVertexArray(null);
  }

  private drawSurface(toClip: (x: number, y: number) => [number, number], p: BunkerDef['profile'], x0: number, x1: number) {
    const gl = this.gl;
    const verts: number[] = [];
    const N = 80;
    for (let i = 0; i <= N; i++) {
      const x = x0 + ((x1 - x0) * i) / N;
      const [cx, cy] = toClip(x, p.surfaceY(x));
      const [fx, fy] = toClip(x, p.floorY);
      verts.push(cx, cy, fx, fy);
    }
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    // 沙面填充（半透明）与底线
    const lines: number[] = [];
    for (let i = 0; i < N; i++) lines.push(verts[i * 2], verts[i * 2 + 1], verts[(i + 1) * 2], verts[(i + 1) * 2 + 1]);
    const lbuf = gl.createBuffer()!;
    const savedVao = this.vao;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, lbuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lines), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const prog = this.lineProgram();
    gl.useProgram(prog);
    gl.uniform3f(gl.getUniformLocation(prog, 'uColor'), this.sandBase[0], this.sandBase[1], this.sandBase[2]);
    gl.drawArrays(gl.LINES, 0, N * 2);
    gl.deleteBuffer(buf);
    gl.deleteBuffer(lbuf);
    gl.deleteVertexArray(vao);
    gl.bindVertexArray(savedVao);
  }

  private lineProgCache: WebGLProgram | null = null;
  private lineProgram(): WebGLProgram {
    if (this.lineProgCache) return this.lineProgCache;
    const gl = this.gl;
    this.lineProgCache = createProgram(
      gl,
      `#version 300 es
       precision highp float;
       layout(location=0) in vec2 aPos;
       void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`,
      `#version 300 es
       precision highp float;
       uniform vec3 uColor;
       out vec4 frag;
       void main(){ frag = vec4(uColor, 1.0); }`,
    );
    return this.lineProgCache;
  }

  private drawLip(toClip: (x: number, y: number) => [number, number]) {
    const gl = this.gl;
    const x = this.bunker.lipDistance;
    const yTop = this.bunker.profile.surfaceY(x);
    const [ax, ay] = toClip(x, this.bunker.profile.floorY);
    const [bx, by] = toClip(x, yTop);
    const vao = gl.createVertexArray()!;
    const buf = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([ax, ay, bx, by]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const prog = this.lineProgram();
    gl.useProgram(prog);
    gl.uniform3f(gl.getUniformLocation(prog, 'uColor'), 0.9, 0.4, 0.35);
    gl.lineWidth(2);
    gl.drawArrays(gl.LINES, 0, 2);
    gl.deleteBuffer(buf);
    gl.deleteVertexArray(vao);
    gl.bindVertexArray(this.vao);
  }

  private drawBallMarker(toClip: (x: number, y: number) => [number, number]) {
    // 球位 x=0 的竖直参考线
    const gl = this.gl;
    const [ax, ay] = toClip(0, this.bunker.profile.floorY);
    const [bx, by] = toClip(0, this.bunker.profile.surfaceY(0) + 0.1);
    const vao = gl.createVertexArray()!;
    const buf = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([ax, ay, bx, by]), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const prog = this.lineProgram();
    gl.useProgram(prog);
    gl.uniform3f(gl.getUniformLocation(prog, 'uColor'), 0.4, 0.45, 0.55);
    gl.drawArrays(gl.LINES, 0, 2);
    gl.deleteBuffer(buf);
    gl.deleteVertexArray(vao);
    gl.bindVertexArray(this.vao);
  }

  private drawClub(snap: FrameSnapshot, toClip: (x: number, y: number) => [number, number]) {
    const gl = this.gl;
    const c = Math.cos(snap.clubAngle), s = Math.sin(snap.clubAngle);
    // 与物理一致的楔形（简化），围绕质心
    const local = [
      [0.046, 0], [0.0, 0.031], [-0.046, 0.045], [-0.044, -0.019],
    ];
    const world = local.map(([lx, ly]) => {
      const wx = snap.clubX + lx * c - ly * s;
      const wy = snap.clubY + lx * s + ly * c;
      return toClip(wx, wy);
    });
    const order = [0, 1, 1, 2, 2, 3, 3, 0];
    const verts: number[] = [];
    for (const idx of order) verts.push(world[idx][0], world[idx][1]);
    const vao = gl.createVertexArray()!;
    const buf = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const prog = this.lineProgram();
    gl.useProgram(prog);
    gl.uniform3f(gl.getUniformLocation(prog, 'uColor'), 0.62, 0.72, 0.88);
    gl.lineWidth(2);
    gl.drawArrays(gl.LINES, 0, 8);
    gl.deleteBuffer(buf);
    gl.deleteVertexArray(vao);
    gl.bindVertexArray(this.vao);
  }

  private drawLabels(_toClip: (x: number, y: number) => [number, number]) {
    // 文字标签由 DOM 叠加层负责，这里留空
  }
}
