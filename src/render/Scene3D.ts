import { createProgram, mat4LookAt, mat4Model, mat4Multiply, mat4Perspective, type Mat4 } from './gl';
import type { BunkerDef } from '../physics/configs';
import type { FrameSnapshot, LieType, SandProps, ShotOutcome } from '../physics/types';

// ---------------------------------------------------------------------------
// 3D 沙坑场景：地形网格 + 实例化沙粒 + 球 + 杆头 + 旗洞
// 2D 剖面 (x,y) 映射到 3D：x 为击球方向，y 为高度，z 为横向（按颗粒索引伪随机展开）
// ---------------------------------------------------------------------------

const TERRAIN_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
uniform mat4 uViewProj;
out vec3 vNormal;
out vec3 vColor;
out vec3 vWorld;
void main() {
  vNormal = aNormal;
  vColor = aColor;
  vWorld = aPos;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const TERRAIN_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vColor;
in vec3 vWorld;
uniform vec3 uSun;
out vec4 frag;
void main() {
  float lambert = max(dot(normalize(vNormal), normalize(uSun)), 0.0);
  float shade = 0.42 + 0.62 * lambert;
  // 远离球洞的草地区域轻微颜色变化
  frag = vec4(vColor * shade, 1.0);
}`;

const INSTANCE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aCorner;   // 单位立方体角
layout(location=1) in vec4 iTransform; // x, y, z, scale
layout(location=2) in vec3 iColor;
uniform mat4 uViewProj;
out vec3 vColor;
void main() {
  vec3 p = aCorner * iTransform.w + iTransform.xyz;
  vColor = iColor;
  gl_Position = uViewProj * vec4(p, 1.0);
}`;

const INSTANCE_FS = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 frag;
void main() { frag = vec4(vColor, 1.0); }`;

function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = (s / 100) * Math.min(l, 100 - l) / 100;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

export class Scene3D {
  private gl: WebGL2RenderingContext;
  private terrainProg: WebGLProgram;
  private instProg: WebGLProgram;
  private vao: Record<'terrain' | 'cube' | 'club', WebGLVertexArrayObject | null> = {
    terrain: null, cube: null, club: null,
  };
  private buffers: Record<string, WebGLBuffer> = {};
  private counts = { terrainV: 0, cube: 0, club: 0 };
  private bunker: BunkerDef | null = null;
  private sand: SandProps | null = null;
  private sandColor: [number, number, number] = [0.76, 0.66, 0.45];
  private grassColor: [number, number, number] = [0.26, 0.48, 0.2];
  private yaw = -0.5;
  private pitch = 0.42;
  private dist = 4.2;
  private grainData: Float32Array = new Float32Array(0);
  private grainColors: Float32Array = new Float32Array(0);
  private maxGrains = 0;
  private clubTransform = mat4Model(0, -10, 0);
  private pinX = 6;
  private pinY = 0;
  private raf = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.terrainProg = createProgram(gl, TERRAIN_VS, TERRAIN_FS);
    this.instProg = createProgram(gl, INSTANCE_VS, INSTANCE_FS);
    this.buildCube();
    this.buildClubMesh();
    this.bindInput();
  }

  private bindInput() {
    this.canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.yaw -= (e.clientX - this.lastX) * 0.006;
      this.pitch = Math.max(0.12, Math.min(1.1, this.pitch + (e.clientY - this.lastY) * 0.004));
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    this.canvas.addEventListener('pointerup', () => { this.dragging = false; });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = Math.max(2.2, Math.min(9, this.dist + e.deltaY * 0.003));
    }, { passive: false });
  }

  // ------------------------------------------------------------ 地形
  loadBunker(bunker: BunkerDef, sand: SandProps, pinDistance: number) {
    this.bunker = bunker;
    this.sand = sand;
    this.sandColor = hsl(sand.hue, sand.saturation, sand.lightness);
    this.pinX = bunker.lipDistance + pinDistance;
    this.pinY = bunker.profile.surfaceY(bunker.lipDistance);
    const gl = this.gl;
    const p = bunker.profile;
    const halfW = bunker.width / 2;
    const xStart = p.xMin - 0.8;
    const xEnd = this.pinX + 1.6;
    const zHalf = halfW + 1.4;
    const NX = 90;
    const NZ = 44;
    const heightAt = (x: number, z: number): number => {
      const inX = x >= p.xMin && x <= p.xMax;
      const inZ = Math.abs(z) <= halfW;
      if (inX && inZ) {
        const cross = 0.22 * Math.pow(Math.abs(z) / halfW, 2);
        return p.surfaceY(x) + cross;
      }
      // 坑外：向果岭/外围草地高度平滑过渡
      const greenY = this.pinY;
      const edgeX = x < p.xMin ? p.surfaceY(p.xMin) : greenY;
      const t = x < p.xMin
        ? Math.min(1, (p.xMin - x) / 1.2)
        : Math.min(1, (x - p.xMax) / 1.2);
      const edgeZ = Math.min(1, (Math.abs(z) - halfW) / 1.0);
      return edgeX + (greenY - edgeX) * Math.max(t, inX ? edgeZ : 0);
    };
    const verts: number[] = [];
    const idx: number[] = [];
    for (let iz = 0; iz <= NZ; iz++) {
      const z = -zHalf + (2 * zHalf * iz) / NZ;
      for (let ix = 0; ix <= NX; ix++) {
        const x = xStart + ((xEnd - xStart) * ix) / NX;
        const y = heightAt(x, z);
        // 法向量（有限差分）
        const e = 0.03;
        const nx = heightAt(x - e, z) - heightAt(x + e, z);
        const nz = heightAt(x, z - e) - heightAt(x, z + e);
        const nl = Math.hypot(nx, 2 * e, nz);
        const inSand = x >= p.xMin && x <= p.xMax && Math.abs(z) <= halfW;
        const col = inSand ? this.sandColor : this.grassColor;
        verts.push(x, y, z, nx / nl, (2 * e) / nl, nz / nl, col[0], col[1], col[2]);
      }
    }
    const row = NX + 1;
    for (let iz = 0; iz < NZ; iz++) {
      for (let ix = 0; ix < NX; ix++) {
        const a = iz * row + ix;
        idx.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
      }
    }
    this.counts.terrainV = idx.length;
    if (this.vao.terrain) gl.deleteVertexArray(this.vao.terrain);
    this.vao.terrain = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao.terrain);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    const stride = 9 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 6 * 4);
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(idx), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  // ------------------------------------------------------------ 实例立方体（沙粒/球/旗）
  private buildCube() {
    const gl = this.gl;
    const c = [
      [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
      [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
    ];
    const faces = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 5, 6, 1, 6, 2, 3, 2, 6, 3, 6, 7, 0, 1, 5, 0, 5, 4];
    const corners: number[] = [];
    for (const f of faces) corners.push(c[f][0] * 0.5, c[f][1] * 0.5, c[f][2] * 0.5);
    this.counts.cube = faces.length;
    this.vao.cube = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao.cube);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(corners), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    // 实例缓冲（占位，后面更新）
    this.buffers.instT = gl.createBuffer()!;
    this.buffers.instC = gl.createBuffer()!;
    gl.bindVertexArray(null);
  }

  private ensureInstanceCapacity(n: number) {
    if (n <= this.maxGrains) return;
    const gl = this.gl;
    this.maxGrains = Math.max(n, 2048);
    this.grainData = new Float32Array(this.maxGrains * 4);
    this.grainColors = new Float32Array(this.maxGrains * 3);
    gl.bindVertexArray(this.vao.cube);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instT);
    gl.bufferData(gl.ARRAY_BUFFER, this.grainData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instC);
    gl.bufferData(gl.ARRAY_BUFFER, this.grainColors.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 12, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
  }

  /** 由 2D 剖面快照生成 3D 实例数据（z 按颗粒索引哈希展开） */
  private uploadSnapshot(snap: FrameSnapshot) {
    const n = snap.grainCount;
    this.ensureInstanceCapacity(n + 3);
    const base = this.sand ? hsl(this.sand.hue, this.sand.saturation, this.sand.lightness) : [0.7, 0.6, 0.45];
    for (let i = 0; i < n; i++) {
      const x = snap.grains[i * 2];
      const y = snap.grains[i * 2 + 1];
      const h = Math.sin(i * 127.1 + 311.7) * 43758.5453;
      const z = (h - Math.floor(h) - 0.5) * (this.bunker?.width ?? 4) * 0.82;
      const scale = 0.016 + (h - Math.floor(h)) * 0.008;
      this.grainData[i * 4] = x;
      this.grainData[i * 4 + 1] = y;
      this.grainData[i * 4 + 2] = z;
      this.grainData[i * 4 + 3] = scale;
      const shade = 0.82 + (h - Math.floor(h)) * 0.35;
      this.grainColors[i * 3] = base[0] * shade;
      this.grainColors[i * 3 + 1] = base[1] * shade;
      this.grainColors[i * 3 + 2] = base[2] * shade;
    }
    // 球（白色大立方体近似）
    const bi = n;
    this.grainData.set([snap.ballX, snap.ballY, 0, 0.046], bi * 4);
    this.grainColors.set([0.95, 0.95, 0.92], bi * 3);
    // 旗洞标记（小红柱，固定在 pinX）
    const pi = n + 1;
    this.grainData.set([this.pinX, this.pinY + 0.6, 0, 0.035], pi * 4);
    this.grainColors.set([0.85, 0.15, 0.15], pi * 3);
    const gl = this.gl;
    gl.bindVertexArray(this.vao.cube);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instT);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.grainData.subarray(0, (n + 2) * 4));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instC);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.grainColors.subarray(0, (n + 2) * 3));
    gl.bindVertexArray(null);
    this.grainDrawCount = n + 2;
  }
  private grainDrawCount = 0;

  // ------------------------------------------------------------ 杆头网格
  private buildClubMesh() {
    const gl = this.gl;
    // 与物理世界一致的楔形剖面（局部坐标），沿 z 拉伸 5cm
    const w = 0.092, h = 0.056, t = 0.025;
    const loftR = (56 * Math.PI) / 180;
    const bounceR = (10 * Math.PI) / 180;
    const leadX = w / 2;
    const poly = [
      [leadX, 0],
      [leadX - h * Math.sin(loftR), h * Math.cos(loftR)],
      [-w / 2, h * 0.8],
      [leadX - w * Math.cos(bounceR), -w * Math.sin(bounceR)],
    ];
    const verts: number[] = [];
    const push = (x: number, y: number, z: number) => verts.push(x, y, z);
    // 前面（z=+t/2）与后面（z=-t/2），扇形三角
    for (const z of [t / 2, -t / 2]) {
      for (let i = 1; i < poly.length - 1; i++) {
        push(poly[0][0], poly[0][1], z);
        push(poly[i][0], poly[i][1], z);
        push(poly[i + 1][0], poly[i + 1][1], z);
      }
    }
    // 侧面
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      push(a[0], a[1], -t / 2); push(b[0], b[1], -t / 2); push(b[0], b[1], t / 2);
      push(a[0], a[1], -t / 2); push(b[0], b[1], t / 2); push(a[0], a[1], t / 2);
    }
    this.counts.club = verts.length / 3;
    this.vao.club = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao.club);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);
  }

  /** 静态预览：把杆头摆在入沙点上方 */
  showPreview(entryBehind: number, _angleDeg: number) {
    if (!this.bunker) return;
    const y = this.bunker.profile.surfaceY(-entryBehind) + 0.05;
    this.clubTransform = mat4Model(-entryBehind, y, 0, 0, 1);
  }

  /** 回放一帧快照 */
  showFrame(snap: FrameSnapshot) {
    this.uploadSnapshot(snap);
    // 杆头：2D 角度绕 z 轴旋转（mat4Model 的 ry 是绕 y，需要自定义）
    const c = Math.cos(snap.clubAngle), s = Math.sin(snap.clubAngle);
    const m = new Float32Array([
      c, s, 0, 0,
      -s, c, 0, 0,
      0, 0, 1, 0,
      snap.clubX, snap.clubY, 0, 1,
    ]);
    this.clubTransform = m;
  }

  // ------------------------------------------------------------ 渲染循环
  start() {
    const loop = () => {
      this.render();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  private render() {
    const gl = this.gl;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.52, 0.7, 0.85, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const target: [number, number, number] = [0.8, 0.05, 0];
    const eye: [number, number, number] = [
      target[0] + Math.cos(this.pitch) * Math.sin(this.yaw) * this.dist,
      target[1] + Math.sin(this.pitch) * this.dist,
      target[2] + Math.cos(this.pitch) * Math.cos(this.yaw) * this.dist,
    ];
    const view = mat4LookAt(eye, target, [0, 1, 0]);
    const proj = mat4Perspective((50 * Math.PI) / 180, this.canvas.width / this.canvas.height, 0.05, 60);
    const vp = mat4Multiply(proj, view);

    // 地形
    gl.useProgram(this.terrainProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.terrainProg, 'uViewProj'), false, vp);
    gl.uniform3f(gl.getUniformLocation(this.terrainProg, 'uSun'), 0.5, 0.9, 0.35);
    gl.bindVertexArray(this.vao.terrain);
    gl.drawElements(gl.TRIANGLES, this.counts.terrainV, gl.UNSIGNED_INT, 0);

    // 实例（沙粒 + 球 + 旗）
    if (this.grainDrawCount > 0) {
      gl.useProgram(this.instProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.instProg, 'uViewProj'), false, vp);
      gl.bindVertexArray(this.vao.cube);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, this.counts.cube, this.grainDrawCount);
    }

    // 杆头：独立金属色 program
    this.drawClubSolid(vp);
    gl.bindVertexArray(null);
  }

  private drawClubSolid(vp: Mat4) {
    const gl = this.gl;
    if (!this.clubSolidProg) {
      this.clubSolidProg = createProgram(
        gl,
        `#version 300 es
         precision highp float;
         layout(location=0) in vec3 aPos;
         uniform mat4 uMVP;
         out vec3 vPos;
         void main(){ vPos=aPos; gl_Position=uMVP*vec4(aPos,1.0);}`,
        `#version 300 es
         precision highp float;
         in vec3 vPos;
         out vec4 frag;
         void main(){
           float shade = 0.55 + 0.45 * clamp(vPos.y * 6.0 + 0.6, 0.0, 1.0);
           frag = vec4(vec3(0.32,0.36,0.42) * shade, 1.0);
         }`,
      );
    }
    gl.useProgram(this.clubSolidProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.clubSolidProg, 'uMVP'), false, mat4Multiply(vp, this.clubTransform));
    gl.bindVertexArray(this.vao.club);
    gl.drawArrays(gl.TRIANGLES, 0, this.counts.club);
  }
  private clubSolidProg: WebGLProgram | null = null;

  // 球位预览（无快照时在沙面上放一颗球）
  showLiePreview(lie: LieType) {
    if (!this.bunker) return;
    const surf = this.bunker.profile.surfaceY(0);
    const r = 0.02135;
    const depthFactor = lie === 'clean' ? 0.18 : lie === 'half' ? 0.62 : 0.92;
    const y = surf + r * (1 - depthFactor);
    const fake: FrameSnapshot = {
      t: 0, grains: new Float32Array(0), grainCount: 0,
      clubX: 0, clubY: -10, clubAngle: 0,
      ballX: 0, ballY: y, ballVx: 0, ballVy: 0,
      clubPenetration: 0, clubSpeed: 0, airborne: false,
    };
    this.uploadSnapshot(fake);
  }
}
