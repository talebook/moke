'use client';

import { useEffect } from 'react';
import { DebugLogPanel } from '@/components/ui/DebugLogPanel';
import {
  broadcastDebugPanelVisibility,
  installConsoleCapture,
  installDebugLogBridge,
  uninstallConsoleCapture,
} from '@/lib/debug-log';
import {
  getMokeRuntimePlatform,
  getNativeTopSafeAreaInset,
  showMokeSystemStatusBar,
  shouldApplyTopSafeArea,
} from '@/lib/moke-reader';
import { createBoundedRetryCache } from '@/lib/bounded-retry-cache';
import { shouldPreventNativeAppZoomShortcut } from '@/lib/native-app-zoom';
import { getDebugPanelLaunchState, useDeveloperStore } from '@/lib/store/developer';
import { resolveTheme, useSettingsStore } from '@/lib/store/settings';
import { NativeBackNavigation } from './NativeBackNavigation';
import { PrivacyConsentGate } from './PrivacyConsentGate';

declare global {
  interface Window {
    MokeWindowMode?: {
      isInMultiWindowMode: () => boolean;
      showStatusBar?: (darkMode: boolean) => void;
    };
  }
}

// 开发环境尽早 patch console，使 console.error/warn/log 也进入调试面板。
// 生产环境默认不启用（见下方 useEffect 的开发者解锁门控），避免为所有用户
// 全局 patch console 并缓存日志（内存/性能与敏感信息暴露考量）。
if (process.env.NODE_ENV !== 'production') {
  installConsoleCapture();
}

const isNativeAppBuild = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';

export function AppShell({ children }: { children: React.ReactNode }) {
  const eink = useSettingsStore((s) => s.eink);
  const theme = useSettingsStore((s) => s.theme);
  const developerUnlocked = useDeveloperStore((s) => s.unlocked);
  const showDebugPanel = useDeveloperStore((s) => s.showDebugPanel);

  // The native backend owns the approved directory and restores its fs scope
  // before the WebView starts. Mirror that durable value into the frontend so
  // clearing localStorage cannot make the two sides silently diverge.
  useEffect(() => {
    if (!isNativeAppBuild) return;
    let cancelled = false;
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<string | null>('moke_get_download_directory'))
      .then((directory) => {
        if (!cancelled) useSettingsStore.getState().setDownloadDirectory(directory);
      })
      .catch((error) => {
        if (!cancelled) console.warn('Unable to restore the approved download directory:', error);
      });
    return () => { cancelled = true; };
  }, []);

  // Persist logs across document reloads and bridge them to every embedded
  // Readest window. The visibility handshake lets an already-open reader
  // follow the host toggle without being reopened.
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void installDebugLogBridge({
      source: 'moke',
      getPanelVisible: getDebugPanelLaunchState,
    }).then((uninstall) => {
      if (disposed) uninstall();
      else cleanup = uninstall;
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    broadcastDebugPanelVisibility(showDebugPanel);
  }, [showDebugPanel]);

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
    let cancelled = false;
    const platformCache = createBoundedRetryCache(getMokeRuntimePlatform, {
      maxAttempts: 3,
      retryDelayMs: 250,
    });

    const restoreStatusBar = (dark: boolean) => {
      void platformCache.get()
        .then(async (platform) => {
          if (cancelled) return;
          await showMokeSystemStatusBar(platform, dark, window.MokeWindowMode);
        })
        .catch((error) => {
          if (!cancelled) console.warn('Unable to restore the Moke status bar:', error);
        });
    };

    const apply = () => {
      const resolved = resolveTheme(theme, darkMq.matches);
      const dark = !eink && !autoEinkMq.matches && resolved === 'dark';
      const el = document.documentElement;
      el.classList.toggle('dark', dark);
      el.style.colorScheme = dark ? 'dark' : 'light';
      restoreStatusBar(dark);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') apply();
    };
    apply();
    darkMq.addEventListener('change', apply);
    autoEinkMq.addEventListener('change', apply);
    window.addEventListener('pageshow', apply);
    window.addEventListener('orientationchange', apply);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      cancelled = true;
      darkMq.removeEventListener('change', apply);
      autoEinkMq.removeEventListener('change', apply);
      window.removeEventListener('pageshow', apply);
      window.removeEventListener('orientationchange', apply);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [theme, eink]);

  // 生产环境仅在开发者解锁后安装 console 捕获；锁定后撤销。
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (developerUnlocked) installConsoleCapture();
    else uninstallConsoleCapture();
  }, [developerUnlocked]);

  // Keep the Tauri shell at its designed scale on desktop touchpads and
  // keyboards. Mobile pinch is also declared unavailable in the viewport and
  // touch-action rules. These listeners intentionally do not run in the web
  // build, where browser zoom remains an accessibility feature.
  useEffect(() => {
    if (!isNativeAppBuild) return;

    const preventGestureZoom = (event: Event) => event.preventDefault();
    const preventWheelZoom = (event: WheelEvent) => {
      if (event.ctrlKey) event.preventDefault();
    };
    const preventKeyboardZoom = (event: KeyboardEvent) => {
      if (shouldPreventNativeAppZoomShortcut(event)) event.preventDefault();
    };
    const nonPassive = { passive: false } as const;

    window.addEventListener('wheel', preventWheelZoom, nonPassive);
    window.addEventListener('keydown', preventKeyboardZoom);
    document.addEventListener('gesturestart', preventGestureZoom, nonPassive);
    document.addEventListener('gesturechange', preventGestureZoom, nonPassive);

    return () => {
      window.removeEventListener('wheel', preventWheelZoom);
      window.removeEventListener('keydown', preventKeyboardZoom);
      document.removeEventListener('gesturestart', preventGestureZoom);
      document.removeEventListener('gesturechange', preventGestureZoom);
    };
  }, []);

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
    let refreshFrame: number | undefined;
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
        try {
          window.sessionStorage.setItem('moke-runtime-platform', platform);
        } catch {
          // The dataset still gates same-document transitions when storage is unavailable.
        }
        el.toggleAttribute('data-moke-top-safe-area', enabled);

        if (!enabled) {
          el.style.removeProperty('--moke-top-safe-area');
          return;
        }

        const top = await getNativeTopSafeAreaInset(
          platform,
          window.devicePixelRatio,
          undefined,
          isMultiWindow,
        );
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
    const scheduleSafeAreaRefresh = () => {
      if (cancelled || refreshFrame !== undefined) return;
      refreshFrame = window.requestAnimationFrame(() => {
        refreshFrame = undefined;
        refreshSafeArea();
      });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshSafeArea();
    };

    void detectSafeArea();
    window.addEventListener('pageshow', refreshSafeArea);
    window.addEventListener('resize', scheduleSafeAreaRefresh);
    window.addEventListener('moke:window-mode-change', scheduleSafeAreaRefresh);
    window.addEventListener('orientationchange', refreshSafeArea);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      clearRetry();
      if (refreshFrame !== undefined) window.cancelAnimationFrame(refreshFrame);
      window.removeEventListener('pageshow', refreshSafeArea);
      window.removeEventListener('resize', scheduleSafeAreaRefresh);
      window.removeEventListener('moke:window-mode-change', scheduleSafeAreaRefresh);
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
