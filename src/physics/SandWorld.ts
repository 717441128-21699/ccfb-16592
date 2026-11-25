import type {
  BunkerProfile,
  FrameSnapshot,
  LieType,
  SandProps,
  ShotOutcome,
  ShotSetup,
} from './types';
import { RNG } from './rng';

// ---------------------------------------------------------------------------
// 2D 离散元（DEM）沙坑世界（稳健版）
//
// 杆头：运动学挥杆圆弧 + 一个沉浮自由度 heave。
//   - 杆头沿挥杆圆被主动驱动（力度→圆沿线速度），杆体姿态按固定手腕夹角锁定；
//   - 杆底切入沙时，颗粒法向反冲沿“杆底外法线”作用，产生升力（heave）与阻力；
//   - 反弹角 bounce 越大，杆底斜面越容易把前向驱动转化为向上升力 → 切得浅、滑着走；
//   - 湿沙板结/黏结 → 颗粒逃不走，反冲冲量大 → 杆头被弹起（skip）；
//   - 干沙松软 → 颗粒被直接铲飞，反冲小 → 名义轨迹继续下探 → 挖得深。
// 球：完全动力学刚体，由被铲起沙粒的动量碰撞带出；直接撞杆面记为打薄。
// ---------------------------------------------------------------------------

const GRAVITY = 9.81;
const DT = 1 / 3000;
const STEPS_PER_SNAP = 8; // 375Hz 慢放素材
const BALL_RADIUS = 0.02135;
const BALL_MASS = 0.0459;
const BALL_REST = 0.36;
const BALL_FRICTION = 0.5;
const AIR_DRAG = 0.0016;
const MAX_SIM_TIME = 0.4;
const HASH_SIZE = 1 << 15;
const HASH_MASK = HASH_SIZE - 1;
const ACTIVE_RADIUS = 0.42; // 距杆头/球该范围内的颗粒才参与积分
const HEAVE_MASS = 1.0; // 沉浮自由度等效质量（调小让颗粒反冲能明显改变穿深）
const HEAVE_K = 60; // 很软的弹簧，让反弹角升力充分转化为杆头上抬
const HEAVE_C = 12; // 沉浮阻尼

interface GrainArrays {
  x: Float32Array; y: Float32Array;
  vx: Float32Array; vy: Float32Array;
  r: Float32Array; m: Float32Array; invM: Float32Array;
  alive: Uint8Array; active: Uint8Array;
}

export interface WorldConfig {
  sand: SandProps;
  profile: BunkerProfile;
  lie: LieType;
  setup: ShotSetup;
  seed: number;
  jitter: number;
  lipDistance: number;
  lipHeight: number;
  pinDistance: number;
  greenLevel: number;
}

export class SandWorld {
  readonly cfg: WorldConfig;
  private rng: RNG;
  private grains!: GrainArrays;
  private head = new Int32Array(HASH_SIZE);
  private next = new Int32Array(0);
  private cellSize: number;
  n = 0;

  // 杆头
  private club = {
    x: 0, y: 0, angle: 0,
    vx: 0, vy: 0, omega: 0,
    // 名义轨迹
    hubX: 0, hubY: 0, hubAngle: 0, swingR: 0.9, wristOffset: 0,
    driveSpeed: 0,
    // 沉浮自由度（沿杆底外法线反方向，正值=向上骑起）
    heave: 0, heaveV: 0,
    soleNormalX: 0, soleNormalY: -1,
    vertices: [] as { x: number; y: number }[],
    gripLocalX: 0, gripLocalY: 0,
    bounceEff: 0,
    loftEff: 0,
  };
  private clubStartAngle = 0;

  private ball = { x: 0, y: 0, vx: 0, vy: 0, held: true };
  private t = 0;
  private snapshots: FrameSnapshot[] = [];
  private maxPen = 0;
  private ballClubContactSteps = 0;
  private airborne = false;
  private launchVx = 0;
  private launchVy = 0;
  private launchX = 0;
  private launchY = 0;
  private actionX = 0;

  constructor(cfg: WorldConfig) {
    this.cfg = cfg;
    this.rng = new RNG(cfg.seed);
    this.cellSize = cfg.sand.grainRadius * 2.2;
    this.buildGrains();
    this.buildClub(cfg.setup);
    // 先让沙床充分沉降，再放球，避免放球删除的空腔在沉降中无法回填
    this.presettle();
    this.placeBall(cfg.lie);
    this.backfill();
  }

  // ------------------------------------------------------------- 建场
  private buildGrains() {
    const { profile, sand } = this.cfg;
    const r = sand.grainRadius;
    const spacing = r * 2.05;
    const positions: { x: number; y: number; r: number }[] = [];
    // 行高上限取整个剖面内的最高沙面，避免用 xMin 处的低沙面导致球位表层缺粒
    let maxSurface = profile.floorY;
    for (let x = profile.xMin; x <= profile.xMax; x += 0.05) {
      maxSurface = Math.max(maxSurface, profile.surfaceY(x));
    }
    let rowIdx = 0;
    for (let y = profile.floorY + r; y < maxSurface + r; y += spacing * 0.92) {
      const offset = (rowIdx % 2) * spacing * 0.5;
      for (let x = profile.xMin + r + offset; x < profile.xMax; x += spacing) {
        if (y >= profile.surfaceY(x) - r * 0.4) continue;
        const jr = r * this.rng.range(0.85, 1.15);
        positions.push({
          x: x + this.rng.range(-this.cfg.jitter, this.cfg.jitter) * r,
          y: y + this.rng.range(-this.cfg.jitter, this.cfg.jitter) * r,
          r: jr,
        });
      }
      rowIdx++;
    }
    const n = positions.length;
    const g: GrainArrays = {
      x: new Float32Array(n), y: new Float32Array(n),
      vx: new Float32Array(n), vy: new Float32Array(n),
      r: new Float32Array(n), m: new Float32Array(n), invM: new Float32Array(n),
      alive: new Uint8Array(n), active: new Uint8Array(n),
    };
    for (let i = 0; i < n; i++) {
      g.x[i] = positions[i].x;
      g.y[i] = positions[i].y;
      g.r[i] = positions[i].r;
      g.m[i] = sand.grainMass * (positions[i].r / r) ** 2;
      g.invM[i] = 1 / g.m[i];
      g.alive[i] = 1;
    }
    this.grains = g;
    this.next = new Int32Array(n);
    this.n = n;
  }

  private placeBall(lie: LieType) {
    const surf = this.cfg.profile.surfaceY(0);
    // 煎蛋球埋得更深（0.98 → 球顶几乎与沙面齐平），覆盖层更厚
    const depthFactor = lie === 'clean' ? 0.18 : lie === 'half' ? 0.62 : 0.98;
    this.ball.y = surf + BALL_RADIUS * (1 - depthFactor) - (lie === 'plug' ? 0.006 : 0);
    this.ball.x = 0;
    const g = this.grains;
    // 删除半径略小于碰撞半径，让周围颗粒在回填后能贴近球面，保证沙-球动量传递
    const killR = BALL_RADIUS * 0.8;
    for (let i = 0; i < this.n; i++) {
      const dx = g.x[i] - this.ball.x;
      const dy = g.y[i] - this.ball.y;
      const rr = g.r[i] + killR;
      if (dx * dx + dy * dy >= rr * rr) continue;
      // 煎蛋/半埋球：保留球上半球的颗粒（覆盖层），只清出下半球与侧向空间
      if (lie !== 'clean' && g.y[i] > this.ball.y + BALL_RADIUS * 0.15) continue;
      g.alive[i] = 0;
    }
    // 煎蛋球：在球顶再补一层压实颗粒，模拟高速砸入时塌落包裹的沙帽
    if (lie === 'plug') {
      for (let i = 0; i < this.n; i++) {
        if (!g.alive[i]) continue;
        const dx = g.x[i] - this.ball.x;
        const dy = g.y[i] - (this.ball.y + BALL_RADIUS * 1.05);
        if (Math.abs(dx) < BALL_RADIUS * 1.1 && dy > -g.r[i] && dy < g.r[i] * 2.2) {
          g.m[i] *= 1.35;
          g.invM[i] = 1 / g.m[i];
        }
      }
    }
  }

  private buildClub(setup: ShotSetup) {
    const def = setup.club;
    const c = this.club;
    const w = 0.092, h = 0.056;
    // 杆面倾角与杆底反弹角解耦：打开杆面同时改变两者，但几何按各自角度构建
    const loftR = ((def.loft + setup.faceOpen) * Math.PI) / 180;
    const bounceEff = def.bounce + setup.faceOpen * 0.3;
    c.bounceEff = (bounceEff * Math.PI) / 180;
    // 限制杆面几何倾角，避免打开过大时杆面接近水平导致多边形退化
    const faceR = Math.min(loftR, (74 * Math.PI) / 180);
    const leadX = w / 2;
    const faceTop = { x: leadX - h * Math.sin(faceR), y: h * Math.cos(faceR) };
    const faceBottom = { x: leadX, y: 0 };
    const soleBack = { x: leadX - w * Math.cos(c.bounceEff), y: -w * Math.sin(c.bounceEff) };
    const topBack = { x: -w / 2, y: h * 0.8 };
    c.vertices = [faceBottom, faceTop, topBack, soleBack];
    c.gripLocalX = -0.02;
    c.gripLocalY = h * 0.95;
    // 完整有效杆面倾角，用于颗粒在杆面上的抛射方向判断
    c.loftEff = loftR;
  }

  private localToWorld(lx: number, ly: number, cx = this.club.x, cy = this.club.y, angle = this.club.angle) {
    const cos = Math.cos(angle), sin = Math.sin(angle);
    return { x: cx + lx * cos - ly * sin, y: cy + lx * sin + ly * cos };
  }

  private presettle() {
    // 沉降阶段所有颗粒都参与，避免活动区边界失去侧向支撑导致边缘流失
    const g = this.grains;
    for (let i = 0; i < this.n; i++) g.active[i] = 1;
    for (let s = 0; s < 220; s++) {
      this.integrateGrains(true);
      this.buildGrid();
      this.collideGrains();
      this.collideStatic();
    }
    for (let i = 0; i < this.n; i++) { g.vx[i] = 0; g.vy[i] = 0; g.active[i] = 1; }
    // 沉降后重塑表面微观粗糙度：不同种子生成不同接触链 → 落点散布。
    // 干沙松散，粗糙度幅度大；湿沙板结，表面被塑形约束，幅度小。
    const p = this.cfg.profile;
    const rough = this.cfg.sand.firmness > 0.5 ? 0.55 : 1.15;
    for (let i = 0; i < this.n; i++) {
      if (!g.alive[i]) continue;
      const sy = p.surfaceY(g.x[i]);
      if (g.y[i] > sy - g.r[i] * 2.4) {
        g.x[i] += this.rng.range(-0.5, 0.5) * g.r[i] * rough;
        g.y[i] += this.rng.range(-0.4, 0.4) * g.r[i] * rough;
      }
    }
  }

  /** 放球后让周围颗粒回填，紧贴球面（球作为静态刚体） */
  private backfill() {
    const g = this.grains;
    const b = this.ball;
    for (let i = 0; i < this.n; i++) g.active[i] = 1;
    for (let s = 0; s < 160; s++) {
      this.integrateGrains(true);
      this.buildGrid();
      this.collideGrains();
      this.collideStatic();
      // 球作为静态边界：把侵入的颗粒推到球面外
      for (let i = 0; i < this.n; i++) {
        if (!g.alive[i]) continue;
        const dx = g.x[i] - b.x, dy = g.y[i] - b.y;
        const rr = g.r[i] + BALL_RADIUS;
        const d2 = dx * dx + dy * dy;
        if (d2 < rr * rr && d2 > 1e-12) {
          const d = Math.sqrt(d2);
          const push = rr - d;
          g.x[i] += (dx / d) * push;
          g.y[i] += (dy / d) * push;
          // 消去指向球心的速度
          const nx = dx / d, ny = dy / d;
          const vn = g.vx[i] * nx + g.vy[i] * ny;
          if (vn < 0) { g.vx[i] -= vn * nx; g.vy[i] -= vn * ny; }
        }
      }
    }
    for (let i = 0; i < this.n; i++) { g.vx[i] = 0; g.vy[i] = 0; g.active[i] = 1; }
  }

  // ------------------------------------------------------------- 挥杆轨迹
  private initSwing() {
    const { setup } = this.cfg;
    const c = this.club;
    const R = setup.club.swingRadius;
    const d = setup.entryBehind;
    const entryY = this.cfg.profile.surfaceY(-d);

    // 入沙瞬间杆体姿态：杆底近似水平，站位越偏目标方前压越多（下砸越陡）
    const theta0 = ((-6 + setup.stanceShift * 12) * Math.PI) / 180;
    // 令前缘位于入沙点
    const lead = c.vertices[0];
    const cos0 = Math.cos(theta0), sin0 = Math.sin(theta0);
    const cx = -d - (lead.x * cos0 - lead.y * sin0);
    const cy = entryY - (lead.x * sin0 + lead.y * cos0);

    // 挥杆圆心：起点 -105°，名义圆弧最低点比入沙点低约 3cm（保证平板底能挖进沙），
    // 实际穿深由反弹角的 heave 上抬量决定
    const phi0 = ((-105 - setup.stanceShift * 25) * Math.PI) / 180;
    const gripLX = c.gripLocalX * cos0 - c.gripLocalY * sin0;
    const gripLY = c.gripLocalX * sin0 + c.gripLocalY * cos0;
    c.hubX = cx + gripLX - R * Math.cos(phi0);
    c.hubY = cy + gripLY - R * Math.sin(phi0);
    c.swingR = R;
    c.hubAngle = phi0;
    this.clubStartAngle = phi0;
    c.wristOffset = theta0 - phi0;
    // 杆头线速度：力度 0.55..1 → 12..26 m/s（沙坑球实际球速 8~16）
    const speedJitter = 1 + (this.rng.next() - 0.5) * 0.03;
    c.driveSpeed = (12 + setup.power * 14) * speedJitter;
    // 记录入沙点 x，用于沙内行程的能量折减
    this.entryX = -setup.entryBehind;
    c.heave = 0;
    c.heaveV = 0;
    this.applyKinematicPose(theta0);
  }
  private entryX = 0;

  /** 按名义姿态 + heave 偏移更新杆头世界坐标与速度 */
  private applyKinematicPose(theta: number) {
    const c = this.club;
    const gripNomX = c.hubX + Math.cos(c.hubAngle) * c.swingR;
    const gripNomY = c.hubY + Math.sin(c.hubAngle) * c.swingR;
    const cos = Math.cos(theta), sin = Math.sin(theta);
    const nomCx = gripNomX - (c.gripLocalX * cos - c.gripLocalY * sin);
    const nomCy = gripNomY - (c.gripLocalX * sin + c.gripLocalY * cos);
    // 杆底外法线（局部 (sinβ, -cosβ)）旋转到世界；heave 沿其反方向
    const snx = Math.sin(c.bounceEff) * cos - (-Math.cos(c.bounceEff)) * sin;
    const sny = Math.sin(c.bounceEff) * sin + (-Math.cos(c.bounceEff)) * cos;
    c.soleNormalX = snx;
    c.soleNormalY = sny;
    c.x = nomCx - snx * c.heave;
    c.y = nomCy - sny * c.heave;
    c.angle = theta;
    // 名义切向速度
    const tx = -Math.sin(c.hubAngle) * c.driveSpeed;
    const ty = Math.cos(c.hubAngle) * c.driveSpeed;
    c.vx = tx - snx * c.heaveV;
    c.vy = ty - sny * c.heaveV;
    c.omega = c.driveSpeed / c.swingR;
  }

  // ------------------------------------------------------------- 主循环
  run(): ShotOutcome {
    this.initSwing();
    const maxSteps = Math.round(MAX_SIM_TIME / DT);
    for (let step = 0; step < maxSteps; step++) {
      this.t += DT;
      // 圆心沿圆弧推进（沙阻通过 driveSpeed 衰减体现）
      this.club.hubAngle += (this.club.driveSpeed / this.club.swingR) * DT;
      const theta = this.club.hubAngle + this.club.wristOffset;
      this.applyKinematicPose(theta);

      this.actionX = this.ball.held ? this.club.x : (this.club.x + this.ball.x) * 0.5;
      this.markActive(this.actionX);
      this.integrateGrains(false);
      this.buildGrid();
      this.collideGrains();
      this.collideStatic();
      const contact = this.collideClubGrains();
      this.applyHeave(contact);
      this.collideClubBall();
      this.collideBallGrains();
      this.stepBall();

      if (step % STEPS_PER_SNAP === 0) this.capture();
      // 球起飞后再记录一小段沙粒飞溅，然后转入纯弹道结算
      if (this.airborne && this.ball.x > 0.32 && this.ball.vx > 1.5) break;
      // 单次挥杆：圆心转过 135°（下挥入沙→随挥出沙）后结束，避免整圈空转
      if (this.club.hubAngle - this.clubStartAngle > 2.35) break;
      if (this.club.x > this.cfg.profile.xMax - 0.05) break;
    }
    this.capture();
    return this.finish();
  }

  // ------------------------------------------------------------- 空间哈希
  private hash(x: number, y: number): number {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    // 先转无符号再掩码，避免负哈希导致桶索引为负
    return ((Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) >>> 0) & HASH_MASK;
  }

  private buildGrid() {
    this.head.fill(-1);
    const g = this.grains;
    for (let i = 0; i < this.n; i++) {
      if (!g.alive[i]) continue;
      const h = this.hash(g.x[i], g.y[i]);
      this.next[i] = this.head[h];
      this.head[h] = i;
    }
  }

  private markActive(centerX: number) {
    const g = this.grains;
    for (let i = 0; i < this.n; i++) {
      g.active[i] = g.alive[i] && Math.abs(g.x[i] - centerX) < ACTIVE_RADIUS ? 1 : 0;
    }
  }

  // ------------------------------------------------------------- 颗粒
  private integrateGrains(settling: boolean) {
    const g = this.grains;
    for (let i = 0; i < this.n; i++) {
      if (!g.alive[i] || (!settling && !g.active[i])) continue;
      g.vy[i] -= GRAVITY * DT;
      g.x[i] += g.vx[i] * DT;
      g.y[i] += g.vy[i] * DT;
    }
  }

  private collideGrains() {
    const g = this.grains;
    const sand = this.cfg.sand;
    const e = sand.restitution;
    const mu = sand.friction;
    const cohesion = sand.cohesion;
    const cs = this.cellSize;
    for (let i = 0; i < this.n; i++) {
      if (!g.alive[i] || !g.active[i]) continue;
      const cx = Math.floor(g.x[i] / cs);
      const cy = Math.floor(g.y[i] / cs);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          let j = this.head[((Math.imul(cx + ox, 73856093) ^ Math.imul(cy + oy, 19349663)) >>> 0) & HASH_MASK];
          while (j !== -1) {
            if (j > i && g.alive[j]) {
              const dx = g.x[j] - g.x[i];
              const dy = g.y[j] - g.y[i];
              const rr = g.r[i] + g.r[j];
              const d2 = dx * dx + dy * dy;
              if (d2 < rr * rr && d2 > 1e-12) {
                const d = Math.sqrt(d2);
                const nx = dx / d, ny = dy / d;
                const overlap = rr - d;
                const totalInv = g.invM[i] + g.invM[j];
                // 强位置修正（Baumgarte），防止重力持续压穿颗粒堆
                const corr = (overlap / totalInv) * 0.92;
                g.x[i] -= nx * corr * g.invM[i];
                g.y[i] -= ny * corr * g.invM[i];
                g.x[j] += nx * corr * g.invM[j];
                g.y[j] += ny * corr * g.invM[j];
                const rvx = g.vx[j] - g.vx[i];
                const rvy = g.vy[j] - g.vy[i];
                const vn = rvx * nx + rvy * ny;
                if (vn < 0) {
                  const jn = (-(1 + e) * vn) / totalInv;
                  g.vx[i] -= jn * g.invM[i] * nx;
                  g.vy[i] -= jn * g.invM[i] * ny;
                  g.vx[j] += jn * g.invM[j] * nx;
                  g.vy[j] += jn * g.invM[j] * ny;
                  const tvx = rvx - vn * nx, tvy = rvy - vn * ny;
                  const tl = Math.hypot(tvx, tvy);
                  if (tl > 1e-9) {
                    const jt = Math.max(-tl / totalInv, -mu * jn);
                    const tx = tvx / tl, ty = tvy / tl;
                    g.vx[i] -= jt * g.invM[i] * tx;
                    g.vy[i] -= jt * g.invM[i] * ty;
                    g.vx[j] += jt * g.invM[j] * tx;
                    g.vy[j] += jt * g.invM[j] * ty;
                  }
                } else if (cohesion > 0 && overlap > -g.r[i] * 0.3) {
                  const pull = Math.min(cohesion * g.m[i] * 0.02, vn * 0.4 * g.m[i]);
                  g.vx[i] += pull * g.invM[i] * nx;
                  g.vy[i] += pull * g.invM[i] * ny;
                  g.vx[j] -= pull * g.invM[j] * nx;
                  g.vy[j] -= pull * g.invM[j] * ny;
                }
              }
            }
            j = this.next[j];
          }
        }
      }
    }
  }

  private collideStatic() {
    const g = this.grains;
    const p = this.cfg.profile;
    const sand = this.cfg.sand;
    const e = sand.restitution * 0.7;
    const mu = Math.min(sand.friction * 1.1, 0.6);
    for (let i = 0; i < this.n; i++) {
      if (!g.alive[i] || !g.active[i]) continue;
      if (g.y[i] - g.r[i] < p.floorY) {
        g.y[i] = p.floorY + g.r[i];
        if (g.vy[i] < 0) {
          g.vy[i] = -g.vy[i] * e;
          g.vx[i] *= 1 - mu;
        }
      }
      if (g.x[i] - g.r[i] < p.xMin) {
        g.x[i] = p.xMin + g.r[i];
        if (g.vx[i] < 0) g.vx[i] = -g.vx[i] * e;
      }
      if (g.x[i] + g.r[i] > p.xMax) {
        g.x[i] = p.xMax - g.r[i];
        if (g.vx[i] > 0) g.vx[i] = -g.vx[i] * e;
      }
      // 湿沙板结：低速颗粒不允许高出原始沙面（塑形约束）
      if (sand.firmness > 0.5) {
        const sy = p.surfaceY(g.x[i]);
        if (g.y[i] > sy + g.r[i] && Math.hypot(g.vx[i], g.vy[i]) < 0.8) {
          g.y[i] = sy + g.r[i];
          g.vy[i] = Math.max(0, g.vy[i]);
          g.vx[i] *= 0.8;
        }
      }
    }
  }

  // ------------------------------------------------------------- 杆头-颗粒
  /** 返回本帧累计的法向冲量与切向阻力冲量 */
  private collideClubGrains(): { lift: number; drag: number } {
    const g = this.grains;
    const c = this.club;
    const sand = this.cfg.sand;
    const cs = this.cellSize;
    let liftJ = 0;
    let dragJ = 0;
    const x0 = Math.floor((c.x - 0.12) / cs), x1 = Math.floor((c.x + 0.12) / cs);
    const y0 = Math.floor((c.y - 0.1) / cs), y1 = Math.floor((c.y + 0.1) / cs);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        let i = this.head[((Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) >>> 0) & HASH_MASK];
        while (i !== -1) {
          if (g.alive[i] && g.active[i]) {
            const hit = this.pointVsClub(g.x[i], g.y[i], g.r[i]);
            if (hit) {
              const { nx, ny, depth } = hit;
              g.x[i] += nx * depth;
              g.y[i] += ny * depth;
              const rvx = g.vx[i] - c.vx;
              const rvy = g.vy[i] - c.vy;
              const vn = rvx * nx + rvy * ny;
              if (vn < 0) {
                // 杆头等效大质量：冲量主要被颗粒吸收；板结沙中颗粒被邻居约束，
                // 用 firmness 放大杆头受到的反作用（颗粒逃不走 → 力传回杆头）
                const reactionScale = 0.3 + sand.firmness * 1.35;
                const jn = (-(1 + 0.12) * vn) / (g.invM[i] + 1 / HEAVE_MASS);
                g.vx[i] += jn * g.invM[i] * nx;
                g.vy[i] += jn * g.invM[i] * ny;
                const tvx = rvx - vn * nx, tvy = rvy - vn * ny;
                const tl = Math.hypot(tvx, tvy);
                let jt = 0;
                if (tl > 1e-9) {
                  jt = Math.max(-tl / (g.invM[i] + 1 / HEAVE_MASS), -sand.friction * 0.9 * jn);
                  const tx = tvx / tl, ty = tvy / tl;
                  g.vx[i] += jt * g.invM[i] * tx;
                  g.vy[i] += jt * g.invM[i] * ty;
                }
                // 杆面效应：被杆面/杆底前缘直接驱动的颗粒，按有效杆面倾角
                // 获得向上的抛射偏置（打开杆面 → 更高更软的沙浪与球路）。
                // 能量折减：杆头在沙中行进越久，能量越多耗散在推动前方沙柱上，
                // 传递给球区颗粒的速度按沙内行程衰减（入沙点越远 → 球越近）。
                const travelFrac = Math.max(0, Math.min(1, (c.x - this.entryX) / 0.16));
                const travelDamp = 1 - 0.55 * travelFrac;
                if (g.y[i] > c.y - 0.02) {
                  const upBias = Math.sin(this.club.loftEff) * Math.abs(c.vx) * 0.22 * travelDamp;
                  g.vy[i] += upBias;
                  g.vx[i] *= 1 - Math.sin(this.club.loftEff) * 0.18;
                  g.vx[i] *= travelDamp;
                }
                // 杆头受力（沿 -n 方向）。升力投影到 heave 轴（杆底法线反方向）
                const onClubX = -(jn * nx) - (jt === 0 ? 0 : jt * (tvx / (tl || 1)));
                const onClubY = -(jn * ny) - (jt === 0 ? 0 : jt * (tvy / (tl || 1)));
                const axisX = -c.soleNormalX, axisY = -c.soleNormalY;
                liftJ += (onClubX * axisX + onClubY * axisY) * reactionScale;
                // 阻力：投影到挥杆切向（近似水平向后）
                dragJ += Math.max(0, -onClubX) * reactionScale + Math.abs(jt) * 0.25;
              }
            }
          }
          i = this.next[i];
        }
      }
    }
    return { lift: liftJ, drag: dragJ };
  }

  /** 沉浮自由度：颗粒升力冲量 vs 双手弹簧；并把沙阻冲量转化为挥杆减速 */
  private applyHeave(contact: { lift: number; drag: number }) {
    const c = this.club;
    const sand = this.cfg.sand;
    // 反弹角几何分解：杆底法向反冲在竖直方向的分量随 bounce 增大。
    // 平板底（β≈0）：反冲近水平，无向上分量，名义圆弧主导 → 挖得深；
    // 大反弹角（β大）：杆底斜面把水平驱动转为竖直升力 → 把杆头抬起、切得浅。
    // 归一化 bounce：4°→0 … 14°→1，让 6/8/12 三档杆在升力上充分拉开
    const bounceNorm = Math.max(0, Math.min(1, (c.bounceEff - 0.07) / 0.175));
    const liftEff = contact.lift * bounceNorm * 90;
    // 冲量/等效质量 = 速度增量（直接动量定理，不再做时间折算）
    c.heaveV += liftEff / HEAVE_MASS;
    // 弹簧-阻尼拉回名义轨迹（力按 dt 积分）
    c.heaveV += (-(HEAVE_K * c.heave) - HEAVE_C * c.heaveV) / HEAVE_MASS * DT;
    c.heave += c.heaveV * DT;
    if (c.heave < -0.02) { c.heave = -0.02; c.heaveV = Math.max(0, c.heaveV); }
    if (c.heave > 0.1) { c.heave = 0.1; c.heaveV = Math.min(0, c.heaveV); }

    // 沙阻减速：平板底（低 bounce）在板结沙中阻力最大；湿沙摩擦高、阻力大。
    // 入沙点越远，杆头在沙中行程越长，累积阻力越大 → 到球时速度越低 → 球越近。
    const dragEff = contact.drag * (1.3 - bounceNorm * 0.7) * (0.6 + sand.firmness * 1.1);
    c.driveSpeed = Math.max(3, c.driveSpeed - (dragEff / HEAVE_MASS) * 1.6);
  }

  /** 圆与凸四边形（杆头）碰撞 */
  private pointVsClub(px: number, py: number, pr: number): { nx: number; ny: number; depth: number } | null {
    const c = this.club;
    const cos = Math.cos(-c.angle), sin = Math.sin(-c.angle);
    const dx = px - c.x, dy = py - c.y;
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    let best: { nx: number; ny: number; depth: number } | null = null;
    const verts = c.vertices;
    for (let k = 0; k < verts.length; k++) {
      const a = verts[k];
      const b = verts[(k + 1) % verts.length];
      const ex = b.x - a.x, ey = b.y - a.y;
      const len = Math.hypot(ex, ey);
      let enx = ey / len, eny = -ex / len;
      const midx = (a.x + b.x) / 2, midy = (a.y + b.y) / 2;
      if (-midx * enx - midy * eny > 0) { enx = -enx; eny = -eny; }
      const dist = (lx - a.x) * enx + (ly - a.y) * eny;
      const overlap = pr - dist;
      if (overlap <= 0) return null;
      if (!best || overlap < best.depth) {
        const wnx = enx * Math.cos(c.angle) - eny * Math.sin(c.angle);
        const wny = enx * Math.sin(c.angle) + eny * Math.cos(c.angle);
        best = { nx: wnx, ny: wny, depth: overlap };
      }
    }
    return best;
  }

  // ------------------------------------------------------------- 球
  private stepBall() {
    const b = this.ball;
    if (b.held) {
      // 杆头前缘逼近球时释放
      const lead = this.localToWorld(this.club.vertices[0].x, this.club.vertices[0].y);
      if (lead.x > b.x - 0.14) b.held = false;
      else return;
    }
    b.vy -= GRAVITY * DT;
    b.x += b.vx * DT;
    b.y += b.vy * DT;
    const p = this.cfg.profile;
    if (b.y - BALL_RADIUS < p.floorY) {
      b.y = p.floorY + BALL_RADIUS;
      if (b.vy < 0) { b.vy = -b.vy * BALL_REST; b.vx *= 0.7; }
    }
    if (b.x + BALL_RADIUS > p.xMax) b.x = p.xMax - BALL_RADIUS;
  }

  private collideClubBall() {
    if (this.ball.held) return;
    const hit = this.pointVsClub(this.ball.x, this.ball.y, BALL_RADIUS);
    if (!hit) return;
    this.ballClubContactSteps++;
    const c = this.club, b = this.ball;
    b.x += hit.nx * hit.depth * 0.8;
    b.y += hit.ny * hit.depth * 0.8;
    const rvx = b.vx - c.vx, rvy = b.vy - c.vy;
    const vn = rvx * hit.nx + rvy * hit.ny;
    if (vn < 0) {
      const invBall = 1 / BALL_MASS;
      const jn = (-(1 + 0.45) * vn) / (invBall + 1 / HEAVE_MASS);
      b.vx += jn * invBall * hit.nx;
      b.vy += jn * invBall * hit.ny;
    }
  }

  // 球-颗粒碰撞（在杆头碰撞之后做，保证沙垫优先）
  private collideBallGrains() {
    if (this.ball.held) return;
    const g = this.grains;
    const b = this.ball;
    const cs = this.cellSize;
    const x0 = Math.floor((b.x - BALL_RADIUS * 2) / cs);
    const x1 = Math.floor((b.x + BALL_RADIUS * 2) / cs);
    const y0 = Math.floor((b.y - BALL_RADIUS * 2) / cs);
    const y1 = Math.floor((b.y + BALL_RADIUS * 2) / cs);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        let i = this.head[((Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) >>> 0) & HASH_MASK];
        while (i !== -1) {
          if (g.alive[i]) {
            const dx = g.x[i] - b.x, dy = g.y[i] - b.y;
            const rr = g.r[i] + BALL_RADIUS;
            const d2 = dx * dx + dy * dy;
            if (d2 < rr * rr && d2 > 1e-12) {
              const d = Math.sqrt(d2);
              const nx = dx / d, ny = dy / d;
              const overlap = rr - d;
              const invBall = 1 / BALL_MASS;
              const totalInv = invBall + g.invM[i];
              b.x -= nx * overlap * 0.25;
              b.y -= ny * overlap * 0.25;
              g.x[i] += nx * overlap * 0.75;
              g.y[i] += ny * overlap * 0.75;
              const rvx = g.vx[i] - b.vx, rvy = g.vy[i] - b.vy;
              const vn = rvx * nx + rvy * ny;
              if (vn < 0) {
                // 沙垫能量折减：入沙点离球越远，杆头能量在沙柱中耗散越多，
                // 传给球的冲量越小（教练：入沙点越远→带沙越多→球飞得越近）。
                // d 从 2cm 到 12cm，传递系数从 1.0 线性降到 0.4，强到足以主导几何增益。
                const dEntry = this.cfg.setup.entryBehind;
                const cushion = 1.0 - Math.max(0, Math.min(1, (dEntry - 0.02) / 0.1)) * 0.6;
                const jn = (-(1 + BALL_REST * 0.5) * vn) / totalInv * cushion;
                b.vx -= jn * invBall * nx;
                b.vy -= jn * invBall * ny;
                g.vx[i] += jn * g.invM[i] * nx;
                g.vy[i] += jn * g.invM[i] * ny;
                const tvx = rvx - vn * nx, tvy = rvy - vn * ny;
                const tl = Math.hypot(tvx, tvy);
                if (tl > 1e-9) {
                  const jt = Math.max(-tl / totalInv, -BALL_FRICTION * jn);
                  const tx = tvx / tl, ty = tvy / tl;
                  b.vx -= jt * invBall * tx;
                  b.vy -= jt * invBall * ty;
                  g.vx[i] += jt * g.invM[i] * tx;
                  g.vy[i] += jt * g.invM[i] * ty;
                }
              }
            }
          }
          i = this.next[i];
        }
      }
    }
  }

  // ------------------------------------------------------------- 快照与结算
  private capture() {
    const g = this.grains;
    const count = this.n;
    const buf = new Float32Array(count * 2);
    let k = 0;
    for (let i = 0; i < count; i++) {
      if (!g.alive[i]) continue;
      buf[k++] = g.x[i];
      buf[k++] = g.y[i];
    }
    const b = this.ball;
    const sx = Math.max(this.cfg.profile.xMin + 0.02, Math.min(b.x, this.cfg.profile.xMax - 0.02));
    const surfHere = this.cfg.profile.surfaceY(sx);
    if (!this.airborne && b.y > surfHere + BALL_RADIUS * 0.9 && Math.hypot(b.vx, b.vy) > 1.0) {
      this.airborne = true;
      this.launchVx = b.vx;
      this.launchVy = b.vy;
      this.launchX = b.x;
      this.launchY = b.y;
    }
    // 入沙深度：杆头最低点相对当前沙面
    let pen = 0;
    for (const v of this.club.vertices) {
      const w = this.localToWorld(v.x, v.y);
      if (w.x < this.cfg.profile.xMin || w.x > this.cfg.profile.xMax) continue;
      const depth = this.cfg.profile.surfaceY(w.x) - w.y;
      if (depth > pen) pen = depth;
    }
    if (pen > this.maxPen) this.maxPen = pen;
    this.snapshots.push({
      t: this.t,
      grains: buf.subarray(0, k).slice(),
      grainCount: k / 2,
      clubX: this.club.x,
      clubY: this.club.y,
      clubAngle: this.club.angle,
      ballX: b.x,
      ballY: b.y,
      ballVx: b.vx,
      ballVy: b.vy,
      clubPenetration: pen,
      clubSpeed: Math.hypot(this.club.vx, this.club.vy),
      airborne: this.airborne,
    });
  }

  getSnapshots(): FrameSnapshot[] {
    return this.snapshots;
  }

  private finish(): ShotOutcome {
    const directHit = this.ballClubContactSteps > 6;
    const path: { x: number; y: number }[] = [];
    let launchAngle = 0, launchSpeed = 0, apex = 0, carry = 0, total = 0;
    let escaped = false;
    let reason: string | undefined;

    if (this.airborne) {
      // 球位与沙质修正：同样的挥杆，不同球位的能量传递效率不同。
      // - 干沙 clean：松软沙垫，传递稳定，基准效率；
      // - 湿沙 clean：板结沙杆头易反弹（bounce 被放大），沙粒间黏结消耗能量，
      //   传递效率低且逐次波动大（失败率/散布来源）；
      // - 干沙 plug（煎蛋）：球被覆盖层包裹，需先破土，效率最低、起飞角变钝。
      const lie = this.cfg.lie;
      const firm = this.cfg.sand.firmness;
      let lieEfficiency = 1;
      let lieAngleDelta = 0;
      if (lie === 'plug') {
        // 煎蛋球覆盖层破裂方式每次不同，效率波动大
        lieEfficiency = 0.82 + this.rng.range(-0.24, 0.2);
        lieAngleDelta = -7; // 破土后弹道偏低、偏钝
      } else if (firm > 0.5) {
        // 湿沙：板结 + 黏结，效率随微观接触链大幅波动（这是湿沙落点散的主因）
        lieEfficiency = 0.86 + this.rng.range(-0.26, 0.12);
      } else {
        // 干沙正常球位最稳定，散布最小
        lieEfficiency = 0.99 + this.rng.range(-0.02, 0.02);
      }
      this.launchVx *= lieEfficiency;
      this.launchVy *= lieEfficiency;
      if (lieAngleDelta !== 0) {
        const a = Math.atan2(this.launchVy, Math.max(this.launchVx, 0.01)) + (lieAngleDelta * Math.PI) / 180;
        const sp = Math.hypot(this.launchVx, this.launchVy);
        this.launchVx = sp * Math.cos(a);
        this.launchVy = sp * Math.sin(a);
      }
      // 沙垫能量折减：杆头从入沙点到球在沙中推进 d 米，能量耗散在推动前方沙柱、
      // 铲起并抛洒沙粒上。d 越大（入沙点离球越远），传递给球的动能越小 → 球越近。
      // 这是“打沙不打球、靠沙带球”的核心：球从不直接受杆头冲击，只获得沙粒的剩余动能。
      const d = this.cfg.setup.entryBehind;
      const energyFactor = 1 - Math.max(0, Math.min(1, (d - 0.02) / 0.1)) * 0.55;
      const speedFactor = Math.sqrt(energyFactor);
      this.launchVx *= speedFactor;
      this.launchVy *= speedFactor;
      // 杆面效应：打开杆面把动能从水平方向重新分配到竖直方向——
      // 起飞角升高、弹道变软、水平落点变近（动能守恒，只改变方向）。
      const openRad = (this.cfg.setup.faceOpen * Math.PI) / 180;
      if (openRad > 0) {
        const sp0 = Math.hypot(this.launchVx, this.launchVy);
        // 打开角的一部分（0.55 系数）转化为额外起飞角，体现沙粒沿开放杆面上爬
        const extraAngle = openRad * 0.55;
        const baseAngle = Math.atan2(this.launchVy, Math.max(this.launchVx, 0.01));
        const newAngle = baseAngle + extraAngle;
        // 开放杆面损失能量（杆面滑过沙粒、沙垫效率下降），24° 时约损失 28%
        const loss = 1 - Math.min(0.28, openRad * 0.7);
        const sp1 = sp0 * loss;
        this.launchVx = sp1 * Math.cos(newAngle);
        this.launchVy = sp1 * Math.sin(newAngle);
      }
      launchAngle = (Math.atan2(this.launchVy, Math.max(this.launchVx, 0.01)) * 180) / Math.PI;
      launchSpeed = Math.hypot(this.launchVx, this.launchVy);
      let x = this.launchX, y = this.launchY;
      let vx = this.launchVx, vy = this.launchVy;
      const step = 1 / 240;
      for (let i = 0; i < 240 * 8; i++) {
        const sp = Math.hypot(vx, vy);
        vx -= AIR_DRAG * sp * vx * step;
        vy -= (GRAVITY + AIR_DRAG * sp * vy) * step;
        x += vx * step;
        y += vy * step;
        apex = Math.max(apex, y - this.launchY);
        if (i % 6 === 0) path.push({ x, y });
        if (!escaped && x >= this.cfg.lipDistance) {
          const lipTop = this.cfg.profile.surfaceY(this.cfg.lipDistance);
          if (y >= lipTop + BALL_RADIUS) escaped = true;
          else { reason = '撞上沙坑前唇，球弹回坑内'; break; }
        }
        if (escaped && y <= this.cfg.greenLevel + BALL_RADIUS && vy < 0) {
          carry = x - this.cfg.lipDistance;
          const groundSpeed = Math.max(0, vx - Math.abs(vy) * 0.45);
          total = carry + (groundSpeed * groundSpeed) / (2 * GRAVITY * 0.55);
          path.push({ x, y });
          break;
        }
      }
      if (escaped && total === 0) {
        carry = Math.max(0, x - this.cfg.lipDistance);
        total = carry;
      }
    } else {
      reason = directHit
        ? '杆头直接砸中球体（打薄），球没能被沙垫平稳带出'
        : '沙量不足或杆头被板结沙弹起，球留在沙坑中';
    }

    return {
      escaped,
      launchAngle,
      launchSpeed,
      carry: Math.max(0, carry),
      total: Math.max(0, total),
      apex,
      directHit,
      maxPenetration: this.maxPen,
      flightPath: path,
      reason,
    };
  }
}
