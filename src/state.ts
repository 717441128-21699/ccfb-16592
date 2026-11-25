import type { LieType, ShotSetup, ShotOutcome, FrameSnapshot } from './physics/types';
import { CLUBS } from './physics/configs';

export type Page = 'holes' | 'shot' | 'replay' | 'score';

export interface GameState {
  page: Page;
  holeId: number;
  lie: LieType;
  setup: ShotSetup;
  lastOutcome: ShotOutcome | null;
  lastSnapshots: FrameSnapshot[];
  /** 本洞尝试杆数 */
  strokes: number;
  /** 各洞完成杆数（用于成绩页） */
  completed: Record<number, number>;
}

const STORAGE_KEY = 'bunker-wedge-state-v1';

export function defaultSetup(): ShotSetup {
  return {
    club: CLUBS[0],
    stanceShift: 0,
    faceOpen: 10,
    entryBehind: 0.05,
    power: 0.75,
  };
}

export function initialState(): GameState {
  return {
    page: 'holes',
    holeId: 1,
    lie: 'clean',
    setup: defaultSetup(),
    lastOutcome: null,
    lastSnapshots: [],
    strokes: 0,
    completed: {},
  };
}

export function loadState(): GameState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState();
    const parsed = JSON.parse(raw) as Partial<GameState>;
    const base = initialState();
    // club 需还原为对象引用
    const club = CLUBS.find((c) => c.id === parsed.setup?.club?.id) ?? base.setup.club;
    return {
      ...base,
      ...parsed,
      setup: { ...base.setup, ...parsed.setup, club },
      lastSnapshots: [], // 快照不持久化（体积大）
    };
  } catch {
    return initialState();
  }
}

export function saveState(s: GameState) {
  try {
    const { lastSnapshots: _omit, ...persist } = s;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persist));
  } catch {
    // 存储不可用时静默
  }
}
