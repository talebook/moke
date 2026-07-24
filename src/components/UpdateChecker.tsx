'use client';

import { useEffect } from 'react';
import { useUpdateStore } from '@/lib/store/update';
import { Download, X } from 'lucide-react';

export function UpdateChecker() {
  const status = useUpdateStore((s) => s.status);
  const availableVersion = useUpdateStore((s) => s.availableVersion);
  const releaseNotes = useUpdateStore((s) => s.releaseNotes);
  const error = useUpdateStore((s) => s.error);
  const shouldPrompt = useUpdateStore((s) => s.shouldPrompt);
  const initialize = useUpdateStore((s) => s.initialize);
  const installUpdate = useUpdateStore((s) => s.installUpdate);
  const dismissPrompt = useUpdateStore((s) => s.dismissPrompt);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  // Only Tauri desktop
  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') return null;

  const show = shouldPrompt && availableVersion && (status === 'available' || status === 'downloaded');

  if (!show) return null;

  return (
    <div className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))] left-1/2 z-[120] w-[min(360px,calc(100vw-2rem))] -translate-x-1/2 md:bottom-4">
      <div className="bg-card border border-border rounded-2xl shadow-lg p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Download className="w-4 h-4 text-primary" />
            <p className="text-sm font-semibold text-foreground">发现新版本</p>
          </div>
          <button
            onClick={dismissPrompt}
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
          版本 {availableVersion}{status === 'downloaded' ? ' 已下载，重启后生效。' : ' 可更新。'}
        </p>

        {releaseNotes && (
          <div className="mt-2 max-h-28 overflow-y-auto rounded-lg bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground whitespace-pre-wrap">
            {releaseNotes}
          </div>
        )}

        {error && (
          <p className="mt-2 text-xs text-destructive">{error}</p>
        )}

        <div className="mt-3 flex gap-2">
          <button
            onClick={() => void installUpdate()}
            className="flex-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
          >
            安装并重启
          </button>
          <button
            onClick={dismissPrompt}
            className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            稍后
          </button>
        </div>
      </div>
    </div>
  );
}
