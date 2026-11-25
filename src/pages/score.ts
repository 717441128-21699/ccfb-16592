import { HOLES } from '../physics/configs';
import { runShot } from '../physics/simulate';
import type { GameState } from '../state';
import type { LieType, ShotSetup } from '../physics/types';
import { el, clear, fmt } from '../dom';

interface LieStat {
  tag: string;
  cls: string;
  rate: number;
  mean: number;
  std: number;
}

export function renderScorePage(root: HTMLElement, state: GameState, go: (p: GameState['page']) => void) {
  clear(root);
  const hole = HOLES.find((h) => h.id === state.holeId)!;
  const out = state.lastOutcome;
  const wrap = el('div', { class: 'scroll' });

  // 本杆成绩
  const pinTotal = hole.pinDistance; // 旗距唇的距离，球落点距唇与之比较
  const error = out?.escaped ? Math.abs(out.carry - pinTotal) : null;
  const head = el('div', { class: 'title-row' }, [
    el('h2', {}, hole.name + ' · 成绩'),
    el('span', { class: 'small' }, `已用 ${state.strokes} 杆 · Par ${hole.par}`),
  ]);
  wrap.append(head);

  const resultCard = el('div', { class: 'card' }, [
    el('div', { class: 'row', style: 'justify-content:space-between' }, [
      el('h3', { style: 'margin:0' }, out?.escaped ? '✅ 成功出沙上果岭' : '❌ 未能出坑'),
      error != null ? el('span', { class: 'tag' }, `距旗偏差 ${fmt(error)} m`) : el('span', { class: 'tag hard' }, '球留在沙坑'),
    ]),
  ]);
  if (out?.reason) resultCard.append(el('p', { class: 'toast-reason' }, out.reason));
  wrap.append(resultCard);

  // 记分：进洞按偏差估算推杆，给出本洞总杆
  const putts = error == null ? 0 : error < 1 ? 1 : error < 3 ? 2 : 3;
  const totalStrokes = state.strokes + putts;
  const scoreCard = el('div', { class: 'card', style: 'margin-top:14px' }, [
    el('h3', { style: 'margin-top:0' }, '本洞记分（估算）'),
    el('table', {}, [
      el('thead', {}, el('tr', {}, [el('th', {}, '项目'), el('th', {}, '数值')])),
      el('tbody', {}, [
        el('tr', {}, [el('td', {}, '沙坑击球杆数'), el('td', {}, String(state.strokes))]),
        el('tr', {}, [el('td', {}, '上果岭后推杆（按距旗偏差）'), el('td', {}, String(putts))]),
        el('tr', {}, [el('td', {}, '本洞总杆'), el('td', {}, `<b>${totalStrokes}</b>`)]),
        el('tr', {}, [el('td', {}, '相对 Par'), el('td', {}, scoreLabel(totalStrokes, hole.par))]),
      ]),
    ]),
  ]);
  // innerHTML 用于 <b>
  scoreCard.querySelectorAll('td')[2].innerHTML = `<b>${totalStrokes}</b>`;
  wrap.append(scoreCard);

  // 记录完成杆数（取最佳）
  if (out?.escaped) {
    const prev = state.completed[hole.id];
    if (prev == null || totalStrokes < prev) state.completed[hole.id] = totalStrokes;
  }

  // ------------------------------------------------------- 三球位对比
  const cmpCard = el('div', { class: 'card', style: 'margin-top:14px' });
  cmpCard.append(el('h3', { style: 'margin-top:0' }, '同样打法在三种球位下的表现（多次重复统计）'));
  cmpCard.append(el('p', { class: 'small' }, '使用你当前的选杆与设置，每个球位重复 10 次颗粒模拟，统计出坑率与落点散布。'));
  const progress = el('div', { class: 'progress' }, [el('i', { style: 'width:0%' })]);
  const statusLine = el('div', { class: 'small', style: 'margin:10px 0' }, '等待开始…');
  cmpCard.append(progress, statusLine);
  const chartHost = el('div', {});
  cmpCard.append(chartHost);
  wrap.append(cmpCard);

  const runCompare = async () => {
    const lies: { tag: string; lie: LieType; cls: string; holeId: number }[] = [
      { tag: '干沙·正常', lie: 'clean', cls: '', holeId: 1 },
      { tag: '湿沙·正常', lie: 'clean', cls: 'wet', holeId: 2 },
      { tag: '干沙·煎蛋', lie: 'plug', cls: 'plug', holeId: 3 },
    ];
    const setup: ShotSetup = { ...state.setup };
    const stats: LieStat[] = [];
    const ATTEMPTS = 10;
    for (let li = 0; li < lies.length; li++) {
      const item = lies[li];
      statusLine.textContent = `正在计算：${item.tag}（0/${ATTEMPTS}）`;
      // 逐次执行以更新进度并让出主线程
      const carries: number[] = [];
      let escapes = 0;
      for (let k = 0; k < ATTEMPTS; k++) {
        await new Promise((r) => setTimeout(r, 0));
        const r = runShot(item.holeId, item.lie, setup, 2000 + li * 100 + k, 0.12).outcome;
        if (r.escaped) { escapes++; carries.push(r.carry); }
        const pct = ((li * ATTEMPTS + k + 1) / (lies.length * ATTEMPTS)) * 100;
        (progress.firstChild as HTMLElement).style.width = pct + '%';
        statusLine.textContent = `正在计算：${item.tag}（${k + 1}/${ATTEMPTS}）`;
      }
      const mean = carries.length ? carries.reduce((a, b) => a + b, 0) / carries.length : 0;
      const std = carries.length > 1
        ? Math.sqrt(carries.reduce((a, b) => a + (b - mean) ** 2, 0) / (carries.length - 1)) : 0;
      stats.push({ tag: item.tag, cls: item.cls, rate: escapes / ATTEMPTS, mean, std });
    }
    statusLine.textContent = '计算完成。';
    renderChart(chartHost, stats);
    renderTable(cmpCard, stats);
  };

  // 操作按钮
  const btnRow = el('div', { class: 'row', style: 'margin-top:16px' });
  const cmpBtn = el('button', { class: 'btn primary' }, '运行三球位对比');
  cmpBtn.addEventListener('click', () => { cmpBtn.disabled = true; void runCompare(); });
  const again = el('button', { class: 'btn' }, '再来一杆');
  again.addEventListener('click', () => go('shot'));
  const holes = el('button', { class: 'btn ghost' }, '返回选洞');
  holes.addEventListener('click', () => go('holes'));
  btnRow.append(cmpBtn, again, holes);
  wrap.append(btnRow);
  root.append(wrap);
}

function renderChart(host: HTMLElement, stats: LieStat[]) {
  clear(host);
  const maxRate = 1;
  const chart = el('div', { class: 'bar-chart' });
  for (const s of stats) {
    const h = (s.rate / maxRate) * 100;
    const bar = el('div', { class: `bar ${s.cls}`, style: `height:${Math.max(3, h)}%` });
    const col = el('div', { class: 'bar-col' }, [
      el('div', { class: 'val' }, `${Math.round(s.rate * 100)}%`),
      bar,
      el('div', { class: 'lab' }, `${s.tag}<br>σ=${fmt(s.std, 2)}m`),
    ]);
    col.querySelector('.lab')!.innerHTML = `${s.tag}<br>σ=${fmt(s.std, 2)}m`;
    chart.append(col);
  }
  host.append(el('div', { class: 'small', style: 'margin-bottom:4px' }, '出坑成功率（柱高）与落点标准差 σ（越散越大）'), chart);
}

function renderTable(card: HTMLElement, stats: LieStat[]) {
  const old = card.querySelector('table');
  if (old) old.remove();
  const table = el('table', { style: 'margin-top:14px' }, [
    el('thead', {}, el('tr', {}, [
      el('th', {}, '球位'), el('th', {}, '出坑率'), el('th', {}, '平均落点(m)'), el('th', {}, '散布 σ(m)'),
    ])),
    el('tbody', {}, stats.map((s) => el('tr', {}, [
      el('td', {}, s.tag),
      el('td', {}, Math.round(s.rate * 100) + '%'),
      el('td', {}, s.rate > 0 ? fmt(s.mean, 2) : '—'),
      el('td', {}, s.rate > 0 ? fmt(s.std, 2) : '—'),
    ]))),
  ]);
  card.append(table);
}

function scoreLabel(strokes: number, par: number): string {
  const d = strokes - par;
  if (d <= -2) return `${-d} 鹰（Eagle 及更佳）`;
  if (d === -1) return '小鸟（Birdie）';
  if (d === 0) return '标准杆（Par）';
  if (d === 1) return '柏忌（Bogey）';
  return `+${d}（${d} 柏忌）`;
}
