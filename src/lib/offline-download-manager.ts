'use client';

export type OfflineDownloadStatus = 'downloading' | 'completed' | 'failed' | 'paused' | 'cancelled';

export interface OfflineDownloadSnapshot {
  key?: string;
  status: OfflineDownloadStatus;
  progress: number;
  error?: unknown;
  serverUrl?: string;
  bookId?: string;
  title?: string;
  format?: string;
  downloadedBytes?: number;
  totalBytes?: number | null;
  speedBytesPerSecond?: number;
  etaSeconds?: number | null;
  updatedAt?: number;
}

interface OfflineDownloadTask {
  snapshot: OfflineDownloadSnapshot;
  promise: Promise<void>;
  listeners: Set<(snapshot: OfflineDownloadSnapshot) => void>;
  controller: AbortController;
  stopReason?: 'pause' | 'cancel';
  onCancel?: () => Promise<void>;
}

const STORAGE_KEY = 'moke-offline-download-tasks-v1';
const tasks = new Map<string, OfflineDownloadTask>();
const snapshots = new Map<string, OfflineDownloadSnapshot>();
const listenersByKey = new Map<string, Set<(snapshot: OfflineDownloadSnapshot) => void>>();
const globalListeners = new Set<() => void>();
let hydrated = false;

function hydrate(): void {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]') as OfflineDownloadSnapshot[];
    for (const value of stored) {
      if (!value.key) continue;
      snapshots.set(value.key, value.status === 'downloading'
        ? { ...value, status: 'paused', error: '应用上次异常退出，可继续下载', updatedAt: Date.now() }
        : value);
    }
    persist();
  } catch { /* corrupted task state is non-fatal */ }
}

function persist(): void {
  if (typeof window === 'undefined') return;
  try {
    const values = Array.from(snapshots.values()).map((snapshot) => ({
      ...snapshot,
      error: snapshot.error instanceof Error ? snapshot.error.message : snapshot.error,
    }));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch { /* quota/privacy mode */ }
}

function notify(key: string, snapshot: OfflineDownloadSnapshot): void {
  snapshots.set(key, snapshot);
  persist();
  for (const listener of listenersByKey.get(key) ?? []) listener(snapshot);
  for (const listener of globalListeners) listener();
}

function publish(task: OfflineDownloadTask, snapshot: OfflineDownloadSnapshot): void {
  task.snapshot = snapshot;
  notify(snapshot.key!, snapshot);
}

export function getOfflineDownloadSnapshot(key: string): OfflineDownloadSnapshot | undefined {
  hydrate();
  return tasks.get(key)?.snapshot ?? snapshots.get(key);
}

export function listOfflineDownloadSnapshots(serverUrl?: string): OfflineDownloadSnapshot[] {
  hydrate();
  return Array.from(snapshots.values())
    .filter((snapshot) => !serverUrl || snapshot.serverUrl === serverUrl)
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
}

export function subscribeOfflineDownloads(listener: () => void): () => void {
  hydrate();
  globalListeners.add(listener);
  return () => { globalListeners.delete(listener); };
}

export function subscribeOfflineDownload(key: string, listener: (snapshot: OfflineDownloadSnapshot) => void): () => void {
  hydrate();
  const listeners = listenersByKey.get(key) ?? new Set();
  listenersByKey.set(key, listeners);
  listeners.add(listener);
  const snapshot = getOfflineDownloadSnapshot(key);
  if (snapshot) listener(snapshot);
  return () => { listeners.delete(listener); };
}

export interface StartOfflineDownloadOptions {
  key: string;
  metadata?: Pick<OfflineDownloadSnapshot, 'serverUrl' | 'bookId' | 'title' | 'format' | 'downloadedBytes' | 'totalBytes'>;
  run: (
    onProgress: (progress: number) => void,
    signal: AbortSignal,
    onTransfer: (receivedBytes: number, totalBytes: number | null) => void,
  ) => Promise<void>;
  onCancel?: () => Promise<void>;
}

/** Start a process-wide, persisted download that survives its initiating page. */
export function startOfflineDownload(options: StartOfflineDownloadOptions): Promise<void> {
  hydrate();
  const existing = tasks.get(options.key);
  if (existing?.snapshot.status === 'downloading') return existing.promise;

  const previous = snapshots.get(options.key);
  const startedAt = Date.now();
  const initialBytes = options.metadata?.downloadedBytes ?? previous?.downloadedBytes ?? 0;
  let sampleAt = startedAt;
  let sampleBytes = initialBytes;
  const controller = new AbortController();
  const task: OfflineDownloadTask = {
    snapshot: {
      ...previous,
      ...options.metadata,
      key: options.key,
      status: 'downloading',
      progress: previous?.progress ?? 0,
      downloadedBytes: initialBytes,
      error: undefined,
      speedBytesPerSecond: 0,
      etaSeconds: null,
      updatedAt: startedAt,
    },
    promise: Promise.resolve(),
    listeners: listenersByKey.get(options.key) ?? new Set(),
    controller,
    onCancel: options.onCancel,
  };
  tasks.set(options.key, task);
  publish(task, task.snapshot);

  task.promise = options.run(
    (progress) => publish(task, { ...task.snapshot, status: 'downloading', progress, updatedAt: Date.now() }),
    controller.signal,
    (downloadedBytes, totalBytes) => {
      const now = Date.now();
      const elapsed = Math.max(1, now - sampleAt);
      const instantaneous = Math.max(0, downloadedBytes - sampleBytes) * 1000 / elapsed;
      const previousSpeed = task.snapshot.speedBytesPerSecond || 0;
      const speedBytesPerSecond = previousSpeed ? previousSpeed * 0.7 + instantaneous * 0.3 : instantaneous;
      if (elapsed >= 500) { sampleAt = now; sampleBytes = downloadedBytes; }
      const progress = totalBytes ? Math.min(99, Math.round(downloadedBytes / totalBytes * 100)) : task.snapshot.progress;
      publish(task, {
        ...task.snapshot,
        status: 'downloading',
        progress,
        downloadedBytes,
        totalBytes,
        speedBytesPerSecond,
        etaSeconds: totalBytes && speedBytesPerSecond > 0 ? Math.max(0, (totalBytes - downloadedBytes) / speedBytesPerSecond) : null,
        updatedAt: now,
      });
    },
  ).then(() => {
    publish(task, {
      ...task.snapshot,
      status: 'completed',
      progress: 100,
      speedBytesPerSecond: 0,
      etaSeconds: 0,
      error: undefined,
      updatedAt: Date.now(),
    });
  }).catch(async (error: unknown) => {
    if (task.stopReason === 'cancel') {
      try { await task.onCancel?.(); } catch (cleanupError) { console.warn('Failed to clean cancelled download:', cleanupError); }
      snapshots.delete(options.key);
      persist();
      for (const listener of globalListeners) listener();
      return;
    }
    if (task.stopReason === 'pause') {
      publish(task, { ...task.snapshot, status: 'paused', speedBytesPerSecond: 0, etaSeconds: null, error: undefined, updatedAt: Date.now() });
      return;
    }
    publish(task, { ...task.snapshot, status: 'failed', speedBytesPerSecond: 0, etaSeconds: null, error, updatedAt: Date.now() });
    throw error;
  }).finally(() => { tasks.delete(options.key); });
  return task.promise;
}

export function pauseOfflineDownload(key: string): boolean {
  const task = tasks.get(key);
  if (!task || task.snapshot.status !== 'downloading') return false;
  task.stopReason = 'pause';
  task.controller.abort();
  return true;
}

export function cancelOfflineDownload(key: string): boolean {
  const task = tasks.get(key);
  if (!task || task.snapshot.status !== 'downloading') {
    const snapshot = snapshots.get(key);
    if (!snapshot) return false;
    notify(key, { ...snapshot, status: 'cancelled', error: undefined, updatedAt: Date.now() });
    return true;
  }
  task.stopReason = 'cancel';
  task.controller.abort();
  return true;
}

export function removeOfflineDownloadSnapshot(key: string): void {
  tasks.get(key)?.controller.abort();
  tasks.delete(key);
  snapshots.delete(key);
  persist();
  for (const listener of globalListeners) listener();
}
