import './styles.css';
import { loadState, saveState, type GameState, type Page } from './state';
import { renderHolesPage } from './pages/holes';
import { renderShotPage } from './pages/shot';
import { renderReplayPage } from './pages/replay';
import { renderScorePage } from './pages/score';
import { el } from './dom';

const state = loadState();
const app = document.getElementById('app')!;

let cleanup: (() => void) | null = null;

const PAGE_TITLE: Record<Page, string> = {
  holes: '球洞选择',
  shot: '沙坑击球',
  replay: '入沙剖面慢放',
  score: '成绩',
};

function go(page: Page) {
  state.page = page;
  saveState(state);
  render();
}

function render() {
  if (cleanup) { cleanup(); cleanup = null; }
  app.innerHTML = '';

  const bar = el('div', { class: 'topbar' }, [
    el('h1', {}, '沙坑切击 · Bunker Wedge'),
    el('span', { class: 'crumb' }, PAGE_TITLE[state.page]),
    el('div', { class: 'spacer' }),
  ]);
  // 导航按钮
  const navHoles = el('button', { class: 'btn ghost' }, '选洞');
  navHoles.addEventListener('click', () => go('holes'));
  bar.append(navHoles);
  app.append(bar);

  const pageHost = el('div', { class: 'page' });
  app.append(pageHost);

  if (state.page === 'holes') {
    renderHolesPage(pageHost, state, go);
  } else if (state.page === 'shot') {
    cleanup = renderShotPage(pageHost, state, go) ?? null;
  } else if (state.page === 'replay') {
    cleanup = renderReplayPage(pageHost, state, go) ?? null;
  } else {
    renderScorePage(pageHost, state, go);
  }
}

render();
