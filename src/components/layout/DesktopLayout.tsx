'use client';

import { Sidebar } from '@/components/layout/Sidebar';

export function DesktopLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      <div className="ml-[220px] flex-1 flex flex-col min-h-screen">
        {children}
      </div>
    </div>
  );
}
