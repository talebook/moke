'use client';

import '@/app/globals.css';
import { useEffect } from 'react';
import { ServerProvider } from '@/components/providers/ServerProvider';
import { ReaderProgressProvider } from '@/components/providers/ReaderProgressProvider';
import { DebugLogPanel } from '@/components/ui/DebugLogPanel';
import { useSettingsStore } from '@/lib/store/settings';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const eink = useSettingsStore((s) => s.eink);

  // Manual override: set the [data-eink='true'] attribute (same signal readest
  // uses) so Moke + the embedded reader share one convention. Auto e-ink
  // styling is applied via CSS media queries regardless.
  useEffect(() => {
    document.documentElement.setAttribute('data-eink', eink.toString());
  }, [eink]);

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
