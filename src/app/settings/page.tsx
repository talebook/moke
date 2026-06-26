'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { fetchServerInfo } from '@/lib/api';
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
      await fetch(`${serverUrl}/api/user/sign_out`, { credentials: 'include' });
    } catch {}
    logout();
    localStorage.removeItem('moke-auth-token');
  };

  return (
    <DesktopLayout>
      <div className="px-8 py-8" style={{ maxWidth: '600px' }}>
        <h1 className="text-xl font-semibold mb-8 text-foreground">设置</h1>

        <div className="space-y-8">
          {user && (
            <SettingsSection title="账户">
              <SettingsRow label="当前账户" value={user.name || user.username} />
              <SettingsRow label="用户名" value={user.username} />
              <button
                onClick={() => router.push('/user')}
                className="w-full flex items-center justify-between px-4 py-3 rounded-lg transition-colors hover:bg-muted text-left"
              >
                <span className="text-sm text-foreground">账户管理</span>
              </button>
              <button
                onClick={handleLogout}
                className="w-full flex items-center justify-between px-4 py-3 rounded-lg transition-colors hover:bg-destructive/5 text-left"
              >
                <span className="text-sm font-medium text-destructive">退出登录</span>
              </button>
            </SettingsSection>
          )}

          <SettingsSection title="关于">
            <SettingsRow label="连接服务器" value={serverUrl} />
            <SettingsRow label="服务器名称" value={serverTitle || '未知'} />
            <SettingsRow label="应用版本" value="v0.1.0" />
            <SettingsRow label="服务器版本" value={serverVersion} />

            <button onClick={handleDisconnect}
              className="w-full flex items-center justify-between px-4 py-3 rounded-lg transition-colors hover:bg-destructive/5 text-left">
              <span className="text-sm font-medium text-destructive">断开连接</span>
            </button>
          </SettingsSection>
        </div>
      </div>
    </DesktopLayout>
  );
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">{title}</h2>
      <div className="space-y-1 rounded-xl border border-border bg-card p-1">{children}</div>
    </section>
  );
}

function SettingsRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 rounded-lg transition-colors hover:bg-muted">
      <span className="text-sm text-foreground">{label}</span>
      <span className="text-sm text-muted-foreground truncate max-w-[300px]">{value}</span>
    </div>
  );
}
