'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, BookOpen, Download, Mail, Send, Settings, Shield, Upload, User } from 'lucide-react';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { request } from '@/lib/api';
import { useServerStore } from '@/lib/store/server';

type HistoryType = 'read_history' | 'download_history' | 'push_history' | 'upload_history';

interface HistoryItem {
  id: string | number;
  title: string;
  timestamp: number;
  img?: string;
  href?: string;
}

interface UserDetailResponse {
  err: string;
  msg?: string;
  user?: {
    username?: string;
    email?: string;
    nickname?: string;
    name?: string;
    permission?: string;
    is_admin?: boolean;
    admin?: boolean;
    extra?: Partial<Record<HistoryType, HistoryItem[]>>;
  };
}

const historyCards: Array<{ key: HistoryType; label: string; icon: typeof BookOpen }> = [
  { key: 'read_history', label: '阅读记录', icon: BookOpen },
  { key: 'download_history', label: '下载记录', icon: Download },
  { key: 'push_history', label: '推送记录', icon: Send },
  { key: 'upload_history', label: '上传记录', icon: Upload },
];

export default function UserPage() {
  const router = useRouter();
  const { user, serverUrl } = useServerStore();
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [profile, setProfile] = useState<UserDetailResponse['user'] | null>(null);
  const [historyMap, setHistoryMap] = useState<Record<HistoryType, HistoryItem[]>>({
    read_history: [],
    download_history: [],
    push_history: [],
    upload_history: [],
  });

  useEffect(() => {
    const loadProfile = async () => {
      setLoading(true);
      setMessage('');
      try {
        const res = await request(`${serverUrl}/api/user/info?detail=1`, {
          credentials: 'include',
        });
        const data: UserDetailResponse = await res.json();

        if (data.err === 'user.need_login') {
          router.push('/login');
          return;
        }

        if (data.err !== 'ok') {
          setMessage(data.msg || '个人信息加载失败');
          return;
        }

        const extra = data.user?.extra || {};
        setProfile(data.user || null);
        setHistoryMap({
          read_history: Array.isArray(extra.read_history) ? extra.read_history : [],
          download_history: Array.isArray(extra.download_history) ? extra.download_history : [],
          push_history: Array.isArray(extra.push_history) ? extra.push_history : [],
          upload_history: Array.isArray(extra.upload_history) ? extra.upload_history : [],
        });
      } catch {
        setMessage('个人信息加载失败');
      } finally {
        setLoading(false);
      }
    };

    if (serverUrl) {
      loadProfile();
    }
  }, [router, serverUrl]);

  const displayName = profile?.nickname || profile?.name || user?.name || '未命名用户';
  const username = profile?.username || user?.username || '-';
  const email = profile?.email || user?.email || '未绑定邮箱';
  const isAdmin = Boolean(profile?.is_admin ?? profile?.admin ?? user?.admin);
  const permission = isAdmin ? '管理员' : profile?.permission || user?.permission || '普通用户';
  const totalHistory = useMemo(
    () => historyCards.reduce((sum, item) => sum + historyMap[item.key].length, 0),
    [historyMap],
  );

  return (
    <DesktopLayout>
      <div className="px-8 py-8" style={{ maxWidth: '1200px' }}>
        <div className="flex items-center justify-between mb-8 gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">个人面板</h1>
            <p className="text-sm text-muted-foreground mt-1">查看你的账户信息与个人使用数据</p>
          </div>
          <Link
            href="/settings"
            className="inline-flex items-center gap-2 h-10 rounded-[10px] border border-border bg-background px-4 text-sm text-foreground transition hover:bg-muted"
          >
            <Settings className="w-4 h-4" />
            <span>前往设置</span>
          </Link>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-40">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
          </div>
        ) : message ? (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-5 py-4 text-sm text-destructive">
            {message}
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-6">
              <div className="rounded-3xl border border-border bg-card p-6">
                <div className="flex items-center gap-4 mb-6">
                  <div className="w-16 h-16 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xl font-semibold">
                    {displayName[0] || 'U'}
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-xl font-semibold text-foreground truncate">{displayName}</h2>
                    <p className="text-sm text-muted-foreground truncate">@{username}</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <InfoCard icon={User} label="用户名" value={username} />
                  <InfoCard icon={Mail} label="邮箱" value={email} />
                  <InfoCard icon={Shield} label="权限" value={permission} />
                  <InfoCard icon={BookOpen} label="总历史数" value={`${totalHistory} 条`} />
                </div>
              </div>

              <div className="rounded-3xl border border-border bg-card p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold text-foreground">快捷入口</h3>
                </div>
                <div className="space-y-3">
                  <QuickLink href="/user/history" title="历史记录" description="查看阅读、下载、推送与上传历史" />
                  <QuickLink href="/settings" title="应用设置" description="调整服务器、主题与其他偏好" />
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-border bg-card p-6">
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h3 className="text-lg font-semibold text-foreground">个人数据概览</h3>
                  <p className="text-sm text-muted-foreground mt-1">你最近积累的历史数据统计</p>
                </div>
                <Link href="/user/history" className="text-sm text-primary hover:underline">
                  查看全部
                </Link>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                {historyCards.map(({ key, label, icon: Icon }) => (
                  <Link
                    key={key}
                    href="/user/history"
                    className="rounded-2xl border border-border bg-background px-5 py-5 transition hover:bg-muted"
                  >
                    <div className="flex items-center justify-between mb-4">
                      <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center text-foreground">
                        <Icon className="w-5 h-5" />
                      </div>
                      <ArrowRight className="w-4 h-4 text-muted-foreground" />
                    </div>
                    <p className="text-sm text-muted-foreground">{label}</p>
                    <p className="mt-1 text-2xl font-semibold text-foreground">{historyMap[key].length}</p>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </DesktopLayout>
  );
}

function InfoCard({ icon: Icon, label, value }: { icon: typeof User; label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-background border border-border px-4 py-4">
      <div className="flex items-center gap-2 text-muted-foreground text-sm mb-2">
        <Icon className="w-4 h-4" />
        <span>{label}</span>
      </div>
      <p className="text-sm font-medium text-foreground break-words">{value}</p>
    </div>
  );
}

function QuickLink({ href, title, description }: { href: string; title: string; description: string }) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-background px-4 py-4 transition hover:bg-muted"
    >
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
      </div>
      <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
    </Link>
  );
}
