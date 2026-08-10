import { create } from 'zustand';

let timer: ReturnType<typeof setTimeout> | null = null;

export const useToast = create<{
  message: string | null;
  type: 'error' | 'info';
  show: (msg: string, type?: 'error' | 'info') => void;
  dismiss: () => void;
}>((set) => ({
  message: null,
  type: 'info',
  show: (msg, type = 'info') => {
    if (timer) clearTimeout(timer);
    set({ message: msg, type });
    timer = setTimeout(() => set({ message: null }), 5000);
  },
  dismiss: () => {
    if (timer) clearTimeout(timer);
    set({ message: null });
  },
}));
