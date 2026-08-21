'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, FolderOpen, HardDrive, Pause, Play, Trash2, X } from 'lucide-react';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { request } from '@/lib/api';
import { downloadAndSaveOfflineBook } from '@/lib/offline-download';
import {
  deleteOfflineBook,
  listOfflineBooks,
  removeOfflinePartial,
  syncOfflineDownloadState,
  type OfflineBookRecord,
} from '@/lib/offline-books';
import {
  cancelOfflineDownload,
  listOfflineDownloadSnapshots,
  pauseOfflineDownload,
  removeOfflineDownloadSnapshot,
  startOfflineDownload,
  subscribeOfflineDownloads,
  type OfflineDownloadSnapshot,
  type OfflineDownloadStatus,
} from '@/lib/offline-download-manager';
import { makeOfflineBookKey } from '@/lib/offline-book-core';
import { useServerStore } from '@/lib/store/server';
import { useSettingsStore } from '@/lib/store/settings';
import { useToast } from '@/lib/toast';

interface DownloadItem extends OfflineDownloadSnapshot {
  key: string;
  record?: OfflineBookRecord;
  stale?: boolean;
}

const TABS: Array<{ value: 'all' | OfflineDownloadStatus; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'downloading', label: '下载中' },
  { value: 'completed', label: '已下载' },
  { value: 'paused', label: '暂停' },
  { value: 'failed', label: '失败' },
];

function formatBytes(bytes?: number | null): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatEta(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '计算中';
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
}

function statusLabel(status: OfflineDownloadStatus): string {
  return ({ downloading: '下载中', completed: '已下载', paused: '已暂停', failed: '失败', cancelled: '已取消' })[status];
}

export default function DownloadsPage() {
  const serverUrl = useServerStore((state) => state.serverUrl);
  const downloadDirectory = useSettingsStore((state) => state.downloadDirectory);
  const toast = useToast((state) => state.show);
  const [records, setRecords] = useState<OfflineBookRecord[]>([]);
  const [tasks, setTasks] = useState<OfflineDownloadSnapshot[]>([]);
  const [tab, setTab] = useState<'all' | OfflineDownloadStatus>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [availableBytes, setAvailableBytes] = useState<number | null>(null);
  const [staleKeys, setStaleKeys] = useState<Set<string>>(new Set());
  const [remoteRetry, setRemoteRetry] = useState<{ bookId: string; title: string } | null>(null);

  const refresh = useCallback(async () => {
    setTasks(listOfflineDownloadSnapshots(serverUrl));
    try { setRecords(await listOfflineBooks(serverUrl)); } catch { setRecords([]); }
  }, [serverUrl]);

  useEffect(() => {
    void refresh();
    return subscribeOfflineDownloads(() => { void refresh(); });
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    const loadSpace = async () => {
      try {
        if (process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri') {
          const { invoke } = await import('@tauri-apps/api/core');
          const result = await invoke<{ availableBytes: number }>('moke_download_storage_stats', { directory: downloadDirectory });
          if (!cancelled) setAvailableBytes(result.availableBytes);
        } else if (navigator.storage?.estimate) {
          const estimate = await navigator.storage.estimate();
          if (!cancelled) setAvailableBytes((estimate.quota || 0) - (estimate.usage || 0));
        }
      } catch { if (!cancelled) setAvailableBytes(null); }
    };
    void loadSpace();
    return () => { cancelled = true; };
  }, [downloadDirectory, records, tasks]);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const stale = new Set<string>();
      await Promise.all(records.filter((record) => record.sourceSignature).map(async (record) => {
        try {
          const response = await request(`${serverUrl}/api/book/${record.bookId}.${record.format}`, {
            method: 'HEAD', credentials: 'include',
          });
          const signature = response.headers.get('etag') || response.headers.get('last-modified');
          if (signature && signature !== record.sourceSignature) stale.add(record.id);
        } catch { /* an offline manager must stay useful without network */ }
      }));
      if (!cancelled) setStaleKeys(stale);
    };
    void check();
    return () => { cancelled = true; };
  }, [records, serverUrl]);

  const items = useMemo<DownloadItem[]>(() => {
    const merged = new Map<string, DownloadItem>();
    for (const task of tasks) {
      if (!task.key) continue;
      merged.set(task.key, { ...task, key: task.key });
    }
    for (const record of records) {
      const task = merged.get(record.id);
      merged.set(record.id, {
        ...task,
        key: record.id,
        serverUrl: record.serverUrl,
        bookId: record.bookId,
        title: record.title,
        format: record.format,
        status: 'completed',
        progress: 100,
        downloadedBytes: record.size,
        totalBytes: record.size,
        updatedAt: record.updatedAt,
        record,
        stale: staleKeys.has(record.id),
      });
    }
    return Array.from(merged.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [records, staleKeys, tasks]);

  const visible = tab === 'all' ? items : items.filter((item) => item.status === tab);
  const usedBytes = records.reduce((sum, record) => sum + record.size, 0)
    + tasks.filter((task) => task.status !== 'completed').reduce((sum, task) => sum + (task.downloadedBytes || 0), 0);

  const start = useCallback((item: DownloadItem) => {
    if (!item.serverUrl || !item.bookId || !item.title || !item.format) return;
    const key = makeOfflineBookKey(item.serverUrl, item.bookId, item.format);
    void startOfflineDownload({
      key,
      metadata: {
        serverUrl: item.serverUrl,
        bookId: item.bookId,
        title: item.title,
        format: item.format,
        downloadedBytes: item.status === 'completed' ? 0 : item.downloadedBytes,
        totalBytes: item.totalBytes,
      },
      run: (onProgress, signal, onTransfer) => downloadAndSaveOfflineBook({
        serverUrl: item.serverUrl!, bookId: item.bookId!, title: item.title!, format: item.format!,
        onProgress, onTransfer, signal, resume: item.status !== 'completed', preservePartialOnAbort: true,
      }),
      onCancel: () => removeOfflinePartial({
        serverUrl: item.serverUrl!, bookId: item.bookId!, title: item.title!, format: item.format!, downloadDirectory,
      }),
    }).then(refresh).catch(() => refresh());
  }, [downloadDirectory, refresh]);

  const cancel = useCallback(async (item: DownloadItem) => {
    if (item.status === 'downloading') {
      cancelOfflineDownload(item.key);
    } else {
      cancelOfflineDownload(item.key);
      if (item.serverUrl && item.bookId && item.title && item.format) {
        await removeOfflinePartial({
          serverUrl: item.serverUrl, bookId: item.bookId, title: item.title, format: item.format, downloadDirectory,
        });
      }
      removeOfflineDownloadSnapshot(item.key);
    }
    await refresh();
  }, [downloadDirectory, refresh]);

  const remove = useCallback(async (item: DownloadItem) => {
    if (!item.serverUrl || !item.bookId || !item.format) return;
    try {
      const result = await deleteOfflineBook(item.serverUrl, item.bookId, item.format);
      removeOfflineDownloadSnapshot(item.key);
      if (!result.remoteSynced) setRemoteRetry({ bookId: item.bookId, title: item.title || '书籍' });
      toast(result.remoteSynced ? '本地文件已删除' : '本地已删除，服务器状态同步失败', result.remoteSynced ? 'info' : 'error');
      await refresh();
    } catch { toast('删除本地文件失败，请重试', 'error'); }
  }, [refresh, toast]);

  const openLocation = async (item: DownloadItem) => {
    if (!item.record?.filePath || process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') return;
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(item.record.filePath);
    } catch { toast('当前平台无法打开文件所在位置', 'error'); }
  };

  const applyBatch = async (action: 'pause' | 'resume' | 'cancel' | 'delete') => {
    const targets = items.filter((item) => selected.has(item.key));
    for (const item of targets) {
      if (action === 'pause') pauseOfflineDownload(item.key);
      if (action === 'resume' && (item.status === 'paused' || item.status === 'failed' || item.status === 'cancelled')) start(item);
      if (action === 'cancel') await cancel(item);
      if (action === 'delete' && item.status === 'completed') await remove(item);
    }
    setSelected(new Set());
  };

  return (
    <DesktopLayout>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-5 sm:px-6 md:px-8 md:py-8">
        <div className="mx-auto max-w-5xl">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold text-foreground">下载管理</h1>
              <p className="mt-1 text-sm text-muted-foreground">暂停、继续、重试或清理当前服务器的离线书籍</p>
            </div>
            <div className="app-card rounded-xl px-4 py-2 text-xs text-muted-foreground">
              已用 <b className="text-foreground">{formatBytes(usedBytes)}</b>
              <span className="mx-2">·</span>
              可用 <b className="text-foreground">{availableBytes == null ? '平台未提供' : formatBytes(availableBytes)}</b>
            </div>
          </div>

          {remoteRetry && (
            <div className="mb-4 flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span className="flex-1">《{remoteRetry.title}》本地已删除，但服务器下载状态尚未同步。</span>
              <button className="font-medium underline" onClick={() => void syncOfflineDownloadState(serverUrl, remoteRetry.bookId, false)
                .then(() => { setRemoteRetry(null); toast('服务器状态已同步'); })
                .catch(() => toast('同步仍然失败，请稍后重试', 'error'))}>重试同步</button>
            </div>
          )}

          <div className="mb-4 flex gap-2 overflow-x-auto">
            {TABS.map((item) => (
              <button key={item.value} onClick={() => setTab(item.value)} className={`rounded-lg px-3 py-1.5 text-sm ${tab === item.value ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                {item.label} ({item.value === 'all' ? items.length : items.filter((entry) => entry.status === item.value).length})
              </button>
            ))}
          </div>

          {selected.size > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-background p-3 text-sm">
              <span className="mr-auto">已选择 {selected.size} 项</span>
              <button onClick={() => void applyBatch('pause')} className="rounded-lg bg-muted px-3 py-1.5">批量暂停</button>
              <button onClick={() => void applyBatch('resume')} className="rounded-lg bg-muted px-3 py-1.5">批量继续/重试</button>
              <button onClick={() => void applyBatch('cancel')} className="rounded-lg bg-muted px-3 py-1.5">批量取消</button>
              <button onClick={() => void applyBatch('delete')} className="rounded-lg bg-destructive/10 px-3 py-1.5 text-destructive">批量删除</button>
            </div>
          )}

          <div className="space-y-3">
            {visible.map((item) => (
              <article key={item.key} className="app-card rounded-2xl border border-border/60 p-4">
                <div className="flex items-start gap-3">
                  <input type="checkbox" checked={selected.has(item.key)} onChange={(event) => setSelected((current) => {
                    const next = new Set(current); if (event.target.checked) next.add(item.key); else next.delete(item.key); return next;
                  })} className="mt-1 h-4 w-4" aria-label={`选择${item.title}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate font-medium text-foreground">{item.title || item.bookId}</h2>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{item.format}</span>
                      <span className="text-xs text-muted-foreground">{statusLabel(item.status)}</span>
                      {item.stale && <span className="text-xs text-destructive">服务器文件已更新，建议重新下载</span>}
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${item.progress}%` }} />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>{item.progress}%</span>
                      <span>{formatBytes(item.downloadedBytes)} / {item.totalBytes ? formatBytes(item.totalBytes) : '未知大小'}</span>
                      {item.status === 'downloading' && <><span>{formatBytes(item.speedBytesPerSecond)}/s</span><span>剩余 {formatEta(item.etaSeconds)}</span></>}
                      {Boolean(item.error) && <span className="text-destructive">{String(item.error)}</span>}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1">
                    {item.status === 'downloading' && <button title="暂停" onClick={() => pauseOfflineDownload(item.key)} className="rounded-lg p-2 hover:bg-muted"><Pause className="h-4 w-4" /></button>}
                    {(item.status === 'paused' || item.status === 'failed' || item.status === 'cancelled' || item.stale) && <button title="继续或重试" onClick={() => start(item)} className="rounded-lg p-2 hover:bg-muted"><Play className="h-4 w-4" /></button>}
                    {item.status !== 'completed' && <button title="取消" onClick={() => void cancel(item)} className="rounded-lg p-2 hover:bg-muted"><X className="h-4 w-4" /></button>}
                    {item.status === 'completed' && process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri' && <button title="打开所在位置" onClick={() => void openLocation(item)} className="rounded-lg p-2 hover:bg-muted"><FolderOpen className="h-4 w-4" /></button>}
                    {item.status === 'completed' && <button title="删除" onClick={() => void remove(item)} className="rounded-lg p-2 text-destructive hover:bg-destructive/10"><Trash2 className="h-4 w-4" /></button>}
                  </div>
                </div>
              </article>
            ))}
            {visible.length === 0 && (
              <div className="app-card rounded-2xl py-16 text-center text-sm text-muted-foreground">
                <HardDrive className="mx-auto mb-3 h-8 w-8 opacity-40" />此分类暂无下载
              </div>
            )}
          </div>
          <p className="mt-5 text-xs text-muted-foreground">
            {process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri'
              ? '桌面版支持断点续传和打开文件位置；移动端文件位置由系统管理。'
              : 'Web 版使用浏览器存储，不支持选择系统目录或打开文件所在位置。'}
          </p>
        </div>
      </div>
    </DesktopLayout>
  );
}
