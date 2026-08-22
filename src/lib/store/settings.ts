import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeMode = 'light' | 'dark' | 'system';

export type ResolvedTheme = 'light' | 'dark';

/**
 * Single source of truth for resolving a ThemeMode into the actual theme.
 * Used by the layout effect, the settings page, and (as an inlined copy) the
 * anti-flash head script in layout.tsx — keep all three in sync when this
 * changes.
 */
export function resolveTheme(theme: ThemeMode, prefersDark: boolean): ResolvedTheme {
  return theme === 'dark' || (theme === 'system' && prefersDark) ? 'dark' : 'light';
}

interface SettingsState {
  // Manual force switch. Auto e-ink styling is handled in CSS via media queries
  // (@media (update: slow), (max-color: 1)); this just sets the data-eink
  // attribute on <html> (RootLayout) for devices the media queries don't catch
  // (e.g. desktop Tauri WebView).
  eink: boolean;
  setEink: (v: boolean) => void;
  // Appearance theme: 'light' | 'dark' | 'system' (follow the OS preference).
  theme: ThemeMode;
  setTheme: (v: ThemeMode) => void;
  /** Desktop-only directory explicitly selected by the user; null uses AppData/books. */
  downloadDirectory: string | null;
  setDownloadDirectory: (path: string | null) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      eink: false,
      setEink: (v) => set({ eink: v }),
      theme: 'system',
      setTheme: (v) => set({ theme: v }),
      downloadDirectory: null,
      setDownloadDirectory: (downloadDirectory) => set({ downloadDirectory }),
    }),
    { name: 'moke-settings' }
  )
);
