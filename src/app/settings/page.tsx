'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, BookOpen, LogOut, PlugZap, Settings2, ShieldAlert, User } from 'lucide-react';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { fetchServerInfo, request } from '@/lib/api';
import { useServerStore } from '@/lib/store/server';

export default function SettingsPage() {
  const router = useRouter();
  const { serverTitle, serverUrl, user, disconnect, logout } = useServerStore();
  const [serverVersion, setServerVersion] = useState('获取中...');

  useEffect(() => {
    let cancelled = false;

    const loadServerInfo = async () => {
      try {
        const data = await fetchServerInfo();
        if (!cancelled) {
          setServerVersion(data.version || '未知');
        }
      } catch {
        if (!cancelled) {
          setServerVersion('获取失败');
        }
      }
    };

    loadServerInfo();

    return () => {
      cancelled = true;
    };
  }, [serverUrl]);

  const handleDisconnect = () => {
    disconnect();
    localStorage.removeItem('moke-auth-token');
    router.push('/welcome');
  };

  const handleLogout = async () => {
    try {
      await request(`${serverUrl}/api/user/sign_out`, { credentials: 'include' });
    } catch {}
    logout();
    localStorage.removeItem('moke-auth-token');
  };

  return (
    <DesktopLayout>
      <div className="px-8 py-8" style={{ maxWidth: '860px' }}>
        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-foreground">设置</h1>
          <p className="text-sm text-muted-foreground mt-1">管理账户、连接信息与应用相关内容</p>
        </div>

        <div className="space-y-8">
          {user && (
            <SettingsSection title="账户" description="管理登录状态与个人信息入口">
              <SettingsRow label="当前账户" value={user.name || user.username} />
              <SettingsRow label="用户名" value={user.username} />
              <SettingsLinkRow
                icon={User}
                label="个人面板"
                description="查看个人数据概览与历史统计"
                href="/user"
              />
              <ActionRow
                icon={LogOut}
                label="退出登录"
                tone="danger"
                onClick={handleLogout}
              />
            </SettingsSection>
          )}

          <SettingsSection title="连接与数据" description="查看服务器信息与管理当前连接">
            <SettingsRow label="连接服务器" value={serverUrl} />
            <SettingsRow label="服务器名称" value={serverTitle || '未知'} />
            <SettingsRow label="服务器版本" value={serverVersion} />
            <ActionRow
              icon={PlugZap}
              label="断开连接"
              tone="danger"
              onClick={handleDisconnect}
            />
          </SettingsSection>

          <SettingsSection title="应用" description="查看应用信息与后续扩展入口">
            <SettingsRow label="应用版本" value="v0.1.0" />
            <SettingsLinkRow
              icon={BookOpen}
              label="关于应用"
              description="查看应用介绍、版本说明与贡献者信息"
              href="/about"
            />
            <SettingsLinkRow
              icon={Settings2}
              label="界面与偏好"
              description="预留给后续主题、布局与阅读偏好设置"
              href="/settings"
              disabled
            />
            <StaticInfoRow
              icon={ShieldAlert}
              label="更多设置"
              description="后续可以继续拆分出界面、阅读、实验功能等独立设置块"
            />
          </SettingsSection>
        </div>
      </div>
    </DesktopLayout>
  );
}

function SettingsSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
      </div>
      <div className="space-y-1 rounded-2xl border border-border bg-card p-1.5">{children}</div>
    </section>
  );
}

function SettingsRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 rounded-xl transition-colors hover:bg-muted">
      <span className="text-sm text-foreground shrink-0">{label}</span>
      <span className="text-sm text-muted-foreground truncate text-right">{value}</span>
    </div>
  );
}

function SettingsLinkRow({ icon: Icon, label, description, href, disabled }: { icon: typeof User; label: string; description: string; href: string; disabled?: boolean }) {
  const content = (
    <div className={`flex items-center justify-between gap-4 px-4 py-3 rounded-xl transition-colors ${disabled ? 'opacity-60 cursor-not-allowed' : 'hover:bg-muted'}`}>
      <div className="flex items-start gap-3 min-w-0">
        <Icon className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <p className="text-sm text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        </div>
      </div>
      {!disabled && <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />}
    </div>
  );

  if (disabled) {
    return content;
  }

  return <Link href={href}>{content}</Link>;
}

function ActionRow({ icon: Icon, label, tone = 'default', onClick }: { icon: typeof User; label: string; tone?: 'default' | 'danger'; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-colors ${tone === 'danger' ? 'hover:bg-destructive/5' : 'hover:bg-muted'}`}
    >
      <Icon className={`w-4 h-4 shrink-0 ${tone === 'danger' ? 'text-destructive' : 'text-muted-foreground'}`} />
      <span className={`text-sm ${tone === 'danger' ? 'font-medium text-destructive' : 'text-foreground'}`}>{label}</span>
    </button>
  );
}

function StaticInfoRow({ icon: Icon, label, description }: { icon: typeof User; label: string; description: string }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 rounded-xl">
      <Icon className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
      <div>
        <p className="text-sm text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
      </div>
    </div>
  );
}
