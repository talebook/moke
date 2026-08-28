'use client';

import { Sidebar } from '@/components/layout/Sidebar';
import { TabBar } from '@/components/layout/TabBar';
import { UpdateChecker } from '@/components/UpdateChecker';
import { useToast } from '@/lib/toast';
import { X, AlertTriangle, Info } from 'lucide-react';

export function DesktopLayout({ children }: { children: React.ReactNode }) {
  const toast = useToast((s) => s.message);
  const type = useToast((s) => s.type);
  const dismiss = useToast((s) => s.dismiss);

  return (
    <div className="flex h-dvh overflow-hidden app-warm-bg">
      <Sidebar />
      <div className="moke-route-content flex-1 min-w-0 h-full flex flex-col overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom,0px))] lg:ml-[220px] lg:pb-0">
        {children}
      </div>
      <TabBar />
      <UpdateChecker />
      {toast && (
        <div className="fixed top-[calc(1rem+var(--moke-top-safe-area,0px))] left-1/2 z-[1000] w-[min(400px,calc(100vw-2rem))] -translate-x-1/2">
          <div className={`flex items-start gap-3 px-4 py-3 rounded-xl shadow-lg border ${
            type === 'error'
              ? 'bg-destructive border-destructive text-destructive-foreground'
              : 'bg-background border-border text-foreground'
          }`}>
            {type === 'error' ? <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> : <Info className="w-4 h-4 shrink-0 mt-0.5" />}
            <p className="text-sm flex-1">{toast}</p>
            <button onClick={dismiss} className="shrink-0 opacity-50 hover:opacity-100 transition-opacity">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
