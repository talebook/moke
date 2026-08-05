import '@/app/globals.css';
import { EinkAttributeSetter } from '@/components/EinkAttributeSetter';
import { ServerProvider } from '@/components/providers/ServerProvider';
import { ReaderProgressProvider } from '@/components/providers/ReaderProgressProvider';
import { DebugLogPanel } from '@/components/ui/DebugLogPanel';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" className="light">
      <head>
        {/* Keep the first render independent from third-party font servers. The
            system stack in globals.css avoids a render-blocking Google Fonts
            request on LAN/Tauri deployments. */}
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <EinkAttributeSetter />
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
