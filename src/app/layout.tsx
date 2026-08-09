'use client';

import '@/app/globals.css';
import { useEffect } from 'react';
import { ServerProvider } from '@/components/providers/ServerProvider';
import { ReaderProgressProvider } from '@/components/providers/ReaderProgressProvider';
import { DebugLogPanel } from '@/components/ui/DebugLogPanel';
import { installConsoleCapture } from '@/lib/debug-log';
import { useSettingsStore } from '@/lib/store/settings';

// 在浏览器端尽早 patch console，使 console.error/warn/log 也进入调试面板
installConsoleCapture();

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const eink = useSettingsStore((s) => s.eink);
  const theme = useSettingsStore((s) => s.theme);

  // Manual override: set the [data-eink='true'] attribute (same signal readest
  // uses) so Moke + the embedded reader share one convention. Auto e-ink
  // styling is applied via CSS media queries regardless.
  useEffect(() => {
    document.documentElement.setAttribute('data-eink', eink.toString());
  }, [eink]);

  // Appearance theme: 'light' | 'dark' | 'system'. 'system' resolves through
  // prefers-color-scheme and stays in sync while the app is running. The inline
  // head script below applies the theme before first paint to avoid a flash.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches);
      const el = document.documentElement;
      el.classList.toggle('dark', dark);
      el.style.colorScheme = dark ? 'dark' : 'light';
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* Apply the persisted theme before hydration so the first paint is
            already dark when dark mode is on (no flash of white). Reads the
            zustand persist payload directly; falls back to the OS preference
            for 'system'. Also syncs color-scheme so native scrollbars/form
            controls match the theme.
            Note: the only reason for suppressHydrationWarning on <html> is
            that this script mutates the class attribute before hydration. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=JSON.parse(localStorage.getItem('moke-settings')||'{}');var t=s&&s.state&&s.state.theme||'system';var mq=window.matchMedia('(prefers-color-scheme: dark)');var dark=t==='dark'||(t==='system'&&mq.matches);if(dark){document.documentElement.classList.add('dark');document.documentElement.style.colorScheme='dark'}}catch(e){}})();`,
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
