'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, BookOpen, Copy, Download, FolderOpen, LogOut, Moon, Package, Palette, PlugZap, RefreshCw, Settings2, ShieldAlert, ShieldCheck, Sun, User, Code2 } from 'lucide-react';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { fetchServerInfo, request } from '@/lib/api';
import { useServerStore } from '@/lib/store/server';
import { getDebugPanelLaunchState, useDeveloperStore } from '@/lib/store/developer';
import { resolveTheme, useSettingsStore } from '@/lib/store/settings';
import type { ThemeMode } from '@/lib/store/settings';
import { cn } from '@/lib/utils';
import { useUpdateStore } from '@/lib/store/update';
import { APP_VERSION } from '@/lib/app-version';
import { getMokeRuntimePlatform, openEmbeddedReaderHome } from '@/lib/moke-reader';
import { safeRemoveLocalStorageItem } from '@/lib/browser-storage';
import { useToast } from '@/lib/toast';

export default function SettingsPage() {
  const router = useRouter();
  const { serverTitle, serverUrl, user, disconnect, logout } = useServerStore();
  const unlocked = useDeveloperStore((s) => s.unlocked);
  const developerEnabled = useDeveloperStore((s) => s.enabled);
  const downloadDirectory = useSettingsStore((s) => s.downloadDirectory);
  const setDownloadDirectory = useSettingsStore((s) => s.setDownloadDirectory);
  const [directorySupported, setDirectorySupported] = useState<boolean | null>(null);
  const showToast = useToast((s) => s.show);
  const [serverVersion, setServerVersion] = useState('获取中...');

  useEffect(() => {
    let cancelled = false;
    if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') {
      setDirectorySupported(false);
      return;
    }
    void getMokeRuntimePlatform().then((platform) => {
      if (!cancelled) setDirectorySupported(['windows', 'macos', 'linux'].includes(platform));
    }).catch(() => { if (!cancelled) setDirectorySupported(false); });
    return () => { cancelled = true; };
  }, []);

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
    safeRemoveLocalStorageItem('moke-auth-token');
    router.push('/welcome');
  };

  const handleLogout = async () => {
    if (serverUrl) {
      try {
        await request(`${serverUrl}/api/user/sign_out`, { credentials: 'include' });
      } catch (error) {
        console.warn('Failed to sign out on server:', error);
      }
    }
    logout();
    safeRemoveLocalStorageItem('moke-auth-token');
    router.push('/login');
  };

  const handleSelectDownloadDirectory = async () => {
    if (!directorySupported) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const selected = await invoke<string | null>('moke_select_download_directory');
      if (!selected) return;
      setDownloadDirectory(selected);
      showToast('下载目录已更新');
    } catch (error) {
      console.error('Failed to select download directory:', error);
      showToast('无法使用所选目录，请重新选择', 'error');
    }
  };

  const handleResetDownloadDirectory = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('moke_reset_download_directory');
      setDownloadDirectory(null);
      showToast('已恢复默认下载目录');
    } catch { showToast('恢复默认目录失败', 'error'); }
  };

  const handleOpenReaderHome = async () => {
    try {
      await openEmbeddedReaderHome({
        eink: useSettingsStore.getState().eink,
        debugPanel: getDebugPanelLaunchState(),
        serverUrl,
        navigate: (href) => router.push(href),
      });
    } catch (error) {
      console.error('Failed to open embedded reader:', error);
      showToast('打开阅读器失败', 'error');
    }
  };

  return (
    <DesktopLayout>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-5 sm:px-6 md:px-8 md:py-8">
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

          <SettingsSection title="离线下载" description="管理离线文件与存储位置">
            <SettingsLinkRow
              icon={Download}
              label="下载管理"
              description="查看进度、暂停、继续、重试或删除下载"
              href="/downloads"
            />
            <SettingsRow
              label="下载目录"
              value={directorySupported === false
                ? (process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri' ? '当前移动平台由系统管理，不支持自定义' : 'Web 版使用浏览器存储')
                : (downloadDirectory || '应用默认目录')}
            />
            {directorySupported && (
              <>
                <ActionRow icon={FolderOpen} label="选择下载目录" onClick={() => void handleSelectDownloadDirectory()} />
                {downloadDirectory && <ActionRow icon={RefreshCw} label="恢复默认目录" onClick={() => void handleResetDownloadDirectory()} />}
              </>
            )}
          </SettingsSection>

          <SettingsSection title="应用" description="查看应用信息与后续扩展入口">
            <SettingsRow label="应用版本" value={APP_VERSION} />
            <UpdateSection />
            <SettingsLinkRow
              icon={Palette}
              label="主题与显示"
              description="管理外观主题与墨水屏模式"
              href="/settings/appearance"
            />
            <ActionRow
              icon={BookOpen}
              label="打开内嵌阅读器"
              onClick={handleOpenReaderHome}
            />
            <SettingsLinkRow
              icon={BookOpen}
              label="关于应用"
              description="查看应用介绍、版本说明与贡献者信息"
              href="/about"
            />
            <SettingsLinkRow
              icon={ShieldCheck}
              label="隐私政策"
              description="查看 Moke 如何处理和保护相关信息"
              href="/privacy"
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
      <div className="divide-y divide-amber-950/10 rounded-[28px] app-glass p-1 shadow-sm transition-all duration-300 hover:bg-white/70">{children}</div>
    </section>
  );
}

function SettingsRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3.5 rounded-3xl transition-colors hover:bg-muted/60">
      <span className="text-sm font-medium text-foreground shrink-0">{label}</span>
      <span className="text-sm text-muted-foreground truncate text-right">{value}</span>
    </div>
  );
}

function SettingsLinkRow({ icon: Icon, label, description, href, disabled }: { icon: typeof User; label: string; description: string; href: string; disabled?: boolean }) {
  const content = (
    <div className={`flex items-center justify-between gap-4 px-4 py-3 rounded-3xl transition-all duration-200 group ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-muted/80 active:scale-[0.99]'}`}>
      <div className="flex items-start gap-3.5 min-w-0">
        <div className="p-2 rounded-lg bg-white/60 border border-amber-950/10 eink-bordered text-muted-foreground group-hover:text-primary group-hover:border-primary/20 transition-colors duration-200 shrink-0">
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

  return <Link href={href} className="block rounded-3xl">{content}</Link>;
}

function ActionRow({ icon: Icon, label, tone = 'default', onClick }: { icon: typeof User; label: string; tone?: 'default' | 'danger'; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between px-4 py-3 rounded-3xl text-left transition-all duration-200 active:scale-[0.99] group ${tone === 'danger' ? 'hover:bg-destructive/5' : 'hover:bg-muted/80'}`}
    >
      <div className="flex items-center gap-3.5 min-w-0">
        <div className={`p-2 rounded-lg bg-white/60 border border-amber-950/10 eink-bordered shrink-0 transition-colors duration-200 ${tone === 'danger' ? 'group-hover:border-destructive/20 group-hover:text-destructive' : 'group-hover:text-primary'}`}>
          <Icon className={`w-4 h-4 ${tone === 'danger' ? 'text-destructive' : 'text-muted-foreground'}`} />
        </div>
        <span className={`text-sm font-medium ${tone === 'danger' ? 'text-destructive' : 'text-foreground'}`}>{label}</span>
      </div>
      <ArrowRight className={`w-4 h-4 opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all duration-200 shrink-0 ${tone === 'danger' ? 'text-destructive' : 'text-muted-foreground'}`} />
    </button>
  );
}

function ThemeRow({ value, onChange, disabled }: { value: ThemeMode; onChange: (v: ThemeMode) => void; disabled?: boolean }) {
  const options: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
    { value: 'light', label: '浅色', icon: Sun },
    { value: 'dark', label: '深色', icon: Moon },
    { value: 'system', label: '跟随系统', icon: Settings2 },
  ];

  // Resolve the actual applied theme so the row's leading icon matches what
  // the user sees (in 'system' mode that follows prefers-color-scheme).
  // e-ink mode (disabled) locks the UI to the black/white light theme, so the
  // icon must not reflect a stored dark preference.
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(mq.matches);
    const onMediaChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onMediaChange);
    return () => mq.removeEventListener('change', onMediaChange);
  }, []);
  const effectiveDark = !disabled && resolveTheme(value, systemDark) === 'dark';

  // Normalize an out-of-options value (e.g. corrupted persisted data, or a
  // future mode not synced here) to a known option so the group keeps a single
  // tab stop and a checked item — otherwise every radio would be tabIndex=-1
  // and aria-checked=false, making the radiogroup unreachable by keyboard.
  const safeValue = options.some((o) => o.value === value) ? value : 'system';

  // Roving tabindex + arrow keys so the radiogroup behaves per ARIA APG.
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const index = options.findIndex((o) => o.value === safeValue);
    let next = index;
    if (e.key === 'ArrowLeft') next = (index - 1 + options.length) % options.length;
    else if (e.key === 'ArrowRight') next = (index + 1) % options.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    onChange(options[next].value);
    // Move focus to the newly selected option so the visible focus ring and
    // the radiogroup selection stay in sync (ARIA APG roving tabindex).
    optionRefs.current[next]?.focus();
  };

  return (
    <div className={`flex items-center justify-between gap-4 px-4 py-3 rounded-3xl transition-colors ${disabled ? 'opacity-60' : 'hover:bg-muted/60'}`}>
      <div className="flex items-start gap-3.5 min-w-0">
        <div className="p-2 rounded-lg bg-white/60 border border-amber-950/10 eink-bordered text-muted-foreground shrink-0">
          {effectiveDark ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
        </div>
        <div className="min-w-0 py-0.5">
          <p className="text-sm font-medium text-foreground">外观</p>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
            {disabled ? '墨水屏模式下外观已固定为黑白主题' : '选择浅色、深色或跟随系统外观'}
          </p>
        </div>
      </div>
      <div
        role="radiogroup"
        aria-label="外观主题"
        aria-disabled={disabled || undefined}
        onKeyDown={handleKeyDown}
        className={`flex items-center rounded-lg p-1 shrink-0 border border-amber-950/10 bg-white/65 eink-bordered shadow-sm ${disabled ? 'pointer-events-none' : ''}`}
      >
        {options.map((opt) => {
          const Icon = opt.icon;
          const active = safeValue === opt.value;
          const optionIndex = options.indexOf(opt);
          return (
            <button
              key={opt.value}
              ref={(el) => { optionRefs.current[optionIndex] = el; }}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={opt.label}
              title={opt.label}
              disabled={disabled}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(opt.value)}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all',
                active
                  ? 'bg-background text-foreground shadow-sm dark:bg-white/10 dark:shadow-none'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="w-4 h-4" />
              <span className="hidden sm:inline">{opt.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ToggleRow({ icon: Icon, label, description, checked, onChange }: { icon: typeof User; label: string; description: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 rounded-3xl transition-colors hover:bg-muted/60">
      <div className="flex items-start gap-3.5 min-w-0">
        <div className="p-2 rounded-lg bg-white/60 border border-amber-950/10 eink-bordered text-muted-foreground shrink-0">
          <Icon className="w-4 h-4" />
        </div>
        <div className="min-w-0 py-0.5">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</p>
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-transparent transition-colors duration-200 eink:!bg-white eink:border-black ${checked ? 'bg-primary' : 'bg-muted-foreground/30'}`}
      >
        <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform duration-200 eink:!bg-black ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  );
}

function UpdateSection() {
  const status = useUpdateStore((s) => s.status);
  const availableVersion = useUpdateStore((s) => s.availableVersion);
  const error = useUpdateStore((s) => s.error);
  const progressPercent = useUpdateStore((s) => s.progressPercent);
  const checkedAt = useUpdateStore((s) => s.checkedAt);
  const platform = useUpdateStore((s) => s.platform);
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates);
  const installUpdate = useUpdateStore((s) => s.installUpdate);
  const copyReleaseUrl = useUpdateStore((s) => s.copyReleaseUrl);

  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') return null;

  // 移动端（安卓/OHOS/iOS）没有内置 updater，且 opener 插件无法调起系统
  // 浏览器，所以"检查更新"退化为复制 GitHub release 下载链接。
  const isMobile = platform === 'mobile';

  const statusText = (() => {
    if (isMobile) return '前往 GitHub 下载最新版本';
    if (status === 'checking') return '正在检查更新...';
    if (error) return `检查失败: ${error}`;
    if (status === 'downloading') return `下载中 ${progressPercent}%`;
    if (status === 'downloaded') return `新版本已下载，重启后生效`;
    if (status === 'installing') return '正在安装...';
    if (status === 'restarting') return '正在重启...';
    if (status === 'available' && availableVersion) return `发现新版本 ${availableVersion}`;
    if (status === 'up-to-date') return `已是最新版本 ${APP_VERSION}`;
    return '点击检查更新';
  })();

  const checkedAtText = checkedAt
    ? new Date(checkedAt).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })
    : null;

  const isBusy = status === 'checking' || status === 'downloading' || status === 'installing' || status === 'restarting';

  return (
    <div className="px-4 py-3.5 rounded-3xl">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-start gap-3.5 min-w-0">
          <div className="p-2 rounded-lg bg-white/60 border border-amber-950/10 eink-bordered text-muted-foreground shrink-0">
            <Download className="w-4 h-4" />
          </div>
          <div className="min-w-0 py-0.5">
            <p className="text-sm font-medium text-foreground">检查更新</p>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{statusText}</p>
            {checkedAtText && (
              <p className="text-[11px] text-muted-foreground/70 mt-0.5">上次检查: {checkedAtText}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {availableVersion && (status === 'available' || status === 'downloaded' || status === 'error') && (
            <button
              onClick={() => void installUpdate()}
              disabled={isBusy}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {status === 'downloaded' ? '安装并重启' : '立即更新'}
            </button>
          )}
          <button
            onClick={() => void (isMobile ? copyReleaseUrl() : checkForUpdates())}
            disabled={isBusy}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-border hover:bg-muted disabled:opacity-50 transition-colors flex items-center gap-1"
          >
            {isMobile
              ? <Copy className="w-3 h-3" />
              : <RefreshCw className={`w-3 h-3 ${status === 'checking' ? 'animate-spin' : ''}`} />}
            {isMobile ? '复制链接' : '检查'}
          </button>
        </div>
      </div>

      {(status === 'downloading' || status === 'restarting') && (
        <div className="mt-2 h-1 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${Math.min(progressPercent, 100)}%` }}
          />
        </div>
      )}
    </div>
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
