import type { BunkerProfile, ClubDef, SandProps } from './types';

// ---------------------------------------------------------------------------
// 沙质：干沙 vs 雨后湿沙。差异集中在黏结、紧实度、摩擦与恢复系数。
// 干沙松软 → 杆头易挖深、沙粒易飞溅；湿沙板结 → 杆头被反弹角弹开、易打薄。
// ---------------------------------------------------------------------------
export const SANDS: Record<'dry' | 'wet', SandProps> = {
  dry: {
    id: 'dry',
    label: '干沙（松软）',
    grainMass: 0.0009,
    restitution: 0.18,
    friction: 0.55,
    cohesion: 0.0,
    firmness: 0.18,
    hue: 42,
    saturation: 55,
    lightness: 66,
    grainRadius: 0.011,
  },
  wet: {
    id: 'wet',
    label: '湿沙（雨后板结）',
    grainMass: 0.0011,
    restitution: 0.1,
    friction: 0.9,
    cohesion: 1.6,
    firmness: 0.82,
    hue: 38,
    saturation: 42,
    lightness: 46,
    grainRadius: 0.011,
  },
};

// ---------------------------------------------------------------------------
// 球杆：反弹角 bounce 是本游戏的核心变量之一。
// 高 bounce（12°）适合松软干沙，杆底在沙里滑；低 bounce（6°）适合板结湿沙。
// ---------------------------------------------------------------------------
export const CLUBS: ClubDef[] = [
  { id: 'sw56', label: '56° 沙坑杆 · 反弹角 12°', loft: 56, bounce: 12, mass: 0.29, swingRadius: 0.92 },
  { id: 'sw60', label: '60° 高抛杆 · 反弹角 8°', loft: 60, bounce: 8, mass: 0.3, swingRadius: 0.9 },
  { id: 'gw52', label: '52° 中继挖起 · 反弹角 6°', loft: 52, bounce: 6, mass: 0.285, swingRadius: 0.94 },
];

// ---------------------------------------------------------------------------
// 沙坑形状：三种沿击球线的剖面。唇高决定出坑难度。
// ---------------------------------------------------------------------------
export interface BunkerDef {
  id: string;
  label: string;
  /** 球到前唇（目标侧坑沿）的水平距离 */
  lipDistance: number;
  /** 前唇相对球位沙面的高度 */
  lipHeight: number;
  profile: BunkerProfile;
  /** 3D 渲染用的横向宽度 */
  width: number;
}

function makeBunker(
  id: string,
  label: string,
  lipDistance: number,
  lipHeight: number,
  width: number,
): BunkerDef {
  // 球位于 x=0；坑底在球附近较平，向两侧（x<0 后方、x>0 目标方）抬升
  const profile: BunkerProfile = {
    xMin: -1.6,
    xMax: 2.6,
    floorY: -0.55,
    surfaceY: (x: number) => {
      // 前方（目标侧）碗状抬升到唇
      const front = x > 0 ? lipHeight * Math.pow(Math.min(x / lipDistance, 1), 2.2) : 0;
      // 后方缓坡
      const back = x < 0 ? 0.12 * Math.pow(Math.min(-x / 1.4, 1), 2) : 0;
      // 坑底轻微起伏
      const dip = -0.03 * Math.exp(-x * x * 6);
      return front + back + dip;
    },
  };
  return { id, label, lipDistance, lipHeight, profile, width };
}

export const BUNKERS: BunkerDef[] = [
  makeBunker('shallow', '浅碗沙坑（唇高 0.5m）', 2.2, 0.5, 5),
  makeBunker('pot', '壶形沙坑（唇高 1.1m）', 1.7, 1.1, 3.2),
  makeBunker('beach', '海滩大坑（唇高 0.3m，距离长）', 3.4, 0.3, 7),
];

// ---------------------------------------------------------------------------
// 球洞：组合沙质 × 沙坑形状 × 球位
// ---------------------------------------------------------------------------
export interface HoleDef {
  id: number;
  name: string;
  par: number;
  sand: 'dry' | 'wet';
  bunkerId: string;
  /** 球洞旗距沙坑唇的距离（米） */
  pinDistance: number;
  /** 推荐球位（教学说明用），实际可在击球页切换 */
  story: string;
}

export const HOLES: HoleDef[] = [
  {
    id: 1,
    name: '第 1 洞 · 练习沙坑',
    par: 2,
    sand: 'dry',
    bunkerId: 'shallow',
    pinDistance: 9,
    story: '干沙、浅碗、正常球位。先感受“打沙不打球”：入沙点放在球后 4~6cm。',
  },
  {
    id: 2,
    name: '第 2 洞 · 雨后壶坑',
    par: 3,
    sand: 'wet',
    bunkerId: 'pot',
    pinDistance: 14,
    story: '昨夜下雨，湿沙板结、前唇高。低反弹角杆头更不容易被沙弹起，入沙点要更靠近球。',
  },
  {
    id: 3,
    name: '第 3 洞 · 煎蛋球',
    par: 3,
    sand: 'dry',
    bunkerId: 'pot',
    pinDistance: 12,
    story: '球高速砸进干沙，半埋成煎蛋。杆面要方正甚至扣一点，入沙点贴近球，靠更陡的下砸把球挖出来。',
  },
];
