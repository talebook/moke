export interface ReaderSource { serverUrl: string; bookId: string; sessionId: number }

export function assertReaderContext(source: ReaderSource, current: { sessionId: number; candidate: unknown }): void {
  if (source.sessionId !== current.sessionId || current.candidate) {
    throw new Error('连接或登录状态已改变，请返回书籍页面重试');
  }
}
const windows = new Map<string, ReaderSource>();
let readerOpening = false;
const opening = new Map<string, ReaderSource>();
const progressFlushes = new Set<() => Promise<void>>();
export function registerReaderProgressFlush(flush: () => Promise<void>): () => void {
  progressFlushes.add(flush);
  return () => { progressFlushes.delete(flush); };
}

export function registerOpeningReader(source: ReaderSource): () => void {
  opening.set(source.bookId, source);
  return () => { if (opening.get(source.bookId) === source) opening.delete(source.bookId); };
}

/** The window label comes from the host's IPC caller, never from publication data. */
export function sourceForReaderEvent(windowLabel: string, bookId: string): ReaderSource | null {
  const known = windows.get(windowLabel);
  if (known) return known.bookId === bookId ? known : null;
  const source = opening.get(bookId);
  if (!source || !/^reader-\d+$/.test(windowLabel)) return null;
  windows.set(windowLabel, source);
  return source;
}

export function bindReaderWindow(windowLabel: string, source: ReaderSource): void {
  windows.set(windowLabel, source);
}

export function isReaderWindow(label: string): boolean {
  return label.startsWith('reader-') || label.startsWith('moke-home-');
}

/** Reader UI owns closing and flushing. A failed check leaves the active server untouched. */
export async function requireClosedReaders(): Promise<void> {
  if (readerOpening) throw new Error('阅读器正在打开，请稍候再试。当前连接已保留。');
  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') return;
  const { getAllWindows } = await import('@tauri-apps/api/window');
  if ((await getAllWindows()).some((win) => isReaderWindow(win.label))) {
    throw new Error('请先关闭当前阅读器及阅读器书库窗口，再重试连接。当前连接已保留。');
  }
  await Promise.all([...progressFlushes].map((flush) => flush()));
}

export async function openReaderFromSource(
  source: ReaderSource,
  args: Record<string, unknown>,
): Promise<void> {
  if (readerOpening) throw new Error('阅读器正在打开，请稍候再试');
  readerOpening = true;
  // No window with another origin may share a book-id-only opening receipt.
  let cancel = () => {};
  try {
    const { useServerStore } = await import('./store/server.ts');
    const { getAllWindows } = await import('@tauri-apps/api/window');
    const before = new Set((await getAllWindows()).map((win) => win.label));
    assertReaderContext(source, useServerStore.getState());
    cancel = registerOpeningReader(source);
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_reader', args);
    // Readest schedules window construction on its UI thread and the command
    // receipt precedes creation. Verify the actual new window, not just IPC success.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const created = (await getAllWindows()).find((win) => /^reader-\d+$/.test(win.label) && !before.has(win.label));
      if (created) { bindReaderWindow(created.label, source); return; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('阅读器窗口未创建，请重试');
  } finally { cancel(); readerOpening = false; }
}
