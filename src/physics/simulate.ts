import { BUNKERS, HOLES, SANDS } from './configs';
import { SandWorld } from './SandWorld';
import type {
  FrameSnapshot,
  LieType,
  ShotOutcome,
  ShotSetup,
} from './types';

export interface ShotResult {
  outcome: ShotOutcome;
  snapshots: FrameSnapshot[];
}

/** 执行一次完整击球，返回结算与剖面慢放快照 */
export function runShot(
  holeId: number,
  lie: LieType,
  setup: ShotSetup,
  seed = 1,
  jitter = 0.06,
): ShotResult {
  const hole = HOLES.find((h) => h.id === holeId) ?? HOLES[0];
  const bunker = BUNKERS.find((b) => b.id === hole.bunkerId) ?? BUNKERS[0];
  const world = new SandWorld({
    sand: SANDS[hole.sand],
    profile: bunker.profile,
    lie,
    setup,
    seed,
    jitter,
    lipDistance: bunker.lipDistance,
    lipHeight: bunker.lipHeight,
    pinDistance: hole.pinDistance,
    greenLevel: bunker.profile.surfaceY(bunker.lipDistance),
  });
  const outcome = world.run();
  return { outcome, snapshots: world.getSnapshots() };
}

export interface StatSummary {
  attempts: number;
  escapes: number;
  escapeRate: number;
  /** 成功出坑样本的落点距离（距唇）均值与标准差 */
  meanCarry: number;
  stdCarry: number;
  meanApex: number;
  meanLaunchAngle: number;
  meanPenetration: number;
  directHitRate: number;
}

/** 同一打法重复 n 次（仅颗粒排布微扰不同），统计出坑率与落点散布 */
export function evaluateSpread(
  holeId: number,
  lie: LieType,
  setup: ShotSetup,
  attempts = 10,
): StatSummary {
  const carries: number[] = [];
  const apexes: number[] = [];
  const angles: number[] = [];
  const pens: number[] = [];
  let escapes = 0;
  let direct = 0;
  for (let k = 0; k < attempts; k++) {
    const { outcome } = runShot(holeId, lie, setup, 1000 + k * 37, 0.12);
    pens.push(outcome.maxPenetration * 100); // cm
    if (outcome.directHit) direct++;
    if (outcome.escaped) {
      escapes++;
      carries.push(outcome.carry);
      apexes.push(outcome.apex);
      angles.push(outcome.launchAngle);
    }
  }
  const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const std = (a: number[]) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
  };
  return {
    attempts,
    escapes,
    escapeRate: escapes / attempts,
    meanCarry: mean(carries),
    stdCarry: std(carries),
    meanApex: mean(apexes),
    meanLaunchAngle: mean(angles),
    meanPenetration: mean(pens),
    directHitRate: direct / attempts,
  };
}
