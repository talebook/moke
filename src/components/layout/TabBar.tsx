'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Library, Globe, User } from 'lucide-react';
import { cn } from '@/lib/utils';

const tabs = [
  { href: '/shelf', icon: Home, label: '首页' },
  { href: '/library', icon: Library, label: '书库' },
  { href: '/network', icon: Globe, label: '网络' },
  { href: '/user', icon: User, label: '我的' },
];

export function TabBar() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-background border-t border-border pb-[env(safe-area-inset-bottom,0px)]">
      <div className="flex items-center justify-around h-12">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                'flex flex-col items-center justify-center gap-0.5 min-h-[44px] min-w-[44px] transition-colors duration-150',
                isActive ? 'text-primary' : 'text-muted-foreground'
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
