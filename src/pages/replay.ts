import { BUNKERS, HOLES, SANDS } from '../physics/configs';
import type { GameState } from '../state';
import { el, clear, fmt } from '../dom';
import { Profile2D } from '../render/Profile2D';

export function renderReplayPage(root: HTMLElement, state: GameState, go: (p: GameState['page']) => void) {
  clear(root);
  const hole = HOLES.find((h) => h.id === state.holeId)!;
  const bunker = BUNKERS.find((b) => b.id === hole.bunkerId)!;
  const sand = SANDS[hole.sand];
  const snaps = state.lastSnapshots;
  const out = state.lastOutcome;

  const layout = el('div', { class: 'replay-layout' });
  const canvas = el('canvas', { class: 'replay-canvas' }) as HTMLCanvasElement;
  const side = el('div', { class: 'sidebar' });

  if (!snaps.length || !out) {
    side.append(el('p', {}, '还没有击球记录。'));
    const back = el('button', { class: 'btn' }, '返回击球');
    back.addEventListener('click', () => go('shot'));
    side.append(back);
    layout.append(el('div', { class: 'viewport' }, [canvas]), side);
    root.append(layout);
    return;
  }

  const renderer = new Profile2D(canvas, sand, bunker);
  let idx = 0;
  let playing = true;
  let speed = 0.12; // 慢放速度倍率
  let raf = 0;
  let last = performance.now();
  let acc = 0;

  const frameInfo = el('div', { class: 'small' }, '');
  const loop = (now: number) => {
    const dt = (now - last) / 1000;
    last = now;
    if (playing) {
      acc += dt * speed;
      const frameDur = snaps[1] ? snaps[1].t - snaps[0].t : 1 / 375;
      const adv = Math.floor(acc / frameDur);
      if (adv > 0) {
        acc -= adv * frameDur;
        idx = Math.min(snaps.length - 1, idx + adv);
      }
      if (idx >= snaps.length - 1) {
        // 停在最后一帧，循环回开头
        playing = false;
        playBtn.textContent = '▶ 重播慢放';
      }
    }
    renderer.render(snaps[idx]);
    const s = snaps[idx];
    frameInfo.innerHTML = `时间 <b>${fmt(s.t * 1000, 1)}ms</b> · 帧 ${idx + 1}/${snaps.length} · 杆头速度 <b>${fmt(s.clubSpeed, 1)}m/s</b> · 入沙深度 <b>${fmt(s.clubPenetration * 100, 1)}cm</b>`;
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  // 控件
  const playBtn = el('button', { class: 'btn primary' }, '⏸ 暂停');
  playBtn.addEventListener('click', () => {
    playing = !playing;
    if (playing && idx >= snaps.length - 1) { idx = 0; acc = 0; }
    playBtn.textContent = playing ? '⏸ 暂停' : '▶ 重播慢放';
  });
  const scrub = el('input', { type: 'range', min: '0', max: String(snaps.length - 1), value: '0' }) as HTMLInputElement;
  scrub.addEventListener('input', () => {
    idx = parseInt(scrub.value, 10);
    playing = false;
    playBtn.textContent = '▶ 重播慢放';
  });
  // 同步滑杆（页面卸载时清理，避免定时器泄漏）
  const scrubTimer = setInterval(() => { scrub.value = String(idx); }, 60);

  const speedSeg = el('div', { class: 'seg' });
  [['0.05', '超慢'], ['0.12', '慢放'], ['0.35', '常速']].forEach(([v, lab]) => {
    const b = el('button', { class: v === '0.12' ? 'on' : '' }, lab);
    b.addEventListener('click', () => {
      speed = parseFloat(v);
      speedSeg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
    });
    speedSeg.append(b);
  });

  side.append(
    el('div', { class: 'field' }, [el('label', {}, '入沙剖面慢放（杆底反弹角如何把杆头“骑”上沙面）')]),
    playBtn,
    el('div', { class: 'field' }, [el('label', {}, '时间轴'), scrub]),
    el('div', { class: 'field' }, [el('label', {}, '播放速度'), speedSeg]),
    frameInfo,
  );

  // 击球结果指标
  const metric = (k: string, v: string, cls = '') => el('div', { class: 'metric' }, [el('div', { class: 'k' }, k), el('div', { class: `v ${cls}` }, v)]);
  const metrics = el('div', { class: 'metrics' }, [
    metric('结果', out.escaped ? '成功出坑' : '未能出坑', out.escaped ? 'good' : 'bad'),
    metric('起飞角', `${fmt(out.launchAngle)}°`),
    metric('起飞速度', `${fmt(out.launchSpeed)} m/s`),
    metric('最大入沙深度', `${fmt(out.maxPenetration * 100)} cm`),
    metric('落点距离（距唇）', `${fmt(out.carry)} m`),
    metric('弹道顶点', `${fmt(out.apex)} m`),
  ]);
  side.append(el('h3', { style: 'margin:8px 0 4px' }, '本杆数据'), metrics);
  if (out.reason) side.append(el('div', { class: 'toast-reason' }, '⚠ ' + out.reason));
  if (out.directHit) side.append(el('div', { class: 'toast-reason' }, '⚠ 杆头直接击中球体（打薄），没有形成沙垫。'));

  const leave = () => {
    cancelAnimationFrame(raf);
    clearInterval(scrubTimer);
  };
  const next = el('button', { class: 'btn primary', style: 'margin-top:8px' }, out.escaped ? '查看成绩 →' : '调整打法再来一杆');
  next.addEventListener('click', () => {
    leave();
    go('score');
  });
  const back = el('button', { class: 'btn ghost' }, '返回调整');
  back.addEventListener('click', () => {
    leave();
    go('shot');
  });
  side.append(el('div', { class: 'row' }, [back, next]));

  layout.append(canvas, side);
  root.append(layout);
  return leave;
}
