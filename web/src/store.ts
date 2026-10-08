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
}

let seq = 0;

export const useUi = create<UiState>((set) => ({
  toasts: [],
  push: (text, kind = 'ok') => {
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4000);
  },
  drop: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function toast(text: string, kind: 'ok' | 'err' = 'ok') {
  useUi.getState().push(text, kind);
}