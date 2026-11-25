import { BUNKERS, CLUBS, HOLES, SANDS } from '../physics/configs';
import { runShot } from '../physics/simulate';
import type { GameState } from '../state';
import type { LieType } from '../physics/types';
import { el, clear } from '../dom';
import { Scene3D } from '../render/Scene3D';

const LIE_LABEL: Record<LieType, string> = {
  clean: '正常球位',
  half: '半埋',
  plug: '煎蛋（深埋）',
};

export function renderShotPage(root: HTMLElement, state: GameState, go: (p: GameState['page']) => void) {
  clear(root);
  const hole = HOLES.find((h) => h.id === state.holeId)!;
  const bunker = BUNKERS.find((b) => b.id === hole.bunkerId)!;
  const sand = SANDS[hole.sand];

  const layout = el('div', { class: 'shot-layout' });
  const viewport = el('div', { class: 'viewport' });
  const canvas = el('canvas', {}) as HTMLCanvasElement;
  viewport.append(canvas);

  const hud = el('div', { class: 'hud' }, [
    el('span', { class: 'chip' }, `${hole.name}`),
    el('span', { class: 'chip' }, `沙质：<b>${sand.label}</b>`),
    el('span', { class: 'chip' }, `球位：<b id="hud-lie">${LIE_LABEL[state.lie]}</b>`),
    el('span', { class: 'chip' }, `第 <b id="hud-stroke">${state.strokes + 1}</b> 杆`),
  ]);
  viewport.append(hud);
  viewport.append(el('div', { class: 'hint' }, '拖拽旋转视角 · 滚轮缩放'));

  const overlay = el('div', { class: 'overlay', hidden: '' }, [
    el('div', { class: 'spinner' }),
    el('div', { id: 'sim-status' }, '正在按颗粒求解沙坑物理…'),
    el('div', { class: 'progress' }, [el('i', { id: 'sim-bar', style: 'width:0%' })]),
  ]);
  viewport.append(overlay);

  const scene = new Scene3D(canvas);
  scene.loadBunker(bunker, sand, hole.pinDistance);
  scene.showLiePreview(state.lie);
  scene.start();

  // --------------------------------------------------------- 侧栏控件
  const sidebar = el('div', { class: 'sidebar' });

  // 球位
  const lieSeg = el('div', { class: 'seg' });
  (['clean', 'half', 'plug'] as LieType[]).forEach((lie) => {
    const btn = el('button', { class: state.lie === lie ? 'on' : '' }, LIE_LABEL[lie]);
    btn.addEventListener('click', () => {
      state.lie = lie;
      lieSeg.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      viewport.querySelector('#hud-lie')!.textContent = LIE_LABEL[lie];
      scene.showLiePreview(lie);
    });
    lieSeg.append(btn);
  });
  sidebar.append(el('div', { class: 'field' }, [el('label', {}, '球位（球陷进沙里的程度）'), lieSeg]));

  // 球杆
  const clubSel = el('select', {});
  for (const c of CLUBS) {
    const opt = el('option', { value: c.id }, c.label) as HTMLOptionElement;
    clubSel.append(opt);
  }
  clubSel.value = state.setup.club.id;
  clubSel.addEventListener('change', () => {
    state.setup.club = CLUBS.find((c) => c.id === clubSel.value)!;
  });
  sidebar.append(el('div', { class: 'field' }, [el('label', {}, '选杆（loft / bounce）'), clubSel]));

  // 滑杆控件工厂
  const slider = (labelText: string, min: number, max: number, step: number, value: number, unit: string, onInput: (v: number) => void) => {
    const val = el('b', {}, `${value}${unit}`);
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) }) as HTMLInputElement;
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      val.textContent = `${v}${unit}`;
      onInput(v);
    });
    return el('div', { class: 'field' }, [el('label', {}, [document.createTextNode(labelText), val]), input]);
  };

  sidebar.append(slider('站位偏移（负=靠近目标，下砸更陡）', -1, 1, 0.1, state.setup.stanceShift, '', (v) => (state.setup.stanceShift = v)));
  sidebar.append(slider('杆面打开角', 0, 28, 1, state.setup.faceOpen, '°', (v) => (state.setup.faceOpen = v)));
  sidebar.append(slider('入沙点（球后方距离）', 0.02, 0.12, 0.005, state.setup.entryBehind, 'm', (v) => {
    state.setup.entryBehind = v;
    scene.showPreview(v, state.setup.faceOpen);
  }));
  sidebar.append(slider('挥杆力度', 0.55, 1, 0.01, state.setup.power, '', (v) => (state.setup.power = v)));

  const tip = el('div', { class: 'small', id: 'setup-tip' }, '');
  sidebar.append(tip);
  const updateTip = () => {
    const d = state.setup.entryBehind * 100;
    tip.innerHTML = `入沙点在球后 <b style="color:var(--accent)">${d.toFixed(1)}cm</b>：越远带沙越多、球越近。当前反弹角 <b>${state.setup.club.bounce}°</b>，${state.setup.club.bounce >= 10 ? '适合松软干沙，杆底会在沙里滑行' : '适合板结湿沙，不容易被沙弹起'}。`;
  };
  updateTip();
  clubSel.addEventListener('change', updateTip);

  const swingBtn = el('button', { class: 'btn primary', style: 'padding:12px;font-size:15px' }, '下杆击球');
  sidebar.append(swingBtn);

  const btnRow = el('div', { class: 'row' }, [
    (() => {
      const b = el('button', { class: 'btn ghost' }, '返回选洞');
      b.addEventListener('click', () => go('holes'));
      return b;
    })(),
  ]);
  sidebar.append(btnRow);

  // --------------------------------------------------------- 击球
  let busy = false;
  swingBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    overlay.hidden = false;
    swingBtn.disabled = true;
    const status = overlay.querySelector('#sim-status') as HTMLElement;
    const bar = overlay.querySelector('#sim-bar') as HTMLElement;
    status.textContent = '正在按颗粒求解沙坑物理…';
    bar.style.width = '30%';
    // 让浏览器先绘制遮罩，再进入同步计算
    await new Promise((r) => setTimeout(r, 30));
    try {
      const result = runShot(state.holeId, state.lie, state.setup, Date.now() & 0xffff, 0.12);
      bar.style.width = '100%';
      state.lastOutcome = result.outcome;
      state.lastSnapshots = result.snapshots;
      state.strokes += 1;
      const hudStroke = viewport.querySelector('#hud-stroke');
      if (hudStroke) hudStroke.textContent = String(state.strokes + 1);
      if (result.snapshots.length) scene.showFrame(result.snapshots[result.snapshots.length - 1]);
      // 先停止渲染并复位遮罩，再切换页面（切换会卸载当前 DOM）
      overlay.hidden = true;
      swingBtn.disabled = false;
      busy = false;
      go('replay');
    } catch (err) {
      overlay.hidden = true;
      swingBtn.disabled = false;
      busy = false;
      status.textContent = '模拟出错：' + (err instanceof Error ? err.message : String(err));
    }
  });

  layout.append(viewport, sidebar);
  root.append(layout);

  return () => scene.stop();
}
