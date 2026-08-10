'use client';

import '@/app/globals.css';
import { useEffect } from 'react';
import { ServerProvider } from '@/components/providers/ServerProvider';
import { ReaderProgressProvider } from '@/components/providers/ReaderProgressProvider';
import { DebugLogPanel } from '@/components/ui/DebugLogPanel';
import { installConsoleCapture, uninstallConsoleCapture } from '@/lib/debug-log';
import { useDeveloperStore } from '@/lib/store/developer';
import { resolveTheme, useSettingsStore } from '@/lib/store/settings';

// 开发环境尽早 patch console，使 console.error/warn/log 也进入调试面板。
// 生产环境默认不启用（见下方 useEffect 的开发者解锁门控），避免为所有用户
// 全局 patch console 并缓存日志（内存/性能与敏感信息暴露考量）。
if (process.env.NODE_ENV !== 'production') {
  installConsoleCapture();
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const eink = useSettingsStore((s) => s.eink);
  const theme = useSettingsStore((s) => s.theme);
  const developerUnlocked = useDeveloperStore((s) => s.unlocked);

  // Manual override: set the [data-eink='true'] attribute (same signal readest
  // uses) so Moke + the embedded reader share one convention. Auto e-ink
  // styling is applied via CSS media queries regardless. Use set/remove so the
  // attribute is absent when e-ink is off (matching the inline head script and
  // the auto media-query path, which never set it) — a lingering
  // data-eink="false" would be read as "present" by any hasAttribute/truthy
  // check (e.g. window.__MOKE_EINK in the reader bridge).
  useEffect(() => {
    const el = document.documentElement;
    if (eink) el.setAttribute('data-eink', 'true');
    else el.removeAttribute('data-eink');
  }, [eink]);

  // Appearance theme: 'light' | 'dark' | 'system'. 'system' resolves through
  // prefers-color-scheme and stays in sync while the app is running. The inline
  // head script below applies the theme before first paint to avoid a flash.
  //
  // E-ink mode is its own standalone theme: while it's on we never add the
  // 'dark' class (nor switch color-scheme), so the black/white e-ink rules are
  // the only ones in play and never fight the dark palette (see globals.css).
  // This includes the *auto* e-ink path — devices that match the slow-refresh /
  // monochrome media query but never get the manual data-eink toggle (e.g. a
  // Kindle-class screen with the OS set to dark). We fold that media query into
  // the same gate so auto-e-ink also suppresses the dark palette.
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

  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* Apply the persisted theme before hydration so the first paint is
            already dark when dark mode is on (no flash of white). Reads the
            zustand persist payload directly; falls back to the OS preference
            for 'system'. Also syncs color-scheme so native scrollbars/form
            controls match the theme. E-ink mode suppresses dark entirely AND
            sets data-eink before first paint, so an e-ink user doesn't get a
            warm-light flash before the effect runs.
            WARNING: this duplicates resolveTheme() from src/lib/store/settings.ts
            and assumes the zustand persist shape { state: { theme, eink } } —
            keep it in sync when either changes (tests/theme-init.test.mjs
            asserts this).
            Note: the only reason for suppressHydrationWarning on <html> is
            that this script mutates the class attribute before hydration. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=JSON.parse(localStorage.getItem('moke-settings')||'{}');var st=s&&s.state||{};var t=st.theme||'system';var eink=!!st.eink;var el=document.documentElement;if(eink){el.setAttribute('data-eink','true')}var darkMq=window.matchMedia('(prefers-color-scheme: dark)');var autoEink=window.matchMedia('(update: slow), (max-color: 1)').matches;var dark=!eink&&!autoEink&&(t==='dark'||(t==='system'&&darkMq.matches));if(dark){el.classList.add('dark');el.style.colorScheme='dark'}else{el.style.colorScheme='light'}}catch(e){}})();/*MOKE-THEME-INIT*/`,
          }}
        />
        {/* Keep the first render independent from third-party font servers. The
            system stack in globals.css avoids a render-blocking Google Fonts
            request on LAN/Tauri deployments. */}
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <ServerProvider>
          <ReaderProgressProvider>
            {children}
          </ReaderProgressProvider>
        </ServerProvider>
        <DebugLogPanel />
      </body>
    </html>
  );
}
