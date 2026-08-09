import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeMode = 'light' | 'dark' | 'system';

interface SettingsState {
  // Manual force switch. Auto e-ink styling is handled in CSS via media queries
  // (@media (update: slow), (max-color: 1)); this just adds the .eink class for
  // devices the media queries don't catch (e.g. desktop Tauri WebView).
  eink: boolean;
  setEink: (v: boolean) => void;
  // Appearance theme: 'light' | 'dark' | 'system' (follow the OS preference).
  theme: ThemeMode;
  setTheme: (v: ThemeMode) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      eink: false,
      setEink: (v) => set({ eink: v }),
      theme: 'system',
      setTheme: (v) => set({ theme: v }),
    }),
    { name: 'moke-settings' }
  )
);
