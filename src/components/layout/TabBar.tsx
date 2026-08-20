'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bookmark, Library, User } from 'lucide-react';
import { cn } from '@/lib/utils';

const tabs = [
  { href: '/shelf', icon: Bookmark, label: '书架' },
  { href: '/library', icon: Library, label: '书库' },
  { href: '/user', icon: User, label: '我的' },
];

export function TabBar() {
  const pathname = usePathname();

  return (
    <nav className="moke-tab-bar fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom,0px)] shadow-[0_-12px_36px_-28px_rgba(74,57,35,0.65)] backdrop-blur lg:hidden">
      <div className="grid h-14 grid-cols-3">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <Link
              key={tab.href}
              replace
              href={tab.href}
              className={cn(
                'flex min-h-[44px] min-w-0 flex-col items-center justify-center gap-0.5 px-1 transition-colors duration-150',
                isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] font-medium">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
