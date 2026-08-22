'use client';

import { Suspense, useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { ArrowLeft, ChevronRight, Star, FileText, HardDrive, Calendar, BookOpen, Building2, Barcode, Tags, Users, LibraryBig, FileBadge2, Bookmark, Trash2 } from 'lucide-react';
import { requestAnimatedBack } from '@/lib/native-back';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { getErrorMessage, MokeApiError, readApiJson, request } from '@/lib/api';
import { deleteOfflineBook, getOfflineBook, removeOfflinePartial } from '@/lib/offline-books';
import {
  beginOfflineDownload,
  downloadAndSaveOfflineBook,
  endOfflineDownload,
} from '@/lib/offline-download';
import { useServerStore } from '@/lib/store/server';
import { useDeveloperStore } from '@/lib/store/developer';
import { useSettingsStore } from '@/lib/store/settings';
import { fetchReadingProgress } from '@/lib/reading-progress';
import { buildEmbeddedReaderUrl, getMokeRuntimePlatform, isSingleWebviewRuntime, openEmbeddedReaderBook } from '@/lib/moke-reader';
import { resolveServerAssetUrl } from '@/lib/utils';
import { AuthImage } from '@/components/ui/AuthImage';
import {
  bookDetailShelfState,
  bookSummaryText,
  readStateShelfState,
  shouldLoadReadingStateFallback,
} from '@/lib/book-detail-core';
import { openAndRecordBookRead, recordAndOpenBookRead, recordBookRead, READ_RECORD_NAV_TIMEOUT_MS } from '@/lib/book-read';
import {
  getOfflineDownloadSnapshot,
  removeOfflineDownloadSnapshot,
  startOfflineDownload,
  subscribeOfflineDownload,
} from '@/lib/offline-download-manager';
import { makeOfflineBookKey, shouldResumeOfflineDownload } from '@/lib/offline-book-core';
import { AnnotationPanel } from '@/components/annotations/AnnotationPanel';
import {
  annotationReaderProgress,
  beginAnnotationLocateNavigation,
  clearAnnotationLocateProgressSuppression,
  type BookAnnotation,
} from '@/lib/annotations';
import { shouldRequestBookAnnotations } from '@/lib/annotation-access';

interface BookDetail {
  id: string;
  title: string;
  authors?: string[] | Array<{ name: string }>;
  author?: string;
  author_sort?: string;
  img?: string;
  thumb?: string;
  rating?: number | { value: number; count: number };
  tags?: string[] | Array<{ name: string }>;
  publisher?: string;
  pubdate?: string;
  description?: string;
  comments?: string;
  files?: Array<{ format: string; size: number }>;
  isbn?: string;
  series?: string;
  language?: string;
  state?: {
    read_state?: number;
    online_read?: number;
    download?: number;
    wants?: boolean | number;
  };
}

function DetailContent() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id');
  const router = useRouter();
  const { serverUrl, capabilities, user } = useServerStore();
  const [book, setBook] = useState<BookDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [metaExpanded, setMetaExpanded] = useState(false);
  const [selectedFormat, setSelectedFormat] = useState('epub');
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloaded, setDownloaded] = useState(false);
  const [deletingDownload, setDeletingDownload] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [openingReader, setOpeningReader] = useState(false);
  const [inShelf, setInShelf] = useState(false);
  const [shelfUpdating, setShelfUpdating] = useState(false);
  const [message, setMessage] = useState('');
  const isTauriApp = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';
  // 请求序号 + abort：详情页 id 跳转（同一组件实例复用）或卸载时终止在途请求，
  // 防止 A 的慢响应把 B 的书显示在页面上。
  const loadBookSeqRef = useRef(0);
  const loadBookControllerRef = useRef<AbortController | null>(null);
  const openingReaderRef = useRef(false);
  const coverUrl = book ? resolveServerAssetUrl(serverUrl, book.img || book.thumb) : '';
  const authorNames = normalizeNames(book?.authors, book?.author);
  const tagNames = normalizeNames(book?.tags);
  const summary = bookSummaryText(book?.comments || book?.description);
  const downloadKey = serverUrl && id ? makeOfflineBookKey(serverUrl, id, selectedFormat) : '';
  const primaryFile = book?.files?.[0];
  const fileFormats = Array.from(new Set(
    book?.files?.map((file) => file.format.toUpperCase()).filter(Boolean) ?? [],
  ));
  const ratingValue = typeof book?.rating === 'number' ? book.rating : book?.rating?.value;
  const handleAnnotationAuthRequired = useCallback(() => router.push('/login'), [router]);

  useEffect(() => {
    if (!id) return;
    // id 变化时 abort 上一本在途请求，避免旧详情覆盖新详情。
    loadBookControllerRef.current?.abort();
    const controller = new AbortController();
    loadBookControllerRef.current = controller;
    loadBook(controller);
    return () => {
      controller.abort();
      if (loadBookControllerRef.current === controller) loadBookControllerRef.current = null;
    };
  }, [id]);

  useEffect(() => {
    let cancelled = false;

    const checkOffline = async () => {
      try {
        const record = await getOfflineBook(serverUrl, id!, selectedFormat);
        if (!cancelled) {
          setDownloaded(Boolean(record));
        }
      } catch {
        if (!cancelled) {
          setDownloaded(false);
        }
      }
    };

    if (serverUrl && id) {
      checkOffline();
    }

    return () => {
      cancelled = true;
    };
  }, [id, selectedFormat, serverUrl]);

  useEffect(() => {
    if (!downloadKey) return;
    const applySnapshot = (snapshot: ReturnType<typeof getOfflineDownloadSnapshot>) => {
      if (!snapshot) return;
      setDownloading(snapshot.status === 'downloading');
      setDownloadProgress(snapshot.progress);
      if (snapshot.status === 'completed') setDownloaded(true);
    };
    applySnapshot(getOfflineDownloadSnapshot(downloadKey));
    return subscribeOfflineDownload(downloadKey, applySnapshot);
  }, [downloadKey]);

  const loadBook = async (controller: AbortController) => {
    const seq = ++loadBookSeqRef.current;
    setLoading(true);
    try {
      const res = await request(`${serverUrl}/api/book/${id}`, { credentials: 'include', signal: controller.signal });
      const data = await readApiJson<{ err?: string; msg?: string; book?: BookDetail; data?: BookDetail }>(res, '书籍详情解析失败。', ['ok', 'user.need_login']);
      if (data.err === 'user.need_login') {
        router.push('/login');
        return;
      }
      if (controller.signal.aborted || seq !== loadBookSeqRef.current) return;
      const nextBook = data.book || data.data;
      if (data.err === 'ok' && nextBook) {
        setBook(nextBook);
        const detailShelfState = bookDetailShelfState(nextBook);
        setInShelf(detailShelfState ?? false);
        const format = (nextBook?.files?.[0]?.format || 'epub').toLowerCase();
        setSelectedFormat(format);
        // 游客不访问需要登录的 readstate 接口。仅对已登录用户兼容旧版
        // Talebook 未在详情响应中携带书架状态的情况。
        if (shouldLoadReadingStateFallback(detailShelfState, Boolean(user))) {
          loadReadingState(nextBook?.id || String(id), seq);
        }
      } else {
        throw new Error(data.msg || '书籍详情加载失败。');
      }
    } catch (error) {
      if (controller.signal.aborted || seq !== loadBookSeqRef.current) return;
      setBook(null);
      if (error instanceof MokeApiError && error.code === 'user.need_login') {
        router.push('/login');
        return;
      }
      setMessage(getErrorMessage(error, '书籍详情加载失败，请检查服务器连接。'));
    } finally {
      if (!controller.signal.aborted && seq === loadBookSeqRef.current) setLoading(false);
    }
  };

  const loadReadingState = async (bookId: string | number, seq: number) => {
    try {
      const res = await request(`${serverUrl}/api/book/${bookId}/readstate`, {
        credentials: 'include',
      });
      const data = await readApiJson<{ err?: string; msg?: string; wants?: boolean | number }>(
        res,
        '阅读状态解析失败。',
        ['ok', 'user.need_login'],
      );
      if (seq !== loadBookSeqRef.current) return;
      const shelfState = readStateShelfState(data);
      if (shelfState !== undefined) setInShelf(shelfState);
    } catch (error) {
      console.warn('Failed to load reading state:', error);
    }
  };

  const updateReadingState = async (payload: { read_state?: number; online_read?: number; download?: number }) => {
    if (!book) return;

    try {
      await request(`${serverUrl}/api/book/${book.id}/readstate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
    } catch (error) {
      console.warn('Failed to update reading state:', error);
    }
  };

  const toggleShelf = async () => {
    if (!book || shelfUpdating) return;

    const nextInShelf = !inShelf;
    setShelfUpdating(true);
    setMessage('');

    try {
      const res = await request(`${serverUrl}/api/book/${book.id}/shelf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ shelf: nextInShelf }),
      });
      const data = await res.json();

      if (data.err === 'user.need_login') {
        router.push('/login');
        return;
      }

      if (data.err !== 'ok') {
        setMessage(data.msg || '书架状态更新失败。');
        return;
      }

      setInShelf(nextInShelf);
      setBook((current) => current ? {
        ...current,
        state: { ...current.state, wants: nextInShelf },
      } : current);
      setMessage(nextInShelf ? '已加入书籍。' : '已移出书籍。');
    } catch {
      setMessage('书架状态更新失败，请检查服务器连接后重试。');
    } finally {
      setShelfUpdating(false);
    }
  };

  const handleDownload = async () => {
    if (!book || downloading) return;
    setDownloading(true);
    setDownloadProgress(0);
    setMessage('');

    try {
      const canResume = shouldResumeOfflineDownload(process.env.NEXT_PUBLIC_APP_PLATFORM);
      await startOfflineDownload({
        key: makeOfflineBookKey(serverUrl, String(book.id), selectedFormat),
        metadata: {
          serverUrl,
          bookId: String(book.id),
          title: book.title,
          format: selectedFormat,
          downloadedBytes: canResume ? undefined : 0,
        },
        run: async (onProgress, signal, onTransfer) => {
          if (!beginOfflineDownload(serverUrl, String(book.id), selectedFormat)) {
            throw new Error('book.download.in_progress');
          }
          try {
            await downloadAndSaveOfflineBook({
              serverUrl,
              bookId: String(book.id),
              title: book.title,
              format: selectedFormat,
              onProgress,
              onTransfer,
              signal,
              resume: canResume,
              preservePartialOnFailure: true,
            });
          } finally {
            endOfflineDownload(serverUrl, String(book.id), selectedFormat);
          }
        },
        onCancel: () => removeOfflinePartial({
          serverUrl,
          bookId: String(book.id),
          title: book.title,
          format: selectedFormat,
          downloadDirectory: useSettingsStore.getState().downloadDirectory,
        }),
      });

      const finalStatus = getOfflineDownloadSnapshot(makeOfflineBookKey(serverUrl, String(book.id), selectedFormat))?.status;
      if (finalStatus !== 'completed') throw new Error(`book.download.${finalStatus || 'interrupted'}`);
      setDownloadProgress(100);
      void updateReadingState({ download: 1 });
      // 等待下一个版本更新后加入read_state: 1
      setDownloaded(true);
      setBook((current) => current ? {
        ...current,
        state: { ...current.state, read_state: 1 },
      } : current);
      setMessage('已下载到本地，现在可以阅读。');
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      if (reason === 'book.download.in_progress') {
        setMessage('该书籍正在下载中，请稍候。');
      } else if (reason === 'book.download.paused') {
        setMessage('下载已暂停，可在下载管理中继续。');
      } else if (reason === 'book.download.cancelled') {
        setMessage('下载已取消。');
      } else if (reason.startsWith('http.')) {
        setMessage(`下载失败，服务器返回 ${reason.replace('http.', '')}。`);
      } else if (reason === 'book.epub.invalid') {
        setMessage('下载失败：服务端返回的 EPUB 文件不完整或格式错误，请重新上传该书。');
      } else if (reason === 'book.download.transfer_failed') {
        setMessage('下载失败：接收文件内容时连接中断，请重试。');
      } else if (reason === 'book.download.storage_failed' || reason === 'Failed to save book to file system') {
        setMessage('下载失败：无法保存到本地，请检查存储空间或权限。');
      } else if (!isTauriApp) {
        setMessage('下载失败：当前浏览器模式下可能被跨域策略拦截。桌面版会走 Tauri 原生下载通道。');
      } else {
        setMessage('下载失败，请检查服务器连接或登录状态后重试。');
      }
      setDownloadProgress(0);
    } finally {
      setDownloading(false);
    }
  };

  const handleOfflineRead = async (targetAnnotation?: BookAnnotation) => {
    if (!book) return;
    // 打开/记录在途时拦截重复点击：按钮只在阅读器窗口已打开后恢复可点，
    // 记录请求仍在途，此时放行会造成重复打开窗口和重复计数。
    if (openingReaderRef.current) {
      setMessage('正在打开书籍，请稍候。');
      return;
    }

    openingReaderRef.current = true;
    setOpeningReader(true);
    setMessage('');
    let annotationNavigationId: string | undefined;

    const finishOpening = () => {
      openingReaderRef.current = false;
      setOpeningReader(false);
    };

    try {
      const record = await getOfflineBook(serverUrl, id!, selectedFormat);
      if (record?.filePath && process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri') {
        // 通过统一的 open_reader 命令打开阅读器：阅读器作为打包资源随应用一起
        // 发布（合为一个应用），并在自己的独立窗口中打开书籍。后续更换阅读器
        // 只需替换打包资源，无需改动这里的调用方式。
        let restoreProgress = targetAnnotation
          ? annotationReaderProgress(targetAnnotation, book.id)
          : await fetchReadingProgress(book.id);
        if (targetAnnotation && restoreProgress) {
          annotationNavigationId = beginAnnotationLocateNavigation(serverUrl, book.id);
          restoreProgress = {
            ...restoreProgress,
            moke_navigation_id: annotationNavigationId,
            moke_navigation_kind: 'annotation-locate',
          };
        }
        const currentPlatform = await getMokeRuntimePlatform();

        if (isSingleWebviewRuntime(currentPlatform)) {
          const href = buildEmbeddedReaderUrl({
            filePath: record.filePath,
            eink: useSettingsStore.getState().eink,
            debugPanel: useDeveloperStore.getState().showDebugPanel,
            mokeBookId: String(book.id),
            restoreProgress,
            // The explicit navigation id lets the reader skip only startup and
            // annotation relocations; genuine page turns still sync directly.
            serverUrl: useServerStore.getState().serverUrl,
          });

          // Navigation replaces this WebView and destroys the current JS
          // context, so dispatch and await the bounded record request first.
          // Use a short timeout: the record is best-effort and must not hold
          // up opening the reader for long.
          await recordAndOpenBookRead({
            record: () => recordBookRead(request, serverUrl, book.id, READ_RECORD_NAV_TIMEOUT_MS),
            open: () => openEmbeddedReaderBook(href, router.push, currentPlatform),
            onRecordError: (error) => {
              console.warn('Read record could not be saved before navigation:', error);
            },
          });
          return;
        }

        await openAndRecordBookRead({
          open: async () => {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('open_reader', {
              filePath: record.filePath,
              eink: useSettingsStore.getState().eink,
              debugPanel: useDeveloperStore.getState().showDebugPanel,
              mokeBookId: String(book.id),
              restoreProgress,
            });
          },
          // The independent reader window is open now, so unlock the button
          // right away; the re-entry ref stays held until the record settles
          // so a second click cannot duplicate the open or the count.
          onOpened: () => setOpeningReader(false),
          record: () => recordBookRead(request, serverUrl, book.id),
          onRecordError: (error) => {
            console.warn('Reader opened, but the read record could not be saved:', error);
            setMessage('书籍已打开，但阅读记录同步失败。');
          },
        });
      } else {
        setMessage('无法打开书籍：未找到本地文件或当前环境不支持。');
      }
    } catch (e) {
      if (annotationNavigationId) clearAnnotationLocateProgressSuppression(annotationNavigationId);
      console.error('Failed to open book:', e);
      setMessage(targetAnnotation ? '打开书籍或定位笔记失败，请重试。' : '打开书籍失败。');
    } finally {
      finishOpening();
    }
  };

  const handleDeleteDownload = async () => {
    if (!book || deletingDownload) return;

    setDeletingDownload(true);
    setMessage('');

    try {
      const result = await deleteOfflineBook(serverUrl, String(book.id), selectedFormat);
      await removeOfflineDownloadSnapshot(makeOfflineBookKey(serverUrl, String(book.id), selectedFormat));
      setDownloaded(false);
      setDownloadProgress(0);
      setShowDeleteConfirm(false);
      setMessage(result.remoteSynced
        ? '已删除下载书籍。'
        : '本地文件已删除；服务器状态同步失败，可在下载管理中重试。');
    } catch {
      setMessage('删除下载书籍失败。');
    } finally {
      setDeletingDownload(false);
    }
  };

  if (loading) {
    return (
      <DesktopLayout>
        <div className="flex items-center justify-center px-4 py-16 sm:px-8">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
        </div>
      </DesktopLayout>
    );
  }

  if (!book) {
    return (
      <DesktopLayout>
        <div className="px-4 py-16 text-center text-muted-foreground sm:px-8">{message || '书籍未找到'}</div>
      </DesktopLayout>
    );
  }

  return (
    <DesktopLayout>
      <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6 md:px-8 md:py-8">
        <div className="mb-6 rounded-[24px] app-card px-4 py-4 sm:mb-8 sm:rounded-[28px] sm:px-5">
          <button onClick={() => requestAnimatedBack()} className="inline-flex items-center gap-1.5 text-sm mb-2 text-muted-foreground transition-colors hover:text-foreground group">
            <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
            <span>返回</span>
          </button>
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">书架</span>
            <ChevronRight className="w-3 h-3 text-muted-foreground/60" />
            <span className="text-foreground font-medium truncate max-w-[300px]">{book.title}</span>
          </div>
        </div>

        <div className="flex flex-col gap-6 md:flex-row md:gap-10">
          <div className="mx-auto flex w-full max-w-[260px] shrink-0 flex-col items-stretch md:mx-0 md:w-[240px] md:items-start">
            <div className="w-full overflow-hidden rounded-[24px] border border-amber-950/10 bg-white book-cover-shadow transition-transform duration-300 hover:scale-[1.02] md:w-[220px]">
              <div className="aspect-[2/3] flex items-center justify-center bg-muted/60 relative group">
                {coverUrl ? (
                  <AuthImage
                    src={coverUrl}
                    alt={book.title}
                    className="w-full h-full object-cover"
                    fallback={<BookOpen className="w-16 h-16 text-muted-foreground/40" />}
                  />
                ) : (
                  <BookOpen className="w-16 h-16 text-muted-foreground/40" />
                )}
              </div>
            </div>

            {isTauriApp ? (
              <>
                <button
                  onClick={() => void (downloaded ? handleOfflineRead() : handleDownload())}
                  disabled={downloading || openingReader}
                  className={`relative mt-5 inline-flex h-11 w-full items-center justify-center overflow-hidden rounded-xl text-sm font-semibold shadow-md transition-all duration-200 active:scale-[0.98] hover:shadow-lg disabled:opacity-100 md:mt-6 md:w-[220px] ${downloading ? 'border border-primary/15 bg-primary/15 text-primary-foreground' : 'bg-primary text-primary-foreground hover:bg-primary/90'}`}
                >
                  {downloading && <span className="absolute inset-0 bg-primary/15" />}
                  {downloading && (
                    <span
                      className="absolute inset-y-0 left-0 bg-primary transition-[width] duration-150 ease-out"
                      style={{ width: `${downloadProgress}%` }}
                    />
                  )}
                  <span className="relative z-10 flex items-center justify-center gap-2 text-primary-foreground">
                    {downloaded && <BookOpen className="w-4 h-4" />}
                    {downloading ? `下载中 ${downloadProgress}%` : openingReader ? '打开中' : downloaded ? '阅读' : '下载'}
                  </span>
                </button>
                {book.files && book.files.length > 1 && !downloaded && (
                  <div className="mt-3 w-full md:w-[220px]">
                    <div className="flex flex-wrap gap-1.5">
                      {book.files.map((f) => {
                        const fmt = f.format.toLowerCase();
                        const isActive = selectedFormat === fmt;
                        return (
                          <button
                            key={fmt}
                            onClick={() => setSelectedFormat(fmt)}
                            className={`h-7 px-2.5 rounded-lg text-xs font-medium transition-all border ${
                              isActive
                                ? 'bg-primary/10 border-primary/30 text-primary'
                                : 'bg-muted/50 border-border/40 text-muted-foreground hover:border-border'
                            }`}
                          >
                            {fmt.toUpperCase()}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="mt-5 flex h-11 w-full items-center justify-center rounded-xl border border-border/60 bg-muted/40 px-3 text-center text-xs leading-snug text-muted-foreground md:mt-6 md:w-[220px]">
                离线下载与离线阅读仅支持桌面版
              </div>
            )}
            <button
              onClick={toggleShelf}
              disabled={shelfUpdating}
              className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-amber-950/10 bg-white/60 text-sm font-semibold text-foreground transition-all duration-200 hover:bg-muted active:scale-[0.98] disabled:opacity-60 md:w-[220px]"
            >
              <Bookmark className="w-4 h-4" fill={inShelf ? 'currentColor' : 'none'} />
              {shelfUpdating ? '更新中' : inShelf ? '移出书架' : '加入书架'}
            </button>
            {downloaded && (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                disabled={deletingDownload}
                className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 text-sm font-semibold text-destructive transition-all duration-200 hover:bg-destructive/15 active:scale-[0.98] disabled:opacity-60 md:w-[220px]"
              >
                <Trash2 className="w-4 h-4" />
                {deletingDownload ? '删除中' : '删除下载书籍'}
              </button>
            )}
            {message && <p className="mt-3 w-full px-1 text-xs leading-relaxed text-muted-foreground md:w-[220px]">{message}</p>}
          </div>

          <div className="min-w-0 flex-1 rounded-[28px] app-glass px-5 pb-6 pt-5 sm:rounded-[32px] sm:px-7 sm:pb-7 sm:pt-6">
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">{book.title}</h1>

            <p className="text-base mt-1 text-muted-foreground font-medium">
              {authorNames.join(' · ') || '未知作者'}
            </p>

            {typeof ratingValue === 'number' && ratingValue > 0 && (
              <div className="flex items-center gap-2 mt-2 bg-amber-500/10 border border-amber-500/20 w-fit px-3 py-1 rounded-xl">
                <div className="flex gap-0.5">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star key={i} className="w-4 h-4" fill={i < Math.round(ratingValue) ? '#F59E0B' : 'none'} color={i < Math.round(ratingValue) ? '#F59E0B' : '#D1D5DB'} />
                  ))}
                </div>
                <span className="text-xs font-bold text-amber-600 dark:text-amber-400 ml-0.5">{ratingValue}</span>
              </div>
            )}

            <div className="my-2 border-t border-border/40" />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-4 text-sm">
              <MetaRow icon={Users} label="作者" text={authorNames.join(' · ')} />
              <MetaRow icon={Building2} label="出版社" text={book.publisher} />
            </div>

            {(book.isbn || book.series || book.language || fileFormats.length > 0 || primaryFile?.size || book.pubdate) && (
              <>
                {!metaExpanded && (
                  <button
                    onClick={() => setMetaExpanded(true)}
                    className="inline-flex items-center gap-1 mt-2 text-xs font-medium text-primary hover:underline transition-all"
                  >
                    <span>展开更多出版信息</span>
                    <ChevronRight className="w-3.5 h-3.5 rotate-90" />
                  </button>
                )}

                {metaExpanded && (
                  <div className="mt-2 pt-2 border-t border-dashed border-border/40">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-4 text-sm">
                      <MetaRow icon={Barcode} label="ISBN" text={book.isbn} />
                      <MetaRow icon={LibraryBig} label="丛书" text={book.series} />
                      <MetaRow icon={Calendar} label="出版时间" text={book.pubdate} />
                      <MetaRow icon={FileBadge2} label="语言" text={book.language} />
                      {fileFormats.length > 0 && <MetaRow icon={FileText} label="格式" text={fileFormats.join(' / ')} />}
                      {primaryFile?.size ? <MetaRow icon={HardDrive} label="大小" text={formatFileSize(primaryFile.size)} /> : null}
                    </div>
                    <button
                      onClick={() => setMetaExpanded(false)}
                      className="inline-flex items-center gap-1 mt-3 text-xs font-medium text-muted-foreground hover:text-foreground transition-all"
                    >
                      <span>收起扩展信息</span>
                      <ChevronRight className="w-3.5 h-3.5 -rotate-90" />
                    </button>
                  </div>
                )}
              </>
            )}

            {tagNames.length > 0 && (
              <>
                <div className="my-4 border-t border-border/40" />
                <div>
                  <div className="flex items-center gap-2 mb-2 text-sm font-semibold text-foreground">
                    <Tags className="w-4 h-4 text-primary" />
                    <span>标签</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {tagNames.map((tag, index) => (
                      <span key={`${tag}-${index}`} className="inline-flex items-center justify-center px-3 py-1 text-xs font-medium rounded-xl bg-muted/80 border border-border/40 text-foreground/90 hover:bg-muted transition-colors">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              </>
            )}

            {summary && (
              <>
                <div className="my-4 border-t border-border/40" />
                <div>
                  <div className="flex items-center gap-2 mb-2 text-sm font-semibold text-foreground">
                    <BookOpen className="w-4 h-4 text-primary" />
                    <span>简介</span>
                  </div>
                  <p className={expanded ? 'text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap' : 'text-sm text-foreground/90 leading-relaxed line-clamp-6 whitespace-pre-wrap'}>
                    {summary}
                  </p>
                  {summary.length > 200 && (
                    <button onClick={() => setExpanded(!expanded)} className="text-xs font-medium mt-2 text-primary hover:underline transition-all">
                      {expanded ? '收起简介' : '查看完整简介'}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {shouldRequestBookAnnotations(Boolean(user)) && (
          <AnnotationPanel
            key={String(book.id)}
            bookId={String(book.id)}
            serverUrl={serverUrl}
            capabilityStatus={capabilities.annotationApiStatus}
            capabilityCheckedAt={capabilities.annotationApiCheckedAt}
            downloaded={downloaded}
            openingReader={openingReader}
            onLocate={handleOfflineRead}
            onAuthRequired={handleAnnotationAuthRequired}
          />
        )}
      </div>

      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-3xl border border-border bg-card p-6 shadow-xl">
            <div className="flex items-center gap-3 text-destructive">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-destructive/10">
                <Trash2 className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">确认删除下载书籍？</h2>
                <p className="mt-1 text-xs text-muted-foreground">删除后需要重新下载才能离线阅读。</p>
              </div>
            </div>


            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deletingDownload}
                className="h-10 flex-1 rounded-xl border border-amber-950/10 bg-white/60 text-sm font-medium text-foreground transition hover:bg-muted disabled:opacity-60"
              >
                取消
              </button>
              <button
                onClick={handleDeleteDownload}
                disabled={deletingDownload}
                className="h-10 flex-1 rounded-xl bg-destructive text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:opacity-60"
              >
                {deletingDownload ? '删除中' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </DesktopLayout>
  );
}

function MetaRow({ icon: Icon, label, text }: { icon: React.ElementType; label: string; text?: string | null }) {
  if (!text) return null;

  return (
    <div className="flex items-start gap-3 px-2 py-1 rounded-xl hover:bg-muted/40 transition-colors">
      <div className="p-1.5 rounded-lg bg-background border border-border/40 text-muted-foreground shrink-0 mt-0.5">
        <Icon className="w-3.5 h-3.5" />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-medium text-foreground break-words mt-0.5">{text}</p>
      </div>
    </div>
  );
}

function normalizeNames(items?: string[] | Array<{ name: string }>, fallback?: string) {
  if (Array.isArray(items)) {
    return items
      .map((item) => typeof item === 'string' ? item : item?.name)
      .filter((item): item is string => Boolean(item));
  }

  if (fallback) {
    return fallback.split(/\s*[·,，/]\s*/).filter(Boolean);
  }

  return [];
}

function formatFileSize(size: number) {
  if (size >= 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  if (size >= 1024) {
    return `${Math.round(size / 1024)} KB`;
  }

  return `${size} B`;
}

export default function DetailPage() {
  return (
    <Suspense fallback={
      <DesktopLayout>
        <div className="flex items-center justify-center px-4 py-16 sm:px-8">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
        </div>
      </DesktopLayout>
    }>
      <DetailContent />
    </Suspense>
  );
}
