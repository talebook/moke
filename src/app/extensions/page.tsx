'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Package,
  Puzzle,
  Shield,
  ToggleLeft,
  ToggleRight,
  Trash2,
  ShieldCheck,
  ShieldX,
  TriangleAlert,
} from 'lucide-react';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { useExtensionStore, prepareExtensionImport, cancelExtensionImport, commitExtensionImport, type ImportPreview, type ExtensionInfo } from '@/lib/store/extensions';

export default function ExtensionsPage() {
  const router = useRouter();
  const { extensions, loaded, loadExtensions, enableExtension, disableExtension, uninstallExtension } =
    useExtensionStore();
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    loadExtensions();
  }, [loadExtensions]);

  useEffect(() => {
    if (preview && dialog.current && !dialog.current.open) dialog.current.showModal();
    return () => { if (preview) void cancelExtensionImport(preview.ticket).catch(() => {}); };
  }, [preview]);

  const handleImport = async () => {
    setActionInProgress('import'); setErrorMsg(null); setNotice(null);
    try { setPreview(await prepareExtensionImport()); }
    catch (e) { setErrorMsg(String(e)); }
    finally { setActionInProgress(null); }
  };
  const cancelImport = async () => {
    if (!preview || actionInProgress) return;
    try { await cancelExtensionImport(preview.ticket); setPreview(null); }
    catch (e) { setErrorMsg(String(e)); }
  };
  const commitImport = async () => {
    if (!preview) return;
    setActionInProgress('import'); setErrorMsg(null);
    try {
      await commitExtensionImport(preview);
      setNotice('导入成功。新扩展请点击启用；升级保留原启用状态和扩展数据。');
    } catch (e) { setErrorMsg(String(e)); }
    finally { setPreview(null); setActionInProgress(null); }
  };

  const handleToggle = async (ext: ExtensionInfo) => {
    setActionInProgress(ext.name);
    setErrorMsg(null);
    try {
      if (ext.enabled) {
        await disableExtension(ext.name);
      } else {
        if (ext.trust.blockedReason) {
          throw new Error(ext.trust.blockedReason);
        }
        if (ext.trust.requiresApproval) {
          const approved = confirm(buildApprovalMessage(ext));
          if (!approved) return;
          await enableExtension(ext.name, { packageDigest: ext.trust.packageDigest });
        } else {
          await enableExtension(ext.name);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(`${ext.displayName}: ${msg}`);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleUninstall = async (ext: ExtensionInfo) => {
    if (!confirm(`确定要卸载 ${ext.displayName} 吗？`)) return;
    setActionInProgress(ext.name);
    setErrorMsg(null);
    try {
      await uninstallExtension(ext.name);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(`卸载 ${ext.displayName}: ${msg}`);
    } finally {
      setActionInProgress(null);
    }
  };

  const enabledCount = extensions.filter((e) => e.enabled).length;
  const disabledCount = extensions.filter((e) => !e.enabled).length;

  return (
    <DesktopLayout>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-5 sm:px-6 md:px-8 md:py-8">
        <div className="mx-auto flex min-h-full flex-col" style={{ maxWidth: '860px' }}>
          <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold text-foreground">拓展</h1>
              <p className="text-sm text-muted-foreground mt-1">
                管理已安装的拓展程序
              </p>
            </div>
            <button onClick={handleImport} disabled={Boolean(actionInProgress || preview)} className="shrink-0 px-4 py-2 rounded-lg bg-primary text-white disabled:opacity-40">
              {actionInProgress === 'import' ? '正在处理扩展包…' : '导入扩展'}
            </button>
          </div>

          {notice && <p role="status" className="mb-4 text-sm text-foreground">{notice}</p>}
          {preview && (
            <dialog ref={dialog} aria-labelledby="import-title" onCancel={(event) => { event.preventDefault(); void cancelImport(); }} className="max-w-lg w-[90vw] max-h-[90vh] overflow-y-auto rounded-xl bg-background text-foreground p-6 border border-border">
              <h2 id="import-title" className="text-lg font-semibold">{preview.extension.trust.upgradeFrom ? '确认升级扩展' : '确认安装扩展'}</h2>
              <p className="mt-2 font-medium">{preview.extension.displayName}（{preview.extension.name}）</p>
              <div className="mt-3 max-h-[55vh] overflow-y-auto whitespace-pre-wrap break-words text-sm">{buildApprovalMessage(preview.extension).replace(`启用 ${preview.extension.displayName} 前请核对：`, '安装前请核对：')}</div>
              <p className="mt-3 text-sm text-muted-foreground">校验期间不会运行包内程序。已启用扩展升级成功后会恢复运行。未知发布者的签名只证明内容来源，请确认你信任该作者。</p>
              <div className="mt-5 flex justify-end gap-3">
                <button autoFocus onClick={cancelImport} disabled={Boolean(actionInProgress)} className="px-4 py-2 rounded-lg border border-border">取消</button>
                <button onClick={commitImport} disabled={Boolean(actionInProgress)} className="px-4 py-2 rounded-lg bg-primary text-white disabled:opacity-40">{actionInProgress ? '正在安装…' : preview.extension.trust.upgradeFrom ? '确认升级' : '确认安装'}</button>
              </div>
            </dialog>
          )}
          {errorMsg && (
            <div className="mb-4 px-4 py-3 rounded-xl bg-destructive/10 border border-destructive/20 text-sm text-destructive flex items-center justify-between">
              <span>{errorMsg}</span>
              <button onClick={() => setErrorMsg(null)} className="ml-2 shrink-0 hover:opacity-70">&times;</button>
            </div>
          )}

          {!loaded ? (
            <div className="flex flex-1 items-center justify-center py-20">
              <p className="text-sm text-muted-foreground">加载中...</p>
            </div>
          ) : extensions.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
              <Puzzle className="w-12 h-12 text-muted-foreground/40 mb-4" />
              <p className="text-sm text-muted-foreground">暂无已安装的拓展</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                点击右上方“导入扩展”，选择本地 ZIP 文件开始安装
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
                    busy={Boolean(actionInProgress || preview)}
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
              <TrustBadge ext={ext} />
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
          {ext.resumePending && <span className="text-xs text-amber-700">上次启用未恢复，请重新确认或重试</span>}
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

function buildApprovalMessage(ext: ExtensionInfo): string {
  const lines = [
    `启用 ${ext.displayName} 前请核对：`,
    '',
    `签名：${trustLabel(ext)}`,
    `发布者：${ext.trust.publisherName || ext.trust.publisherId || '未知'}`,
    `来源：${ext.trust.source || '未声明'}`,
    `版本：${ext.trust.upgradeFrom ? `${ext.trust.upgradeFrom} → ` : ''}${ext.version}`,
    `当前权限：${ext.permissions.join('、') || '无'}`,
  ];
  if (ext.trust.permissionsAdded.length) {
    lines.push(`新增权限：${ext.trust.permissionsAdded.join('、')}`);
  }
  if (ext.trust.permissionsRemoved.length) {
    lines.push(`移除权限：${ext.trust.permissionsRemoved.join('、')}`);
  }
  if (ext.trust.risks.length) {
    lines.push('', '风险提示：', ...ext.trust.risks.map((risk) => `- ${risk}`));
  }
  lines.push('', `内容摘要：${ext.trust.packageDigest.slice(0, 16)}…`, '', '仅为当前内容确认。版本、来源或权限变化后必须重新确认。');
  return lines.join('\n');
}

function trustLabel(ext: ExtensionInfo): string {
  switch (ext.trust.signatureStatus) {
    case 'trusted': return '签名有效 / 发布者已确认';
    case 'unknown_publisher': return '签名有效 / 未知发布者或新密钥';
    case 'invalid': return '签名无效';
    default: return '未签名';
  }
}

function TrustBadge({ ext }: { ext: ExtensionInfo }) {
  const blocked = Boolean(ext.trust.blockedReason);
  const Icon = blocked ? ShieldX : ext.trust.trusted ? ShieldCheck : TriangleAlert;
  const className = blocked
    ? 'bg-red-50 text-red-700'
    : ext.trust.trusted
      ? 'bg-green-50 text-green-700'
      : 'bg-amber-50 text-amber-700';
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md ${className}`}>
      <Icon className="w-3 h-3" />
      {trustLabel(ext)}
    </span>
  );
}
