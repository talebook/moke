'use client';

import { useEffect } from 'react';
import { DebugLogPanel } from '@/components/ui/DebugLogPanel';
import { installConsoleCapture, uninstallConsoleCapture } from '@/lib/debug-log';
import { getMokeRuntimePlatform, shouldApplyTopSafeArea } from '@/lib/moke-reader';
import { useDeveloperStore } from '@/lib/store/developer';
import { resolveTheme, useSettingsStore } from '@/lib/store/settings';
import { ReaderProgressProvider } from './ReaderProgressProvider';
import { ServerProvider } from './ServerProvider';

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
  // inset; the inset is applied to each page shell so its background still
  // paints behind the status bar and only the page content moves down.
  useEffect(() => {
    const el = document.documentElement;
    let cancelled = false;

    void getMokeRuntimePlatform()
      .then((platform) => {
        if (cancelled) return;
        el.dataset.mokeRuntimePlatform = platform;
        el.toggleAttribute('data-moke-top-safe-area', shouldApplyTopSafeArea(platform));
      })
      .catch((error) => {
        console.warn('Unable to detect runtime platform for the top safe area:', error);
      });

    return () => {
      cancelled = true;
      delete el.dataset.mokeRuntimePlatform;
      el.removeAttribute('data-moke-top-safe-area');
    };
  }, []);

  return (
    <>
      <div className="moke-app-root">
        <ServerProvider>
          <ReaderProgressProvider>{children}</ReaderProgressProvider>
        </ServerProvider>
      </div>
      <DebugLogPanel />
    </>
  );
}
