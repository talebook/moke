'use client';

import Link from 'next/link';
import { useState, useRef } from 'react';
import { ArrowLeft, BookOpen, ExternalLink, HeartHandshake, Info, Sparkles, X } from 'lucide-react';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { useDeveloperStore } from '@/lib/store/developer';

interface Contributor {
  id: string;
  name: string;
  github: string;
  avatarUrl: string;
  role: string;
  easterEgg?: {
    image: string;
    caption: string;
  };
}

const contributors: Contributor[] = [
  {
    id: 'houheya',
    name: 'houheya',
    github: 'https://github.com/hehetoshang',
    avatarUrl: '/contributors/houheya/avatar.jpg',
    role: '主要维护者',
    easterEgg: {
      image: '/contributors/houheya/easter-egg.jpg',
      caption: '我压榨了100个AI',
    },
  },
];

export default function AboutPage() {
  const [activeEgg, setActiveEgg] = useState<{ image: string; caption: string } | null>(null);
  const clickCountMap = useRef<Record<string, number>>({});
  const clickTimerMap = useRef<Record<string, NodeJS.Timeout>>({});

  const { unlocked, enabled, setEnabled, tapVersion } = useDeveloperStore();
  const [devHint, setDevHint] = useState('');
  const devHintTimer = useRef<NodeJS.Timeout | null>(null);
  // 已解锁但被隐藏时，用一个独立计数器统计连点，达到 8 次后重新显示入口
  const reshowTapsRef = useRef(0);

  const handleVersionClick = () => {
    if (unlocked) {
      if (enabled) {
        setDevHint('开发者选项已解锁');
      } else {
        // 开发者选项已解锁但被隐藏：连点 8 次重新显示入口
        reshowTapsRef.current += 1;
        const remaining = 8 - reshowTapsRef.current;
        if (remaining <= 0) {
          reshowTapsRef.current = 0;
          setEnabled(true);
          setDevHint('🎉 已重新显示开发者选项！请前往设置查看');
        } else if (remaining <= 5) {
          setDevHint(`再点击 ${remaining} 次即可重新显示开发者选项`);
        }
      }
    } else {
      const justUnlocked = tapVersion();
      if (justUnlocked) {
        setDevHint('🎉 已解锁开发者选项！请前往设置查看');
      } else {
        const remaining = 8 - (useDeveloperStore.getState().versionTapCount);
        if (remaining <= 5) {
          setDevHint(`再点击 ${remaining} 次即可解锁开发者选项`);
        }
      }
    }
    if (devHintTimer.current) clearTimeout(devHintTimer.current);
    devHintTimer.current = setTimeout(() => setDevHint(''), 2000);
  };

  const handleContributorClick = (c: Contributor) => {
    if (!c.easterEgg) return;

    const currentCount = (clickCountMap.current[c.id] || 0) + 1;
    clickCountMap.current[c.id] = currentCount;

    if (clickTimerMap.current[c.id]) {
      clearTimeout(clickTimerMap.current[c.id]);
    }

    if (currentCount >= 8) {
      setActiveEgg(c.easterEgg);
      clickCountMap.current[c.id] = 0;
    } else {
      clickTimerMap.current[c.id] = setTimeout(() => {
        clickCountMap.current[c.id] = 0;
      }, 2000);
    }
  };

  return (
    <DesktopLayout>
      <div className="flex-1 min-h-0 overflow-y-auto px-8 py-8">
        <div className="mx-auto" style={{ maxWidth: '960px' }}>
        <div className="mb-8 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">关于应用</h1>
            <p className="mt-1 text-sm text-muted-foreground">了解应用定位与项目贡献者</p>
          </div>
          <Link
            href="/settings"
            className="inline-flex items-center gap-2 h-10 rounded-2xl border border-amber-950/10 bg-white/60 shadow-sm px-4 text-sm text-foreground transition hover:bg-muted"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>返回设置</span>
          </Link>
        </div>

        <div className="space-y-6">
          <section className="rounded-[32px] app-glass p-6 transition-all duration-300 hover:bg-white/70">
            <div className="flex items-center gap-4 mb-5">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-primary/80 flex items-center justify-center text-primary-foreground shadow-inner">
                <BookOpen className="w-7 h-7" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-foreground">墨客</h2>
                <p className="text-sm text-muted-foreground mt-1">为 Talebook 客户端场景打造的桌面阅读体验</p>
              </div>
            </div>
            <p className="text-sm leading-7 text-foreground/90">
              这个应用围绕书架、书库、搜索、历史与离线阅读做了更贴近桌面端的界面整理。
              目前你可以在这里管理个人数据、浏览图书、查看历史，并逐步扩展更多阅读相关能力。
            </p>
          </section>

          <section className="rounded-[32px] app-glass p-6 transition-all duration-300 hover:bg-white/70">
            <div className="flex items-center gap-2 mb-4 text-foreground">
              <Info className="w-5 h-5 text-primary" />
              <h3 className="text-lg font-semibold">应用信息</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <InfoRow label="应用名称" value="墨客" />
              <InfoRow label="应用版本" value="v0.1.3" onClick={handleVersionClick} highlight={unlocked} />
              <InfoRow label="定位" value="Talebook 桌面客户端" />
            </div>
            {devHint && (
              <p className="mt-3 text-xs text-primary font-medium animate-in fade-in duration-200">{devHint}</p>
            )}
          </section>

          <section className="rounded-[32px] app-glass p-6 transition-all duration-300 hover:bg-white/70">
            <div className="flex items-center gap-2 mb-4 text-foreground">
              <Sparkles className="w-5 h-5 text-amber-500" />
              <h3 className="text-lg font-semibold">后续规划</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <FeatureCard title="界面设置" description="独立管理主题、布局、卡片密度与显示偏好。" />
              <FeatureCard title="阅读增强" description="补充更多阅读状态、同步与阅读器侧功能扩展。" />
              <FeatureCard title="账户能力" description="继续完善个人数据、面板统计与更多快捷入口。" />
            </div>
          </section>

          <section className="rounded-[32px] app-glass p-6 transition-all duration-300 hover:bg-white/70">
            <div className="flex items-center gap-2 mb-4 text-foreground">
              <HeartHandshake className="w-5 h-5 text-rose-500" />
              <h3 className="text-lg font-semibold">贡献者</h3>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {contributors.map((c) => (
                <div
                  key={c.name}
                  onClick={() => handleContributorClick(c)}
                  className="flex items-center justify-between gap-3.5 rounded-2xl border border-border/60 bg-background/50 backdrop-blur-xs px-4 py-4 transition-all duration-300 hover:bg-muted/80 hover:shadow-md hover:-translate-y-0.5 select-none cursor-pointer group"
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    <img
                      src={c.avatarUrl}
                      alt={c.name}
                      className="w-12 h-12 rounded-full object-cover shrink-0 pointer-events-none ring-2 ring-border/50 group-hover:ring-primary/40 transition-all duration-300"
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground truncate group-hover:text-primary transition-colors">{c.name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{c.role}</p>
                    </div>
                  </div>
                  <a
                    href={c.github}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-card border border-transparent hover:border-border/60 hover:shadow-xs transition shrink-0"
                    title="访问 GitHub 主页"
                  >
                    <img src="/contributors/github.svg" alt="GitHub" className="w-4 h-4 dark:invert opacity-70 group-hover/btn:opacity-100 transition-opacity" />
                  </a>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      {activeEgg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md animate-in fade-in duration-300">
          <div className="relative max-w-lg w-[90%] rounded-3xl bg-card/95 border border-border/80 p-6 shadow-2xl flex flex-col items-center animate-in zoom-in-95 duration-300">
            <button
              onClick={() => setActiveEgg(null)}
              className="absolute right-4 top-4 w-8 h-8 rounded-full bg-muted/80 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-all duration-200"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="w-full overflow-hidden rounded-2xl mb-4 bg-black/5 border border-border/40 shadow-inner">
              <img
                src={activeEgg.image}
                alt="彩蛋"
                className="w-full h-auto max-h-[60vh] object-contain mx-auto"
              />
            </div>
            <p className="text-sm text-muted-foreground text-center font-medium">
              {activeEgg.caption}
            </p>
          </div>
        </div>
      )}
      </div>
    </DesktopLayout>
  );
}

function InfoRow({ label, value, onClick, highlight }: { label: string; value: string; onClick?: () => void; highlight?: boolean }) {
  return (
    <div
      onClick={onClick}
      className={`flex items-start justify-between gap-4 rounded-2xl border px-4 py-3 transition-colors ${
        onClick ? 'cursor-pointer select-none hover:bg-white/80 active:scale-[0.99]' : ''
      } ${highlight ? 'border-primary/40 bg-primary/5' : 'border-amber-950/10 bg-white/55'}`}
    >
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={`text-right break-all ${highlight ? 'text-primary font-medium' : 'text-foreground'}`}>{value}</span>
    </div>
  );
}

function FeatureCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-2xl bg-white/55 border border-amber-950/10 px-4 py-4">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground mt-2 leading-6">{description}</p>
    </div>
  );
}
