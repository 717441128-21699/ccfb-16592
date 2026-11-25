// 物理世界类型定义 —— 全部基于 2D 挥杆剖面（x = 水平目标方向，y = 竖直向上）
// 单位：米、秒、千克（2D 世界采用单位厚度质量约定，数值经标定后保证趋势正确）

/** 沙质参数：干沙 / 湿沙的力学差异全部通过这组参数体现 */
export interface SandProps {
  id: string;
  label: string;
  /** 颗粒质量（2D 单位厚度） */
  grainMass: number;
  /** 颗粒-颗粒 / 颗粒-地面恢复系数 */
  restitution: number;
  /** 摩擦系数 μ */
  friction: number;
  /** 颗粒间黏结强度（湿沙板结的关键，干沙接近 0） */
  cohesion: number;
  /** 沙床整体紧实度 0..1：影响杆头切入阻力与压痕回弹 */
  firmness: number;
  /** 颗粒颜色基底（渲染用） */
  hue: number;
  saturation: number;
  lightness: number;
  /** 颗粒半径（米） */
  grainRadius: number;
}

/** 球位：球落入沙坑后陷进沙里的程度 */
export type LieType = 'clean' | 'half' | 'plug';

/** 沙坑剖面形状（沿击球线的二维轮廓参数） */
export interface BunkerProfile {
  /** 剖面采样的水平范围 */
  xMin: number;
  xMax: number;
  /** 轮廓高度函数：自由沙面 y(x) */
  surfaceY: (x: number) => number;
  /** 沙层底部（不可穿透） */
  floorY: number;
}

/** 可选球杆（沙坑挖起杆为主） */
export interface ClubDef {
  id: string;
  label: string;
  /** 标称杆面倾角（度） */
  loft: number;
  /** 杆底反弹角 bounce（度） */
  bounce: number;
  /** 杆头有效质量（2D 约定） */
  mass: number;
  /** 杆头在挥杆圆弧上的半径（米） */
  swingRadius: number;
}

/** 玩家在击球页做出的全部决策 */
export interface ShotSetup {
  club: ClubDef;
  /** 站位偏移（米，正值远离目标、负值靠近目标），影响入沙角 */
  stanceShift: number;
  /** 杆面打开角（度，0=方正） */
  faceOpen: number;
  /** 入沙点：杆头首次触沙处位于球后方的距离 d（米，正数） */
  entryBehind: number;
  /** 挥杆力度 0..1 */
  power: number;
}

/** 球的初始状态 */
export interface BallInit {
  x: number;
  /** 球心高度 */
  y: number;
  radius: number;
  lie: LieType;
}

/** 单帧快照，用于剖面慢放回放 */
export interface FrameSnapshot {
  t: number;
  grains: Float32Array; // x,y 交替
  grainCount: number;
  clubX: number;
  clubY: number;
  clubAngle: number;
  ballX: number;
  ballY: number;
  ballVx: number;
  ballVy: number;
  /** 杆头当前穿透沙面的最大深度（米），0 表示未入沙 */
  clubPenetration: number;
  /** 本帧杆头速度 */
  clubSpeed: number;
  /** 球是否已离沙起飞 */
  airborne: boolean;
}

/** 一次击球的结果 */
export interface ShotOutcome {
  /** 是否成功出沙（越过沙坑前唇） */
  escaped: boolean;
  /** 起飞角（度） */
  launchAngle: number;
  /** 起飞速度 m/s */
  launchSpeed: number;
  /** 球从出沙点到落地的飞行距离（米，沿目标方向） */
  carry: number;
  /** 总距离（含滚动） */
  total: number;
  /** 最大弹道高度（相对出沙点） */
  apex: number;
  /** 球是否被杆头直接打中（剃头/打薄），而非被沙带出 */
  directHit: boolean;
  /** 杆头最大入沙深度 */
  maxPenetration: number;
  /** 飞行轨迹采样（x,y） */
  flightPath: { x: number; y: number }[];
  /** 失败原因（未出坑时） */
  reason?: string;
}

export interface Vec2 {
  x: number;
  y: number;
}
