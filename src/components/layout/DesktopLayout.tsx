'use client';

import { Sidebar } from '@/components/layout/Sidebar';
import { UpdateChecker } from '@/components/UpdateChecker';

export function DesktopLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden app-warm-bg">
      <Sidebar />
      <div className="ml-[220px] flex-1 min-w-0 h-screen flex flex-col overflow-hidden">
        {children}
      </div>
      <UpdateChecker />
    </div>
  );
}
