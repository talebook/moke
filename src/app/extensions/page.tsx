'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Package,
  Puzzle,
  Shield,
  Settings2,
  ToggleLeft,
  ToggleRight,
  Trash2,
  ExternalLink,
} from 'lucide-react';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { useExtensionStore, type ExtensionInfo } from '@/lib/store/extensions';

export default function ExtensionsPage() {
  const router = useRouter();
  const { extensions, loaded, loadExtensions, enableExtension, disableExtension, uninstallExtension } =
    useExtensionStore();
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  useEffect(() => {
    loadExtensions();
  }, [loadExtensions]);

  const handleToggle = async (ext: ExtensionInfo) => {
    setActionInProgress(ext.name);
    try {
      if (ext.enabled) {
        await disableExtension(ext.name);
      } else {
        await enableExtension(ext.name);
      }
    } catch (e) {
      console.error('[extensions] 操作失败:', e);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleUninstall = async (ext: ExtensionInfo) => {
    if (!confirm(`确定要卸载 ${ext.displayName} 吗？`)) return;
    setActionInProgress(ext.name);
    try {
      await uninstallExtension(ext.name);
    } catch (e) {
      console.error('[extensions] 卸载失败:', e);
    } finally {
      setActionInProgress(null);
    }
  };

  const enabledCount = extensions.filter((e) => e.enabled).length;
  const disabledCount = extensions.filter((e) => !e.enabled).length;

  return (
    <DesktopLayout>
      <div className="flex-1 min-h-0 overflow-y-auto px-8 py-8">
        <div className="mx-auto" style={{ maxWidth: '860px' }}>
          <div className="mb-8">
            <h1 className="text-2xl font-semibold text-foreground">拓展</h1>
            <p className="text-sm text-muted-foreground mt-1">
              管理已安装的拓展程序
            </p>
          </div>

          {!loaded ? (
            <div className="flex items-center justify-center py-20">
              <p className="text-sm text-muted-foreground">加载中...</p>
            </div>
          ) : extensions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <Puzzle className="w-12 h-12 text-muted-foreground/40 mb-4" />
              <p className="text-sm text-muted-foreground">暂无已安装的拓展</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                将拓展安装到 AppData 目录后，重启应用即可在此处管理
              </p>
            </div>
          ) : (
            <div className="space-y-8">
              {/* 统计 */}
              <div className="flex gap-4 text-sm text-muted-foreground">
                <span>共 {extensions.length} 个</span>
                <span>·</span>
                <span className="text-green-600">{enabledCount} 个已启用</span>
                <span>·</span>
                <span>{disabledCount} 个已禁用</span>
              </div>

              {/* 拓展列表 */}
              <div className="space-y-3">
                {extensions.map((ext) => (
                  <ExtensionCard
                    key={ext.name}
                    ext={ext}
                    busy={actionInProgress === ext.name}
                    onToggle={() => handleToggle(ext)}
                    onUninstall={() => handleUninstall(ext)}
                    onDetail={() => router.push(`/extensions/detail?name=${ext.name}`)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </DesktopLayout>
  );
}

function ExtensionCard({
  ext,
  busy,
  onToggle,
  onUninstall,
  onDetail,
}: {
  ext: ExtensionInfo;
  busy: boolean;
  onToggle: () => void;
  onUninstall: () => void;
  onDetail: () => void;
}) {
  const permBadges = ext.permissions.slice(0, 3);
  const more = ext.permissions.length - 3;

  return (
    <div className="rounded-[24px] app-glass p-4 transition-all duration-200 hover:bg-white/70">
      <div className="flex items-start justify-between gap-4">
        {/* 左侧信息 */}
        <div className="flex items-start gap-3.5 min-w-0 flex-1">
          <div
            className={`p-2.5 rounded-xl shrink-0 border transition-colors ${
              ext.enabled
                ? 'bg-green-50 border-green-200 text-green-600'
                : 'bg-white/60 border-amber-950/10 text-muted-foreground'
            }`}
          >
            <Package className="w-5 h-5" />
          </div>
          <div className="min-w-0 py-0.5">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-foreground">{ext.displayName}</p>
              <span className="text-[11px] text-muted-foreground/60 font-mono">v{ext.version}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">
              {ext.description}
            </p>
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              {permBadges.map((p) => (
                <span
                  key={p}
                  className="text-[10px] px-1.5 py-0.5 rounded-md bg-muted/60 text-muted-foreground font-mono"
                >
                  {p}
                </span>
              ))}
              {more > 0 && (
                <span className="text-[10px] text-muted-foreground/50">+{more}</span>
              )}
              {ext.hasBackend && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-700">
                  后端
                </span>
              )}
              {ext.hasUi && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-blue-50 text-blue-700">
                  UI
                </span>
              )}
            </div>
          </div>
        </div>

        {/* 右侧操作 */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onDetail}
            disabled={busy}
            className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors disabled:opacity-40"
            title="查看详情"
          >
            <Shield className="w-4 h-4" />
          </button>
          <button
            onClick={onToggle}
            disabled={busy}
            className={`p-2 rounded-lg transition-colors disabled:opacity-40 ${
              ext.enabled
                ? 'text-green-600 hover:bg-green-50'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/80'
            }`}
            title={ext.enabled ? '禁用' : '启用'}
          >
            {ext.enabled ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
          </button>
          <button
            onClick={onUninstall}
            disabled={busy}
            className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/5 transition-colors disabled:opacity-40"
            title="卸载"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
