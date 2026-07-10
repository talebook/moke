import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SettingsState {
  // Manual force switch. Auto e-ink styling is handled in CSS via media queries
  // (@media (update: slow), (max-color: 1)); this just adds the .eink class for
  // devices the media queries don't catch (e.g. desktop Tauri WebView).
  eink: boolean;
  setEink: (v: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      eink: false,
      setEink: (v) => set({ eink: v }),
    }),
    { name: 'moke-settings' }
  )
);
