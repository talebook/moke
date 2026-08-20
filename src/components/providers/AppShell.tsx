'use client';

import { useEffect } from 'react';
import { DebugLogPanel } from '@/components/ui/DebugLogPanel';
import { installConsoleCapture, uninstallConsoleCapture } from '@/lib/debug-log';
import {
  getMokeRuntimePlatform,
  getNativeTopSafeAreaInset,
  shouldApplyTopSafeArea,
} from '@/lib/moke-reader';
import { useDeveloperStore } from '@/lib/store/developer';
import { resolveTheme, useSettingsStore } from '@/lib/store/settings';
import { NativeBackNavigation } from './NativeBackNavigation';
import { PrivacyConsentGate } from './PrivacyConsentGate';

declare global {
  interface Window {
    MokeWindowMode?: {
      isInMultiWindowMode: () => boolean;
    };
  }
}

// 开发环境尽早 patch console，使 console.error/warn/log 也进入调试面板。
// 生产环境默认不启用（见下方 useEffect 的开发者解锁门控），避免为所有用户
// 全局 patch console 并缓存日志（内存/性能与敏感信息暴露考量）。
if (process.env.NODE_ENV !== 'production') {
  installConsoleCapture();
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const eink = useSettingsStore((s) => s.eink);
  const theme = useSettingsStore((s) => s.theme);
  const developerUnlocked = useDeveloperStore((s) => s.unlocked);

  // Manual override: set the [data-eink='true'] attribute (same signal readest
  // uses) so Moke + the embedded reader share one convention. Auto e-ink
  // styling is applied via CSS media queries regardless.
  useEffect(() => {
    const el = document.documentElement;
    if (eink) el.setAttribute('data-eink', 'true');
    else el.removeAttribute('data-eink');
  }, [eink]);

  // Appearance theme: 'light' | 'dark' | 'system'. E-ink mode suppresses the
  // dark palette, including the auto-detected slow-refresh/monochrome path.
  useEffect(() => {
    const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
    const autoEinkMq = window.matchMedia('(update: slow), (max-color: 1)');
    const apply = () => {
      const resolved = resolveTheme(theme, darkMq.matches);
      const dark = !eink && !autoEinkMq.matches && resolved === 'dark';
      const el = document.documentElement;
      el.classList.toggle('dark', dark);
      el.style.colorScheme = dark ? 'dark' : 'light';
    };
    apply();
    darkMq.addEventListener('change', apply);
    autoEinkMq.addEventListener('change', apply);
    return () => {
      darkMq.removeEventListener('change', apply);
      autoEinkMq.removeEventListener('change', apply);
    };
  }, [theme, eink]);

  // 生产环境仅在开发者解锁后安装 console 捕获；锁定后撤销。
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (developerUnlocked) installConsoleCapture();
    else uninstallConsoleCapture();
  }, [developerUnlocked]);

  // Android/iOS use edge-to-edge WebViews, while OHOS already lays the WebView
  // out below its status bar. Mark only the runtimes that need the CSS top
  // inset. Native values avoid Android WebView cold-start bugs where the CSS
  // safe-area env remains 0; a bounded retry covers the native bridge/window
  // insets not being ready during the first frames of app startup. Android
  // multi-window already places the WebView below the system status bar, so it
  // must not receive the full-screen inset again.
  useEffect(() => {
    const el = document.documentElement;
    let cancelled = false;
    let runtimePlatform: string | null = null;
    let retryTimer: number | undefined;
    let detectionId = 0;
    const maxAttempts = 12;

    const clearRetry = () => {
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
    };

    const detectSafeArea = async (attempt = 0): Promise<void> => {
      const currentDetectionId = ++detectionId;
      clearRetry();
      try {
        const platform = runtimePlatform ?? await getMokeRuntimePlatform();
        if (cancelled || currentDetectionId !== detectionId) return;
        runtimePlatform = platform;
        let isMultiWindow = false;
        if (platform === 'android') {
          try {
            isMultiWindow = window.MokeWindowMode?.isInMultiWindowMode() === true;
          } catch {
            // Older Android builds do not expose the window-mode bridge.
          }
        }
        const enabled = shouldApplyTopSafeArea(platform, isMultiWindow);
        el.dataset.mokeRuntimePlatform = platform;
        el.toggleAttribute('data-moke-top-safe-area', enabled);

        if (!enabled) {
          el.style.removeProperty('--moke-top-safe-area');
          return;
        }

        const top = await getNativeTopSafeAreaInset(platform, window.devicePixelRatio);
        if (cancelled || currentDetectionId !== detectionId) return;
        if (top > 0) {
          el.style.setProperty('--moke-top-safe-area', `${top}px`);
          return;
        }

        // Keep CSS env(...) as the fallback while native insets initialize.
        el.style.removeProperty('--moke-top-safe-area');
        if (attempt + 1 < maxAttempts) {
          retryTimer = window.setTimeout(() => {
            void detectSafeArea(attempt + 1);
          }, 250);
        }
      } catch (error) {
        if (cancelled || currentDetectionId !== detectionId) return;
        if (attempt + 1 < maxAttempts) {
          retryTimer = window.setTimeout(() => {
            void detectSafeArea(attempt + 1);
          }, 250);
        } else {
          console.warn('Unable to initialize the top safe area:', error);
        }
      }
    };

    const refreshSafeArea = () => {
      if (!cancelled) void detectSafeArea();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshSafeArea();
    };

    void detectSafeArea();
    window.addEventListener('pageshow', refreshSafeArea);
    window.addEventListener('resize', refreshSafeArea);
    window.addEventListener('moke:window-mode-change', refreshSafeArea);
    window.addEventListener('orientationchange', refreshSafeArea);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      clearRetry();
      window.removeEventListener('pageshow', refreshSafeArea);
      window.removeEventListener('resize', refreshSafeArea);
      window.removeEventListener('moke:window-mode-change', refreshSafeArea);
      window.removeEventListener('orientationchange', refreshSafeArea);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      delete el.dataset.mokeRuntimePlatform;
      el.removeAttribute('data-moke-top-safe-area');
      el.style.removeProperty('--moke-top-safe-area');
    };
  }, []);

  return (
    <>
      <div className="moke-app-root">
        <NativeBackNavigation />
        <PrivacyConsentGate>{children}</PrivacyConsentGate>
      </div>
      <DebugLogPanel />
    </>
  );
}
