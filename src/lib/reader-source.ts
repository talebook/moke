export interface ReaderSource { serverUrl: string; bookId: string; sessionId: number }

export function assertReaderContext(source: ReaderSource, current: { sessionId: number; candidate: unknown }): void {
  if (source.sessionId !== current.sessionId || current.candidate) {
    throw new Error('连接或登录状态已改变，请返回书籍页面重试');
  }
}

interface ReaderHost {
  getWindowLabels: () => Promise<string[]>;
  getContext: () => Promise<{ sessionId: number; candidate: unknown }>;
  open: (args: Record<string, unknown>) => Promise<unknown>;
  wait: () => Promise<void>;
  now: () => number;
}

const UNRESOLVED_OPEN = '上次阅读器打开请求尚未确认，当前连接已保留。请等待窗口出现并关闭后重试；若一直未出现，请退出并重启应用。';

/** One dispatched request retains ownership until its real window is observed.
 * Readest has no creation/cancellation receipt. A timeout or IPC failure cannot
 * prove that its queued UI task will not create a window later.
 */
export function createReaderSourceBoundary(host: ReaderHost) {
  const windows = new Map<string, ReaderSource>();
  const retired = new Set<string>();
  let readerOpening = false;
  let readerSessionChanging = false;
  let pending: { source: ReaderSource; before: Set<string>; label: string | null } | null = null;
  const progressFlushes = new Set<() => Promise<void>>();

  function bindReaderWindow(windowLabel: string, source: ReaderSource): void {
    // Readest labels are monotonic for this process. Never overwrite ownership.
    if (!windows.has(windowLabel) && !retired.has(windowLabel)) windows.set(windowLabel, Object.freeze({ ...source }));
  }

  function observeWindow(label: string): void {
    if (!pending || pending.before.has(label) || retired.has(label) || !/^reader-\d+$/.test(label)) return;
    bindReaderWindow(label, pending.source);
    pending.label = label;
  }

  function reconcileWindows(labels: string[]): void {
    if (pending) {
      const request = pending;
      const created = labels.filter((label) => /^reader-\d+$/.test(label) && !request.before.has(label) && !retired.has(label));
      // Ambiguous observations cannot authorize a new request or a switch.
      if (created.length === 1 && (!request.label || request.label === created[0])) {
        observeWindow(created[0]);
        pending = null;
      }
    }
    for (const label of windows.keys()) {
      if (!labels.includes(label) && pending?.label !== label) retireReaderWindow(label);
    }
  }

  function retireReaderWindow(label: string): void {
    // book:closed has no Moke book id. Only an already associated label can
    // settle a request; an unknown delayed close cannot release a newer open.
    if (pending?.label === label) {
      pending = null;
    }
    windows.delete(label);
    if (/^reader-\d+$/.test(label)) retired.add(label);
  }

  function sourceForReaderEvent(windowLabel: string, bookId: string): ReaderSource | null {
    const known = windows.get(windowLabel);
    if (known) return known.bookId === bookId ? known : null;
    if (retired.has(windowLabel) || pending?.source.bookId !== bookId || pending.before.has(windowLabel)) return null;
    observeWindow(windowLabel);
    return windows.get(windowLabel) ?? null;
  }

  async function checkClosedReaders(): Promise<void> {
    const labels = await host.getWindowLabels();
    reconcileWindows(labels);
    if (pending) throw new Error(UNRESOLVED_OPEN);
    if (labels.some(isReaderWindow)) {
      throw new Error('请先关闭当前阅读器及阅读器书库窗口，再重试连接。当前连接已保留。');
    }
    await Promise.all([...progressFlushes].map((flush) => flush()));
  }

  async function requireClosedReaders(): Promise<void> {
    if (readerOpening) throw new Error('阅读器正在打开，请稍候再试。当前连接已保留。');
    if (readerSessionChanging) throw new Error('正在变更登录状态，请稍候再试。当前连接已保留。');
    await checkClosedReaders();
  }

  async function withClosedReaderSession<T>(change: () => Promise<T>): Promise<T> {
    if (readerOpening || readerSessionChanging) throw new Error('阅读器或登录状态正在变更，请稍候再试');
    readerSessionChanging = true;
    try {
      await checkClosedReaders();
      return await change();
    } finally { readerSessionChanging = false; }
  }

  async function openReaderFromSource(source: ReaderSource, args: Record<string, unknown>): Promise<void> {
    if (readerOpening || readerSessionChanging) throw new Error('阅读器或登录状态正在变更，请稍候再试');
    readerOpening = true;
    try {
      const before = await host.getWindowLabels();
      reconcileWindows(before);
      if (pending) throw new Error(UNRESOLVED_OPEN);
      // Check under the opening reservation so another launch cannot race the
      // caller's earlier window snapshot.
      if (before.some(isReaderWindow)) throw new Error('请先关闭当前阅读器，再打开书籍');
      assertReaderContext(source, await host.getContext());
      const request = { source: Object.freeze({ ...source }), before: new Set(before), label: null as string | null };
      pending = request;
      await host.open(args);
      const deadline = host.now() + 5000;
      while (host.now() < deadline) {
        if (request.label && pending !== request) return;
        reconcileWindows(await host.getWindowLabels());
        if (request.label && pending !== request) return;
        await host.wait();
      }
      throw new Error(UNRESOLVED_OPEN);
    } finally {
      // Only the foreground reservation ends. A dispatched request remains
      // unconfirmed even on rejection: the transport may have lost its receipt.
      readerOpening = false;
    }
  }

  return {
    bindReaderWindow, sourceForReaderEvent, retireReaderWindow, requireClosedReaders, withClosedReaderSession, openReaderFromSource,
    registerReaderProgressFlush(flush: () => Promise<void>): () => void {
      progressFlushes.add(flush);
      return () => { progressFlushes.delete(flush); };
    },
  };
}

export function isReaderWindow(label: string): boolean {
  return label.startsWith('reader-') || label.startsWith('moke-home-');
}

const boundary = createReaderSourceBoundary({
  getWindowLabels: async () => {
    if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') return [];
    const { getAllWindows } = await import('@tauri-apps/api/window');
    return (await getAllWindows()).map((win) => win.label);
  },
  getContext: async () => (await import('./store/server.ts')).useServerStore.getState(),
  open: async (args) => (await import('@tauri-apps/api/core')).invoke('open_reader', args),
  wait: () => new Promise((resolve) => setTimeout(resolve, 50)),
  now: () => Date.now(),
});
export const { bindReaderWindow, sourceForReaderEvent, retireReaderWindow, requireClosedReaders, withClosedReaderSession,
  openReaderFromSource, registerReaderProgressFlush } = boundary;
