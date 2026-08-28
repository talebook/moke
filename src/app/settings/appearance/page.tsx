'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, Check, Moon, Settings2, Sun } from 'lucide-react';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { requestAnimatedBack } from '@/lib/native-back';
import { resolveTheme, useSettingsStore } from '@/lib/store/settings';
import type { ThemeMode } from '@/lib/store/settings';
import { cn } from '@/lib/utils';

const themes: { value: ThemeMode; label: string; description: string; icon: typeof Sun }[] = [
  { value: 'light', label: '浅色', description: '始终使用明亮外观', icon: Sun },
  { value: 'dark', label: '深色', description: '始终使用深色外观', icon: Moon },
  { value: 'system', label: '跟随系统', description: '随系统外观自动切换', icon: Settings2 },
];

export default function AppearanceSettingsPage() {
  const eink = useSettingsStore((state) => state.eink);
  const setEink = useSettingsStore((state) => state.setEink);
  const theme = useSettingsStore((state) => state.theme);
  const setTheme = useSettingsStore((state) => state.setTheme);
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(media.matches);
    const handleChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  const effectiveTheme = eink ? 'light' : resolveTheme(theme, systemDark);

  return (
    <DesktopLayout>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-5 sm:px-6 md:px-8 md:py-8">
        <div className="mx-auto" style={{ maxWidth: '860px' }}>
          <button
            type="button"
            onClick={() => requestAnimatedBack('/settings')}
            className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            返回设置
          </button>

          <div className="mb-8">
            <h1 className="text-2xl font-semibold text-foreground">主题与显示</h1>
            <p className="mt-1 text-sm text-muted-foreground">调整应用外观和屏幕显示模式</p>
          </div>

          <div className="space-y-8">
            <section className="space-y-3">
              <div className="px-1">
                <h2 className="text-sm font-semibold text-foreground">外观主题</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {eink ? '墨水屏模式已启用，当前固定使用黑白浅色外观' : `当前应用为${effectiveTheme === 'dark' ? '深色' : '浅色'}外观`}
                </p>
              </div>
              <div className="grid gap-2 rounded-[28px] app-glass p-2 shadow-sm sm:grid-cols-3">
                {themes.map((option) => {
                  const Icon = option.icon;
                  const selected = theme === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      disabled={eink}
                      onClick={() => setTheme(option.value)}
                      className={cn(
                        'relative flex items-start gap-3 rounded-2xl border px-4 py-3 text-left transition-colors',
                        selected ? 'border-foreground bg-background' : 'border-transparent hover:bg-muted/60',
                        eink && 'cursor-not-allowed opacity-50',
                      )}
                    >
                      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <span>
                        <span className="block text-sm font-medium text-foreground">{option.label}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>
                      </span>
                      {selected && <Check className="absolute right-3 top-3 h-4 w-4 text-foreground" />}
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="space-y-3">
              <div className="px-1">
                <h2 className="text-sm font-semibold text-foreground">屏幕模式</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">针对不同显示设备优化视觉效果</p>
              </div>
              <div className="rounded-[28px] app-glass p-1 shadow-sm">
                <div className="flex items-center justify-between gap-4 rounded-xl px-4 py-3 hover:bg-muted/60">
                  <div className="flex min-w-0 items-start gap-3.5">
                    <div className="shrink-0 rounded-lg border border-amber-950/10 bg-white/60 p-2 text-muted-foreground eink-bordered">
                      <Settings2 className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 py-0.5">
                      <p className="text-sm font-medium text-foreground">墨水屏模式</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">关闭模糊与渐变效果，提升电子墨水屏可读性</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-label="墨水屏模式"
                    aria-checked={eink}
                    onClick={() => setEink(!eink)}
                    className={cn('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-transparent transition-colors eink:!bg-white eink:border-black', eink ? 'bg-primary' : 'bg-muted-foreground/30')}
                  >
                    <span className={cn('inline-block h-5 w-5 rounded-full bg-white shadow transition-transform eink:!bg-black', eink ? 'translate-x-5' : 'translate-x-0.5')} />
                  </button>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </DesktopLayout>
  );
}
