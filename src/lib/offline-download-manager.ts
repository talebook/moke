export type OfflineDownloadStatus = 'downloading' | 'completed' | 'failed';

export interface OfflineDownloadSnapshot {
  status: OfflineDownloadStatus;
  progress: number;
  error?: unknown;
}

interface OfflineDownloadTask {
  snapshot: OfflineDownloadSnapshot;
  promise: Promise<void>;
  listeners: Set<(snapshot: OfflineDownloadSnapshot) => void>;
}

const tasks = new Map<string, OfflineDownloadTask>();
const listenersByKey = new Map<string, Set<(snapshot: OfflineDownloadSnapshot) => void>>();

function publish(task: OfflineDownloadTask, snapshot: OfflineDownloadSnapshot): void {
  task.snapshot = snapshot;
  for (const listener of task.listeners) listener(snapshot);
}

export function getOfflineDownloadSnapshot(key: string): OfflineDownloadSnapshot | undefined {
  return tasks.get(key)?.snapshot;
}

export function subscribeOfflineDownload(
  key: string,
  listener: (snapshot: OfflineDownloadSnapshot) => void,
): () => void {
  const task = tasks.get(key);
  const listeners = listenersByKey.get(key) ?? new Set();
  listenersByKey.set(key, listeners);
  listeners.add(listener);
  if (task) listener(task.snapshot);
  return () => {
    listeners.delete(listener);
  };
}

/** Start a process-wide download that survives the page which initiated it. */
export function startOfflineDownload(options: {
  key: string;
  run: (onProgress: (progress: number) => void) => Promise<void>;
}): Promise<void> {
  const existing = tasks.get(options.key);
  if (existing?.snapshot.status === 'downloading') return existing.promise;

  const task: OfflineDownloadTask = {
    snapshot: { status: 'downloading', progress: 0 },
    promise: Promise.resolve(),
    listeners: listenersByKey.get(options.key) ?? new Set(),
  };
  tasks.set(options.key, task);
  task.promise = options
    .run((progress) => publish(task, { status: 'downloading', progress }))
    .then(() => publish(task, { status: 'completed', progress: 100 }))
    .catch((error: unknown) => {
      publish(task, { status: 'failed', progress: 0, error });
      throw error;
    });
  return task.promise;
}
