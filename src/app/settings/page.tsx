'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, BookOpen, LogOut, Package, PlugZap, Settings2, ShieldAlert, User, Code2 } from 'lucide-react';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { fetchServerInfo, request } from '@/lib/api';
import { useServerStore } from '@/lib/store/server';
import { useDeveloperStore } from '@/lib/store/developer';
import { APP_VERSION } from '@/lib/app-version';

export default function SettingsPage() {
  const router = useRouter();
  const { serverTitle, serverUrl, user, disconnect, logout } = useServerStore();
  const unlocked = useDeveloperStore((s) => s.unlocked);
  const developerEnabled = useDeveloperStore((s) => s.enabled);
  const [serverVersion, setServerVersion] = useState('获取中...');

  useEffect(() => {
    let cancelled = false;

    // serverUrl 为空时（如已断开连接），不发起请求，避免无前缀 URL 报错
    if (!serverUrl) {
      setServerVersion('未连接');
      return;
    }

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
    if (serverUrl) {
      try {
        await request(`${serverUrl}/api/user/sign_out`, { credentials: 'include' });
      } catch {}
    }
    logout();
    localStorage.removeItem('moke-auth-token');
    router.push('/login');
  };

  return (
    <DesktopLayout>
      <div className="flex-1 min-h-0 overflow-y-auto px-8 py-8">
        <div className="mx-auto" style={{ maxWidth: '860px' }}>
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
            <SettingsRow label="应用版本" value={APP_VERSION} />
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
          </SettingsSection>

          {/* 只有桌面端才显示拓展管理入口 */}
          {process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri' && (
            <SettingsSection title="拓展" description="管理已安装的拓展程序">
              <SettingsLinkRow
                icon={Package}
                label="拓展管理"
                description="查看、启用或卸载已安装的拓展"
                href="/extensions"
              />
            </SettingsSection>
          )}

          {unlocked && developerEnabled && (
            <SettingsSection title="开发者" description="调试与诊断相关功能，仅开发者可见">
              <SettingsLinkRow
                icon={Code2}
                label="开发者选项"
                description="崩溃测试、调试面板开关等诊断工具"
                href="/settings/developer"
              />
            </SettingsSection>
          )}
        </div>
        </div>
      </div>
    </DesktopLayout>
  );
}

function SettingsSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="px-1">
        <h2 className="text-sm font-semibold text-foreground tracking-tight">{title}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="divide-y divide-amber-950/10 rounded-[28px] app-glass p-1 transition-all duration-300 hover:bg-white/70">{children}</div>
    </section>
  );
}

function SettingsRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3.5 rounded-xl transition-colors hover:bg-muted/60">
      <span className="text-sm font-medium text-foreground shrink-0">{label}</span>
      <span className="text-sm text-muted-foreground truncate text-right">{value}</span>
    </div>
  );
}

function SettingsLinkRow({ icon: Icon, label, description, href, disabled }: { icon: typeof User; label: string; description: string; href: string; disabled?: boolean }) {
  const content = (
    <div className={`flex items-center justify-between gap-4 px-4 py-3 rounded-xl transition-all duration-200 group ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-muted/80 active:scale-[0.99]'}`}>
      <div className="flex items-start gap-3.5 min-w-0">
        <div className="p-2 rounded-lg bg-white/60 border border-amber-950/10 text-muted-foreground group-hover:text-primary group-hover:border-primary/20 transition-colors duration-200 shrink-0">
          <Icon className="w-4 h-4" />
        </div>
        <div className="min-w-0 py-0.5">
          <p className="text-sm font-medium text-foreground group-hover:text-primary transition-colors duration-200">{label}</p>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</p>
        </div>
      </div>
      {!disabled && <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-foreground group-hover:translate-x-0.5 transition-all duration-200 shrink-0" />}
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
      className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-left transition-all duration-200 active:scale-[0.99] group ${tone === 'danger' ? 'hover:bg-destructive/5' : 'hover:bg-muted/80'}`}
    >
      <div className="flex items-center gap-3.5 min-w-0">
        <div className={`p-2 rounded-lg bg-white/60 border border-amber-950/10 shrink-0 transition-colors duration-200 ${tone === 'danger' ? 'group-hover:border-destructive/20 group-hover:text-destructive' : 'group-hover:text-primary'}`}>
          <Icon className={`w-4 h-4 ${tone === 'danger' ? 'text-destructive' : 'text-muted-foreground'}`} />
        </div>
        <span className={`text-sm font-medium ${tone === 'danger' ? 'text-destructive' : 'text-foreground'}`}>{label}</span>
      </div>
      <ArrowRight className={`w-4 h-4 opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all duration-200 shrink-0 ${tone === 'danger' ? 'text-destructive' : 'text-muted-foreground'}`} />
    </button>
  );
}

function StaticInfoRow({ icon: Icon, label, description }: { icon: typeof User; label: string; description: string }) {
  return (
    <div className="flex items-start gap-3.5 px-4 py-3 rounded-xl">
      <div className="p-2 rounded-lg bg-white/60 border border-amber-950/10 text-muted-foreground shrink-0">
        <Icon className="w-4 h-4" />
      </div>
      <div className="min-w-0 py-0.5">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</p>
      </div>
    </div>
  );
}
