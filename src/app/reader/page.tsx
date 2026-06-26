'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getOfflineBook } from '@/lib/offline-books';
import { useServerStore } from '@/lib/store/server';

function ReaderContent() {
  const searchParams = useSearchParams();
  const { serverTitle, serverUrl } = useServerStore();
  const ids = searchParams.get('ids') || '';
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [bookTitle, setBookTitle] = useState('离线阅读');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let viewElement: HTMLElement | null = null;

    const loadBook = async () => {
      if (!ids) {
        setLoading(false);
        setError('未指定书籍');
        return;
      }

      try {
        setLoading(true);
        setError('');

        const [record] = await Promise.all([
          getOfflineBook(serverUrl, ids),
          import('foliate-js/view.js'),
        ]);

        if (!record) {
          throw new Error('not-downloaded');
        }

        if (cancelled || !containerRef.current) {
          return;
        }

        setBookTitle(record.title || '离线阅读');
        containerRef.current.innerHTML = '';
        viewElement = document.createElement('foliate-view');
        viewElement.className = 'block h-full w-full';
        containerRef.current.append(viewElement);
        await (viewElement as HTMLElement & { open: (input: Blob) => Promise<void> }).open(record.blob);
      } catch (err) {
        if (cancelled) return;
        const reason = err instanceof Error ? err.message : '';
        setError(reason === 'not-downloaded' ? '请先在详情页下载这本书，再进行离线阅读。' : '离线书籍打开失败，请重新下载后再试。');
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadBook();

    return () => {
      cancelled = true;
      if (containerRef.current) {
        containerRef.current.innerHTML = '';
      }
    };
  }, [ids, serverUrl]);

  if (!ids) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <p className="text-muted-foreground">未指定书籍</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex items-center justify-between h-14 px-4 bg-muted border-b border-border shrink-0">
        <button
          onClick={() => window.history.back()}
          className="inline-flex items-center gap-1.5 rounded px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>返回</span>
        </button>
        <div className="min-w-0 text-center">
          <p className="text-sm font-medium text-foreground truncate">{bookTitle}</p>
          <p className="text-xs text-muted-foreground truncate">{serverTitle || '墨客'} 离线阅读</p>
        </div>
        <div className="w-14" />
      </header>

      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <p>打开离线书籍中...</p>
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center">
            <div className="max-w-md px-8 text-center">
              <p className="text-base font-medium text-foreground">{error}</p>
              <button
                onClick={() => window.history.back()}
                className="mt-4 inline-flex h-11 items-center justify-center rounded-[10px] bg-primary px-5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
              >
                返回详情页
              </button>
            </div>
          </div>
        ) : (
          <div ref={containerRef} className="h-full w-full bg-background" />
        )}
      </div>
    </div>
  );
}

export default function ReaderPage() {
  return (
    <Suspense fallback={
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
      </div>
    }>
      <ReaderContent />
    </Suspense>
  );
}
