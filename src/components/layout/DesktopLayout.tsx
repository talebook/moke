'use client';

import { Sidebar } from '@/components/layout/Sidebar';
import { UpdateChecker } from '@/components/UpdateChecker';
import { useToast } from '@/lib/toast';
import { X, AlertTriangle, Info } from 'lucide-react';

export function DesktopLayout({ children }: { children: React.ReactNode }) {
  const toast = useToast((s) => s.message);
  const type = useToast((s) => s.type);
  const dismiss = useToast((s) => s.dismiss);

  return (
    <div className="flex h-screen overflow-hidden app-warm-bg">
      <Sidebar />
      <div className="ml-[220px] flex-1 min-w-0 h-screen flex flex-col overflow-hidden">
        {children}
      </div>
      <UpdateChecker />
      {toast && (
        <div className="fixed top-4 left-1/2 z-[130] w-[min(400px,calc(100vw-2rem))] -translate-x-1/2">
          <div className={`flex items-start gap-3 px-4 py-3 rounded-xl shadow-lg border ${
            type === 'error'
              ? 'bg-destructive/10 border-destructive/30 text-destructive'
              : 'bg-primary/10 border-primary/30 text-foreground'
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
