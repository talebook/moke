'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BookOpen, Bookmark, Library, LogIn, Package, Puzzle, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useServerStore } from '@/lib/store/server';
import { useExtensionStore } from '@/lib/store/extensions';

export function Sidebar() {
  const pathname = usePathname();
  const { serverTitle, user } = useServerStore();
  const { extensions, loaded, loadExtensions, getSidebarExtensions } = useExtensionStore();
  const [sidebarExts, setSidebarExts] = useState<ReturnType<typeof getSidebarExtensions>>([]);

  useEffect(() => {
    if (!loaded) loadExtensions();
  }, [loaded, loadExtensions]);

  useEffect(() => {
    setSidebarExts(getSidebarExtensions());
  }, [extensions, getSidebarExtensions]);

  const navItems = [
    { href: '/shelf', icon: Bookmark, label: '书架' },
    { href: '/library', icon: Library, label: '书库' },
    { href: '/search', icon: null, label: null, hidden: true },
    { href: '/settings', icon: Settings, label: '设置' },
  ];

  // 拓展侧边栏项
  const extNavItems = sidebarExts.map((ext) => ({
    href: `/extensions/view?name=${ext.name}`,
    icon: Package,
    label: ext.sidebar?.label ?? ext.displayName,
  }));

  return (
    <aside className="fixed left-0 top-0 h-full w-[220px] flex flex-col z-10 bg-primary">
      <div className="flex items-center gap-3 px-6 h-16 border-b border-white/10">
        <div className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/10">
          <BookOpen className="w-5 h-5 text-primary-foreground" />
        </div>
        <span className="text-lg font-semibold tracking-tight text-primary-foreground">
          {serverTitle || '墨客'}
        </span>
      </div>

      <nav className="flex-1 flex flex-col gap-1 px-3 pt-4 overflow-y-auto">
        {navItems.filter((i) => !i.hidden).map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-150',
                isActive
                  ? 'bg-white/10 text-primary-foreground'
                  : 'text-white/55 hover:text-white hover:bg-white/5'
              )}
            >
              {item.icon && <item.icon className="w-5 h-5" />}
              <span>{item.label}</span>
            </Link>
          );
        })}

        {/* 拓展分隔 & 拓展导航项 */}
        {extNavItems.length > 0 && (
          <>
            <div className="mx-3 my-1 h-px bg-white/10" />
            <div className="px-3 py-1">
              <span className="text-[10px] font-medium text-white/30 uppercase tracking-wider">
                拓展
              </span>
            </div>
            {extNavItems.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-150',
                    isActive
                      ? 'bg-white/10 text-primary-foreground'
                      : 'text-white/55 hover:text-white hover:bg-white/5'
                  )}
                >
                  <item.icon className="w-5 h-5" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </>
        )}
      </nav>

      <div className="px-4 py-4 border-t border-white/10">
        {user ? (
          <Link
            href="/user"
            className={cn(
              'flex items-center gap-3 px-2 py-2 rounded-lg transition-colors',
              pathname === '/user'
                ? 'bg-white/10 text-primary-foreground'
                : 'text-white/55 hover:text-white hover:bg-white/5'
            )}
          >
            <div className="w-8 h-8 rounded-full bg-white/15 flex items-center justify-center text-xs font-semibold text-primary-foreground shrink-0">
              {user.name?.[0] || 'U'}
            </div>
            <div className="min-w-0">
              <p className="text-sm truncate">{user.name}</p>
              <p className="text-[11px] text-white/45 truncate">个人信息</p>
            </div>
          </Link>
        ) : (
          <Link
            href="/login"
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-white/10 px-3 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-white/15"
          >
            <LogIn className="h-4 w-4 shrink-0" />
            <span>登录</span>
          </Link>
        )}
      </div>
    </aside>
  );
}
