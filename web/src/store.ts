import { create } from 'zustand';

interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'err';
}

interface UiState {
  toasts: Toast[];
  push: (text: string, kind?: 'ok' | 'err') => void;
  drop: (id: number) => void;
  /**
   * 最近浏览过的语料源 id。
   *
   * 侧栏「模板调整」是个**顶层入口**，但品牌套件是按语料源存的
   * （data/brand-kits/<sourceId>/），所以它得知道去哪个源。
   * 这里记住最近看过的那个，刷新页面也不丢（存 localStorage）。
   */
  lastSourceId: number | null;
  rememberSource: (id: number) => void;
}

let seq = 0;

const LAST_SOURCE_KEY = 'xhsflow:lastSourceId';

function readLastSourceId(): number | null {
  try {
    const raw = localStorage.getItem(LAST_SOURCE_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export const useUi = create<UiState>((set) => ({
  toasts: [],
  push: (text, kind = 'ok') => {
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4000);
  },
  drop: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  lastSourceId: readLastSourceId(),
  rememberSource: (id) => {
    set({ lastSourceId: id });
    try {
      localStorage.setItem(LAST_SOURCE_KEY, String(id));
    } catch {
      /* 隐私模式下写不了，忽略即可 */
    }
  },
}));

export function toast(text: string, kind: 'ok' | 'err' = 'ok') {
  useUi.getState().push(text, kind);
}
