import { CLUBS } from '../src/physics/configs';
import { evaluateSpread, runShot } from '../src/physics/simulate';
import type { LieType, ShotSetup } from '../src/physics/types';

const base = (over: Partial<ShotSetup> = {}): ShotSetup => ({
  club: CLUBS[0], // 56° bounce12
  stanceShift: 0,
  faceOpen: 10,
  entryBehind: 0.05,
  power: 0.72,
  ...over,
});

function line(s: string) {
  console.log(s);
}

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  line(`${pass ? 'PASS' : 'FAIL'}  ${name}  —— ${detail}`);
}

async function main() {
  // ---- 趋势 1：入沙点越远，出沙距离越近 -------------------------------
  line('\n=== 趋势1：入沙点 d 增大 → 出沙距离缩短 ===');
  const dVals = [0.03, 0.05, 0.08, 0.11];
  const dStats = dVals.map((d) => {
    const s = evaluateSpread(1, 'clean', base({ entryBehind: d }), 4);
    line(`d=${(d * 100).toFixed(0)}cm  出坑率=${(s.escapeRate * 100).toFixed(0)}%  均距=${s.meanCarry.toFixed(2)}m  σ=${s.stdCarry.toFixed(2)}  均穿深=${s.meanPenetration.toFixed(1)}cm  起飞角=${s.meanLaunchAngle.toFixed(1)}°`);
    return { d, s };
  });
  const far = dStats[dStats.length - 1].s.meanCarry;
  const near = dStats[0].s.meanCarry;
  check('入沙点 11cm 的落点显著近于 3cm', far < near * 0.85, `${near.toFixed(2)}m → ${far.toFixed(2)}m`);
  const mono = dStats.slice(1).every((p, i) => p.s.meanCarry <= dStats[i].s.meanCarry + 1.2);
  check('距离随入沙点整体单调（容差1.2m）', mono, '见上');

  // ---- 趋势 2：反弹角越大，入沙越浅 -----------------------------------
  line('\n=== 趋势2：杆底反弹角 bounce 增大 → 最大穿深减小（干松沙）===');
  const bVals = [
    { label: 'bounce6', club: CLUBS[2] },
    { label: 'bounce8', club: CLUBS[1] },
    { label: 'bounce12', club: CLUBS[0] },
  ];
  const bStats = bVals.map(({ label, club }) => {
    const s = evaluateSpread(1, 'clean', base({ club, faceOpen: 0 }), 4);
    line(`${label}  穿深=${s.meanPenetration.toFixed(1)}cm  出坑率=${(s.escapeRate * 100).toFixed(0)}%  均距=${s.meanCarry.toFixed(2)}m  打薄率=${(s.directHitRate * 100).toFixed(0)}%`);
    return { label, s };
  });
  check(
    'bounce12 穿深 < bounce6 穿深',
    bStats[2].s.meanPenetration < bStats[0].s.meanPenetration,
    `${bStats[0].s.meanPenetration.toFixed(1)}cm → ${bStats[2].s.meanPenetration.toFixed(1)}cm`,
  );

  // ---- 趋势 3：干沙 / 湿沙 / 煎蛋 三种球位差异显著 ---------------------
  line('\n=== 趋势3：干沙clean / 湿沙clean / 干沙plug（同打法）===');
  const setup3 = base({ entryBehind: 0.05, faceOpen: 8, power: 0.75 });
  const lies: { tag: string; hole: number; lie: LieType }[] = [
    { tag: '干沙·正常球位', hole: 1, lie: 'clean' },
    { tag: '湿沙·正常球位', hole: 2, lie: 'clean' },
    { tag: '干沙·煎蛋半埋', hole: 3, lie: 'plug' },
  ];
  const lieStats = lies.map(({ tag, hole, lie }) => {
    const s = evaluateSpread(hole, lie, setup3, 10);
    line(`${tag}  出坑率=${(s.escapeRate * 100).toFixed(0)}%  均距=${s.meanCarry.toFixed(2)}m  σ=${s.stdCarry.toFixed(2)}  穿深=${s.meanPenetration.toFixed(1)}cm  打薄率=${(s.directHitRate * 100).toFixed(0)}%  起飞角=${s.meanLaunchAngle.toFixed(1)}°`);
    return { tag, s };
  });
  const rates = lieStats.map((x) => x.s.escapeRate);
  check('三球位出坑率不全相同（差异≥17个百分点）', Math.max(...rates) - Math.min(...rates) >= 0.17, rates.map((r) => `${(r * 100).toFixed(0)}%`).join(' / '));
  const stds = lieStats.map((x) => x.s.stdCarry);
  check('落点散布明显不同（σ 极差≥0.3m）', Math.max(...stds) - Math.min(...stds) >= 0.3, stds.map((v) => v.toFixed(2)).join(' / '));

  // ---- 趋势 4：杆面打开 → 更高更软（角度大、距离短） -------------------
  line('\n=== 趋势4：杆面打开角增大 → 起飞角升高、距离缩短 ===');
  const fVals = [0, 12, 24];
  const fStats = fVals.map((f) => {
    const s = evaluateSpread(1, 'clean', base({ faceOpen: f }), 4);
    line(`打开${f}°  起飞角=${s.meanLaunchAngle.toFixed(1)}°  均距=${s.meanCarry.toFixed(2)}m  顶点=${s.meanApex.toFixed(2)}m`);
    return { f, s };
  });
  check('打开24° 起飞角 > 方正', fStats[2].s.meanLaunchAngle > fStats[0].s.meanLaunchAngle + 3,
    `${fStats[0].s.meanLaunchAngle.toFixed(1)}° → ${fStats[2].s.meanLaunchAngle.toFixed(1)}°`);
  check('打开24° 距离 < 方正', fStats[2].s.meanCarry < fStats[0].s.meanCarry,
    `${fStats[0].s.meanCarry.toFixed(2)}m → ${fStats[2].s.meanCarry.toFixed(2)}m`);

  // ---- 单次结果样例（失败原因等） --------------------------------------
  line('\n=== 单次样例：湿沙 + 高反弹角（预期容易被弹/打薄）===');
  const sample = runShot(2, 'clean', base({ club: CLUBS[0], faceOpen: 20, entryBehind: 0.08, power: 0.7 }), 7);
  line(JSON.stringify({ ...sample.outcome, flightPath: undefined }, null, 1));

  line('\n================ 汇总 ================');
  let passN = 0;
  for (const r of results) {
    line(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
    if (r.pass) passN++;
  }
  line(`${passN}/${results.length} 通过`);
  if (passN !== results.length) process.exitCode = 1;
}

main();
