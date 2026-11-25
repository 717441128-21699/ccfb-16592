import { HOLES, BUNKERS, SANDS } from '../physics/configs';
import type { GameState } from '../state';
import { el, clear } from '../dom';

export function renderHolesPage(root: HTMLElement, state: GameState, go: (p: GameState['page']) => void) {
  clear(root);
  const wrap = el('div', { class: 'scroll' });
  const head = el('div', { class: 'title-row' }, [
    el('h2', {}, '选择球洞'),
    el('span', { class: 'small' }, '每个洞组合了不同沙质、沙坑形状与推荐球位'),
  ]);
  wrap.append(head);

  const grid = el('div', { class: 'hole-grid' });
  for (const hole of HOLES) {
    const bunker = BUNKERS.find((b) => b.id === hole.bunkerId)!;
    const sand = SANDS[hole.sand];
    const done = state.completed[hole.id];
    const card = el('div', { class: 'card hole-card' }, [
      el('div', { class: 'row', style: 'justify-content:space-between' }, [
        el('h3', {}, hole.name),
        done != null ? el('span', { class: 'tag' }, `最佳 ${done} 杆`) : el('span', { class: 'tag hard' }, '未完成'),
      ]),
      el('p', { class: 'small', style: 'min-height:42px' }, hole.story),
      el('div', { class: 'row', style: 'margin:8px 0' }, [
        el('span', { class: `tag ${hole.sand}` }, sand.label),
        el('span', { class: 'tag' }, bunker.label),
        el('span', { class: 'tag' }, `Par ${hole.par}`),
        el('span', { class: 'tag' }, `旗距 ${hole.pinDistance}m`),
      ]),
      el('div', { class: 'small' }, `唇高 ${bunker.lipHeight}m · 唇距 ${bunker.lipDistance}m · 坑宽 ${bunker.width}m`),
    ]);
    card.addEventListener('click', () => {
      state.holeId = hole.id;
      state.strokes = 0;
      state.lastOutcome = null;
      // 第 3 洞默认煎蛋球位
      state.lie = hole.id === 3 ? 'plug' : 'clean';
      go('shot');
    });
    grid.append(card);
  }
  wrap.append(grid);

  const explain = el('div', { class: 'card', style: 'margin-top:18px' }, [
    el('h3', { style: 'margin-top:0' }, '沙坑球要点（教练视角）'),
    el('ul', { class: 'small', style: 'line-height:1.9' }, [
      el('li', {}, '打沙不打球：杆头从球后几厘米切进沙里，靠被铲起的沙把球带出去。'),
      el('li', {}, '入沙点离球越远 → 带起的沙越多 → 球飞得越近。'),
      el('li', {}, '杆底反弹角（bounce）越大 → 杆底在沙里滑行而非下挖 → 切得越浅。'),
      el('li', {}, '杆面打开越多 → 球飞得越高、越软，落点越近。'),
      el('li', {}, '干沙松软易挖深；雨后湿沙板结，杆头容易被弹起；煎蛋半埋球最难。'),
    ]),
  ]);
  wrap.append(explain);
  root.append(wrap);
}
