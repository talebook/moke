'use client';

import { useEffect, useRef, useState } from 'react';
import { request } from '@/lib/api';
import { COMIC_FORMAT_MESSAGE, COMIC_OFFLINE_MESSAGE, supportsComicPages, type ReaderBook } from '@/lib/book-reader-policy';
import { comicErrorMessage, comicProgress, ComicProgressWriter, createComicApi, restoreComicPage, type ComicProgress } from '@/lib/comic-api';
import { bindComicImages, comicPlaceholder } from '@/lib/comic-images';
import { APP_BACK_EVENT } from '@/lib/native-back';
import { useSettingsStore } from '@/lib/store/settings';

interface ReaderInstance { destroy(): void }
interface ReaderOptions {
  manifest: { id: string; title: string; pages: { id: string; src: string; width: number; height: number }[] };
  initialProgress: { pageIndex: number };
  config: { animations: boolean; preload: number };
  onProgress: (progress: { pageIndex: number }) => void;
  onExit: () => void;
  onError: () => void;
}
type ReaderConstructor = new (host: HTMLElement, options: ReaderOptions) => ReaderInstance;
declare global { interface Window { KomgaReader?: { Reader: ReaderConstructor } } }

let modulePromise: Promise<ReaderConstructor> | undefined;
function loadReader(): Promise<ReaderConstructor> {
  if (window.KomgaReader) return Promise.resolve(window.KomgaReader.Reader);
  modulePromise ??= new Promise<ReaderConstructor>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/komga-reader/komga-reader.umd.js';
    const fail = () => { clearTimeout(timer); script.remove(); reject(new Error('comic.module')); };
    const timer = setTimeout(fail, 15_000);
    script.onload = () => { clearTimeout(timer); if (window.KomgaReader) resolve(window.KomgaReader.Reader); else fail(); };
    script.onerror = fail;
    document.head.append(script);
  }).catch(error => { modulePromise = undefined; throw error; });
  return modulePromise;
}

export function ComicReader({ book, serverUrl, offline, onClose }: {
  book: ReaderBook & { id: string; title: string };
  serverUrl: string;
  offline: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const localProgress = useRef<ComicProgress | undefined>(undefined);
  const host = useRef<HTMLDivElement>(null);
  const close = useRef<() => void>(onClose);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [leaving, setLeaving] = useState(false);
  const [canLeave, setCanLeave] = useState(false);
  const eink = useSettingsStore(state => state.eink);

  useEffect(() => {
    const controller = new AbortController();
    let reader: ReaderInstance | undefined;
    let disposeImages: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let writer: ComicProgressWriter | undefined;
    let exiting = false;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    setLoading(true); setError(''); setNotice(''); setCanLeave(false);
    const active = () => !controller.signal.aborted;
    const flush = () => writer?.flush().then(() => { if (active()) setNotice(current => current.startsWith('阅读进度') ? '' : current); }).catch(() => {
      if (active()) setNotice('阅读进度尚未保存，请检查连接后重试。');
    });
    close.current = () => {
      if (exiting) return;
      exiting = true;
      clearTimeout(timer);
      setLeaving(true);
      void (writer?.flush() ?? Promise.resolve()).then(onClose).catch(() => {
        exiting = false; setLeaving(false); setCanLeave(true);
        setNotice('阅读进度保存失败。可重试保存，或选择不保存退出。');
      });
    };
    const onBack = (event: Event) => { event.stopImmediatePropagation(); close.current(); };
    window.addEventListener(APP_BACK_EVENT, onBack, true);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close.current(); }
      if (event.key !== 'Tab') return;
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select, input, [tabindex="0"]') ?? [])]
        .filter(element => element.getClientRects().length > 0);
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    const onVisibility = () => { if (document.visibilityState === 'hidden') void flush(); };
    document.addEventListener('visibilitychange', onVisibility);
    const start = async () => {
      if (offline) { setError(COMIC_OFFLINE_MESSAGE); setLoading(false); return; }
      if (!supportsComicPages(book)) { setError(COMIC_FORMAT_MESSAGE); setLoading(false); return; }
      try {
        const api = createComicApi(request, serverUrl, String(book.id), controller.signal);
        const [Reader, manifest, progress] = await Promise.all([loadReader(), api.manifest(), api.progress()]);
        if (!active() || !host.current) return;
        writer = new ComicProgressWriter(api.save);
        reader = new Reader(host.current, {
          manifest: { id: manifest.id, title: manifest.title, pages: manifest.pages.map(page => ({
            ...page, src: comicPlaceholder(page.index),
          })) },
          initialProgress: { pageIndex: restoreComicPage(manifest, localProgress.current ?? progress) },
          config: { animations: !eink, preload: 1 },
          onProgress: ({ pageIndex }) => {
            localProgress.current = comicProgress(manifest, pageIndex);
            writer!.queue(localProgress.current);
            clearTimeout(timer);
            timer = setTimeout(() => void flush(), 350);
          },
          onExit: () => close.current(),
          onError: () => { setLoading(false); setNotice('漫画页面无法显示，请重试加载。'); },
        });
        disposeImages = bindComicImages(host.current, index => api.page(manifest, index),
          e => { setLoading(false); setNotice(comicErrorMessage(e)); },
          () => setLoading(false));
      } catch (e) { if (active()) { setError(comicErrorMessage(e)); setLoading(false); } }
    };
    void start();
    return () => {
      controller.abort();
      clearTimeout(timer);
      disposeImages?.(); reader?.destroy();
      window.removeEventListener(APP_BACK_EVENT, onBack, true);
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('visibilitychange', onVisibility);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [book, serverUrl, offline, attempt, onClose, eink]);

  return <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`漫画阅读：${book.title}`} className="moke-comic-reader">
    {/* Pinned third-party CSS is shipped with the standalone reader. */}
    {/* eslint-disable-next-line @next/next/no-css-tags */}
    <link rel="stylesheet" href="/vendor/komga-reader/style.css" />
    <div ref={host} className="moke-comic-host" />
    {(loading || error) && <div className="moke-comic-state" role={error ? 'alert' : 'status'}>
      <h2>{error ? '无法打开漫画' : '正在加载漫画…'}</h2>
      {error && <p>{error}</p>}
      <div><button onClick={() => close.current()}>返回书籍详情</button>
        {!offline && supportsComicPages(book) && error && <button onClick={() => setAttempt(value => value + 1)}>重试</button>}</div>
    </div>}
    {notice && <aside className="moke-comic-notice" role="status"><p>{notice}</p>
      <button disabled={leaving} onClick={() => close.current()}>保存并返回</button>
      <button onClick={() => setAttempt(value => value + 1)}>重新加载</button>
      {canLeave && <button onClick={onClose}>不保存退出</button>}
    </aside>}
    {leaving && <div className="moke-comic-state" role="status">正在保存阅读进度…</div>}
  </section>;
}
