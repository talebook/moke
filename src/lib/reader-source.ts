import { MokeApiError } from './api-core.ts';
import { runReaderProgressBestEffort } from './reader-progress-queue.ts';

export interface ReaderSource { serverUrl: string; bookId: string; sessionId: number }

/** Fence asynchronous preparation against connection, identity and mode changes.
 * Those transitions increment sessionId; a candidate also blocks dispatch.
 * Book/server ownership is carried separately by the immutable ReaderSource,
 * including downloaded books from a server other than the active connection.
 */
export function assertReaderSessionUnchanged(preparedSession: { sessionId: number }, current: { sessionId: number; candidate: unknown }): void {
  if (preparedSession.sessionId !== current.sessionId || current.candidate) {
    throw new MokeApiError('连接或登录状态已改变，请返回书籍页面重试', 'reader.context_changed');
  }
}

interface ReaderHost {
  getWindowLabels: () => Promise<string[]>;
  getContext: () => Promise<{ sessionId: number; candidate: unknown }>;
  open: (args: Record<string, unknown>) => Promise<unknown>;
  wait: (delayMs: number) => Promise<void>;
  now: () => number;
}

const UNRESOLVED_OPEN = '上次阅读器打开请求尚未确认，当前连接已保留。请等待窗口出现并关闭后重试；若一直未出现，请退出并重启应用。';
const AMBIGUOUS_OPEN = '检测到多个新阅读器窗口，无法确认本次打开请求的来源。当前连接已保留。请关闭阅读器并完全退出、重新启动应用后重试。';

/** Dispatch may succeed even when its receipt/creation cannot be observed. */
export class ReaderOpenUnconfirmedError extends MokeApiError {
  constructor(cause?: unknown, ambiguous = false) {
    super(ambiguous ? AMBIGUOUS_OPEN : UNRESOLVED_OPEN, 'reader.open_unconfirmed');
    this.cause = cause;
    this.name = 'ReaderOpenUnconfirmedError';
  }
}

/** One dispatched request retains ownership until its real window is observed.
 * Readest has no creation/cancellation receipt. A timeout or IPC failure cannot
 * prove that its queued UI task will not create a window later.
 */
export function createReaderSourceBoundary(host: ReaderHost) {
  const windows = new Map<string, ReaderSource>();
  const retired = new Set<string>();
  let readerOpening = false;
  let readerSessionChanging = false;
  let pending: { source: ReaderSource; before: Set<string>; label: string | null; ambiguous: boolean } | null = null;
  const progressFlushes = new Set<() => Promise<void>>();
  const runningFlushes = new WeakMap<() => Promise<void>, ReturnType<typeof runReaderProgressBestEffort>>();

  async function flushReaderProgress(): Promise<void> {
    await Promise.all([...progressFlushes].map((flush) => {
      const running = runningFlushes.get(flush);
      if (running) return running.complete;
      const attempt = runReaderProgressBestEffort(() => flush(), (reason) => {
        console.warn('[reader-progress] 阅读进度同步未完成，已继续处理连接与阅读器操作', { reason });
      });
      runningFlushes.set(flush, attempt);
      // A timed-out non-queue callback may ignore cancellation. Reuse only
      // that invocation; normal/recovered callbacks can flush future progress.
      void attempt.settled.then(() => {
        if (runningFlushes.get(flush) === attempt) runningFlushes.delete(flush);
      });
      return attempt.complete;
    }));
  }

  function bindReaderWindow(windowLabel: string, source: ReaderSource): void {
    // Readest labels are monotonic for this process. Never overwrite ownership.
    if (!windows.has(windowLabel) && !retired.has(windowLabel)) windows.set(windowLabel, Object.freeze({ ...source }));
  }

  function observeWindow(label: string): void {
    if (!pending || pending.ambiguous || pending.before.has(label) || retired.has(label) || !label.startsWith('reader-')) return;
    bindReaderWindow(label, pending.source);
    pending.label = label;
  }

  function reconcileWindows(labels: string[]): void {
    if (pending) {
      const request = pending;
      const created = labels.filter((label) => label.startsWith('reader-') && !request.before.has(label) && !retired.has(label));
      // Ambiguous observations cannot authorize a new request or a switch.
      // An empty later snapshot cannot prove that the dispatched IPC request
      // created either window, or that no queued creation is still outstanding.
      if (created.length > 1) {
        request.ambiguous = true;
        request.label = null;
        // Early events may have provisionally associated one label. Once the
        // snapshot is ambiguous, neither label may keep that authority.
        for (const label of created) windows.delete(label);
      }
      if (!request.ambiguous && created.length === 1 && (!request.label || request.label === created[0])) {
        observeWindow(created[0]);
        pending = null;
      }
    }
    for (const label of windows.keys()) {
      if (!labels.includes(label) && pending?.label !== label) retireReaderWindow(label);
    }
  }

  function retireReaderWindow(label: string): void {
    // Close events can lack a Moke book id (Reader-owned/library books). Only
    // an already associated label can settle a request; an unknown delayed
    // close cannot release a newer open.
    if (pending?.label === label && !pending.ambiguous) {
      pending = null;
    }
    windows.delete(label);
    if (label.startsWith('reader-')) retired.add(label);
  }

  function sourceForReaderEvent(windowLabel: string, bookId: string): ReaderSource | null {
    const known = windows.get(windowLabel);
    if (known) return known.bookId === bookId ? known : null;
    if (retired.has(windowLabel) || pending?.ambiguous || pending?.source.bookId !== bookId || pending.before.has(windowLabel)) return null;
    observeWindow(windowLabel);
    return windows.get(windowLabel) ?? null;
  }

  async function checkClosedReaders(): Promise<void> {
    const labels = await host.getWindowLabels();
    reconcileWindows(labels);
    if (pending) throw new ReaderOpenUnconfirmedError(undefined, pending.ambiguous);
    if (labels.some(isReaderWindow)) {
      throw new MokeApiError('请先关闭当前阅读器及阅读器书库窗口，再重试连接。当前连接已保留。', 'reader.windows_open');
    }
    await flushReaderProgress();
  }

  async function requireClosedReaders(): Promise<void> {
    if (readerOpening) throw new MokeApiError('阅读器正在打开，请稍候再试。当前连接已保留。', 'reader.opening');
    if (readerSessionChanging) throw new MokeApiError('正在变更登录状态，请稍候再试。当前连接已保留。', 'reader.session_changing');
    await checkClosedReaders();
  }

  async function withClosedReaderSession<T>(change: () => Promise<T>): Promise<T> {
    if (readerOpening || readerSessionChanging) throw new MokeApiError('阅读器或登录状态正在变更，请稍候再试', 'reader.busy');
    readerSessionChanging = true;
    try {
      await checkClosedReaders();
      return await change();
    } finally { readerSessionChanging = false; }
  }

  async function openReaderFromSource(source: ReaderSource, args: Record<string, unknown>): Promise<void> {
    if (readerOpening || readerSessionChanging) throw new MokeApiError('阅读器或登录状态正在变更，请稍候再试', 'reader.busy');
    readerOpening = true;
    try {
      const before = await host.getWindowLabels();
      reconcileWindows(before);
      if (pending) throw new ReaderOpenUnconfirmedError(undefined, pending.ambiguous);
      // Check under the opening reservation so another launch cannot race the
      // caller's earlier window snapshot.
      if (before.some(isReaderWindow)) throw new MokeApiError('请先关闭当前阅读器及阅读器书库窗口，再打开书籍', 'reader.windows_open');
      // Callers no longer run the connection guard first. Retain its progress
      // flush under this opening reservation, then check the latest session.
      await flushReaderProgress();
      assertReaderSessionUnchanged({ sessionId: source.sessionId }, await host.getContext());
      const request = { source: Object.freeze({ ...source }), before: new Set(before), label: null as string | null, ambiguous: false };
      pending = request;
      try {
        await host.open(args);
        const deadline = host.now() + 5000;
        let delayMs = 100;
        while (host.now() < deadline) {
          if (request.label && pending !== request) return;
          reconcileWindows(await host.getWindowLabels());
          if (request.label && pending !== request) return;
          await host.wait(Math.min(delayMs, deadline - host.now()));
          delayMs = Math.min(delayMs * 2, 1000);
        }
      } catch (error) {
        throw new ReaderOpenUnconfirmedError(error, request.ambiguous);
      }
      throw new ReaderOpenUnconfirmedError(undefined, request.ambiguous);
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
  // Session/open guard, not extension addressing: the Reader library home
  // retains the same source context and can create readers of its own. Keep
  // both closed before changing sessions or dispatching a new Moke book.
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
  wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  now: () => Date.now(),
});
export const { bindReaderWindow, sourceForReaderEvent, retireReaderWindow, requireClosedReaders, withClosedReaderSession,
  openReaderFromSource, registerReaderProgressFlush } = boundary;
