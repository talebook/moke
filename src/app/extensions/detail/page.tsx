'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Package,
  Puzzle,
  Shield,
  ToggleLeft,
  ToggleRight,
  Trash2,
} from 'lucide-react';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { useExtensionStore, type ExtensionInfo } from '@/lib/store/extensions';

function DetailContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const name = searchParams.get('name') ?? '';
  const { extensions, loaded, loadExtensions, enableExtension, disableExtension, uninstallExtension } =
    useExtensionStore();
  const [actionInProgress, setActionInProgress] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) loadExtensions();
  }, [loaded, loadExtensions]);

  const ext = extensions.find((e) => e.name === name);

  const handleToggle = async () => {
    if (!ext) return;
    setActionInProgress(true);
    setErrorMsg(null);
    try {
      if (ext.enabled) await disableExtension(ext.name);
      else await enableExtension(ext.name);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setActionInProgress(false);
    }
  };

  const handleUninstall = async () => {
    if (!ext) return;
    if (!confirm(`确定要卸载 ${ext.displayName} 吗？`)) return;
    setActionInProgress(true);
    setErrorMsg(null);
    try {
      await uninstallExtension(ext.name);
      router.push('/extensions');
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setActionInProgress(false);
    }
  };

  if (!loaded || !name) {
    return (
      <DesktopLayout>
        <div className="flex-1 min-h-0 overflow-y-auto px-8 py-8">
          <div className="mx-auto flex items-center justify-center py-20" style={{ maxWidth: '860px' }}>
            <p className="text-sm text-muted-foreground">{!name ? '未指定拓展名称' : '加载中...'}</p>
          </div>
        </div>
      </DesktopLayout>
    );
  }

  if (!ext) {
    return (
      <DesktopLayout>
        <div className="flex-1 min-h-0 overflow-y-auto px-8 py-8">
          <div className="mx-auto flex flex-col items-center justify-center py-20 text-center" style={{ maxWidth: '860px' }}>
            <Puzzle className="w-10 h-10 text-muted-foreground/40 mb-4" />
            <p className="text-sm text-muted-foreground">未找到拓展「{name}」</p>
            <button
              onClick={() => router.push('/extensions')}
              className="mt-3 text-sm text-primary hover:underline"
            >
              返回拓展列表
            </button>
          </div>
        </div>
      </DesktopLayout>
    );
  }

  return (
    <DesktopLayout>
      <div className="flex-1 min-h-0 overflow-y-auto px-8 py-8">
        <div className="mx-auto" style={{ maxWidth: '860px' }}>
          {errorMsg && (
            <div className="mb-4 px-4 py-3 rounded-xl bg-destructive/10 border border-destructive/20 text-sm text-destructive flex items-center justify-between">
              <span>{errorMsg}</span>
              <button onClick={() => setErrorMsg(null)} className="ml-2 shrink-0 hover:opacity-70">&times;</button>
            </div>
          )}
          <button
            onClick={() => router.push('/extensions')}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
          >
            <ArrowLeft className="w-4 h-4" />
            返回拓展列表
          </button>

          <div className="flex items-start gap-4 mb-8">
            <div
              className={`p-3.5 rounded-2xl shrink-0 border ${
                ext.enabled
                  ? 'bg-green-50 border-green-200 text-green-600'
                  : 'bg-white/60 border-amber-950/10 text-muted-foreground'
              }`}
            >
              <Package className="w-6 h-6" />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold text-foreground">{ext.displayName}</h1>
              <p className="text-sm text-muted-foreground mt-1">{ext.description}</p>
              <div className="flex items-center gap-3 mt-2">
                <span className="text-xs text-muted-foreground font-mono">v{ext.version}</span>
                <span className="text-xs text-muted-foreground">作者: {ext.author || '未知'}</span>
              </div>
            </div>
          </div>

          <div className="space-y-8">
            <section className="space-y-3">
              <div className="px-1">
                <h2 className="text-sm font-semibold text-foreground tracking-tight">状态与操作</h2>
              </div>
              <div className="divide-y divide-amber-950/10 rounded-[28px] app-glass p-1">
                <InfoRow label="状态" value={ext.enabled ? '已启用' : '已禁用'} />
                <InfoRow label="类型" value={[ext.hasBackend && '原生后端', ext.hasUi && '前端界面'].filter(Boolean).join('、') || '无头'} />
                <InfoRow label="标识" value={ext.name} mono />
                <InfoRow label="端口" value={ext.enabled && ext.port > 0 ? `${ext.port}` : '-'} mono />
                {ext.sidebar && (
                  <InfoRow label="侧边栏" value={`"${ext.sidebar.label}" (位置 ${ext.sidebar.order})`} />
                )}
                <ActionRow
                  icon={ext.enabled ? ToggleLeft : ToggleRight}
                  label={ext.enabled ? '禁用' : '启用'}
                  tone={ext.enabled ? 'default' : 'primary'}
                  disabled={actionInProgress}
                  onClick={handleToggle}
                />
                <ActionRow
                  icon={Trash2}
                  label="卸载拓展"
                  tone="danger"
                  disabled={actionInProgress}
                  onClick={handleUninstall}
                />
              </div>
            </section>

            <section className="space-y-3">
              <div className="px-1">
                <h2 className="text-sm font-semibold text-foreground tracking-tight">权限</h2>
              </div>
              <div className="rounded-[28px] app-glass p-1">
                {ext.permissions.length === 0 ? (
                  <div className="px-4 py-3 text-xs text-muted-foreground">该拓展未声明任何权限</div>
                ) : (
                  ext.permissions.map((p) => (
                    <div key={p} className="flex items-center gap-3 px-4 py-2.5">
                      <Shield className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span className="text-sm font-mono text-muted-foreground">{p}</span>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </DesktopLayout>
  );
}

export default function DetailPage() {
  return (
    <Suspense fallback={<DesktopLayout><div className="flex-1 min-h-0 overflow-y-auto px-8 py-8"><div className="mx-auto flex items-center justify-center py-20" style={{ maxWidth: '860px' }}><p className="text-sm text-muted-foreground">加载中...</p></div></div></DesktopLayout>}>
      <DetailContent />
    </Suspense>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 rounded-xl">
      <span className="text-sm font-medium text-foreground shrink-0">{label}</span>
      <span className={`text-sm text-muted-foreground truncate text-right ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
      </span>
    </div>
  );
}

function ActionRow({
  icon: Icon,
  label,
  tone = 'default',
  disabled,
  onClick,
}: {
  icon: typeof Package;
  label: string;
  tone?: 'default' | 'danger' | 'primary';
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-left transition-all duration-200 active:scale-[0.99] group disabled:opacity-40 ${
        tone === 'danger'
          ? 'hover:bg-destructive/5'
          : tone === 'primary'
            ? 'hover:bg-primary/5'
            : 'hover:bg-muted/80'
      }`}
    >
      <div className="flex items-center gap-3.5 min-w-0">
        <div className={`p-2 rounded-lg bg-white/60 border border-amber-950/10 shrink-0 ${
          tone === 'danger' ? 'group-hover:border-destructive/20' : tone === 'primary' ? 'group-hover:border-primary/20' : ''
        }`}>
          <Icon className={`w-4 h-4 ${
            tone === 'danger' ? 'text-destructive' : tone === 'primary' ? 'text-primary' : 'text-muted-foreground'
          }`} />
        </div>
        <span className={`text-sm font-medium ${
          tone === 'danger' ? 'text-destructive' : tone === 'primary' ? 'text-primary' : 'text-foreground'
        }`}>
          {label}
        </span>
      </div>
    </button>
  );
}
