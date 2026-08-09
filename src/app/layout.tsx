'use client';

import '@/app/globals.css';
import { useEffect } from 'react';
import { ServerProvider } from '@/components/providers/ServerProvider';
import { ReaderProgressProvider } from '@/components/providers/ReaderProgressProvider';
import { DebugLogPanel } from '@/components/ui/DebugLogPanel';
import { installConsoleCapture, uninstallConsoleCapture } from '@/lib/debug-log';
import { useDeveloperStore } from '@/lib/store/developer';
import { useSettingsStore } from '@/lib/store/settings';

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
  const developerUnlocked = useDeveloperStore((s) => s.unlocked);

  // Manual override: set the [data-eink='true'] attribute (same signal readest
  // uses) so Moke + the embedded reader share one convention. Auto e-ink
  // styling is applied via CSS media queries regardless.
  useEffect(() => {
    document.documentElement.setAttribute('data-eink', eink.toString());
  }, [eink]);

  // 生产环境仅在开发者解锁后安装 console 捕获；锁定后撤销。
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (developerUnlocked) installConsoleCapture();
    else uninstallConsoleCapture();
  }, [developerUnlocked]);

  return (
    <html lang="zh-CN" className="light">
      <head>
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
