'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { ArrowLeft, ChevronRight, Star, FileText, HardDrive, Calendar, BookOpen, Building2, Barcode, Tags, Users, LibraryBig, FileBadge2 } from 'lucide-react';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { downloadBookBlob, request } from '@/lib/api';
import { getOfflineBook, saveOfflineBook } from '@/lib/offline-books';
import { useServerStore } from '@/lib/store/server';
import { resolveServerAssetUrl } from '@/lib/utils';

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
  };
}

function DetailContent() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id');
  const router = useRouter();
  const { serverUrl } = useServerStore();
  const [book, setBook] = useState<BookDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [metaExpanded, setMetaExpanded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloaded, setDownloaded] = useState(false);
  const [message, setMessage] = useState('');
  const coverUrl = book ? resolveServerAssetUrl(serverUrl, book.img || book.thumb) : '';
  const authorNames = normalizeNames(book?.authors, book?.author);
  const tagNames = normalizeNames(book?.tags);
  const summary = (book?.comments || book?.description || '').trim();
  const primaryFile = book?.files?.[0];
  const ratingValue = typeof book?.rating === 'number' ? book.rating : book?.rating?.value;

  useEffect(() => {
    if (id) loadBook();
  }, [id]);

  useEffect(() => {
    let cancelled = false;

    const checkOffline = async () => {
      try {
        const record = await getOfflineBook(serverUrl, id!);
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
  }, [id, serverUrl]);

  const loadBook = async () => {
    setLoading(true);
    try {
      const res = await request(`${serverUrl}/api/book/${id}`, { credentials: 'include' });
      const data = await res.json();
      if (data.err === 'ok') setBook(data.book || data.data);
    } catch {} finally { setLoading(false); }
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
    } catch {}
  };

  const handleDownload = async () => {
    if (!book || downloading) return;

    setDownloading(true);
    setDownloadProgress(0);
    setMessage('');

    try {
      const blob = await downloadBookBlob(book.id, 'epub', {
        onProgress: (progress) => {
          setDownloadProgress(progress);
        },
      });
      await saveOfflineBook({
        serverUrl,
        bookId: String(book.id),
        title: book.title,
        fileName: `${book.title}.epub`,
        mimeType: blob.type || 'application/epub+zip',
        blob,
      });

      setDownloadProgress(100);
      await updateReadingState({ download: 1, online_read: 1 });
      setDownloaded(true);
      setBook((current) => current ? {
        ...current,
        state: { ...current.state, download: 1, online_read: 1 },
      } : current);
      setMessage('已下载到本地，现在可以阅读。');
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      if (reason.startsWith('http.')) {
        setMessage(`下载失败，服务器返回 ${reason.replace('http.', '')}。`);
      } else if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') {
        setMessage('下载失败：当前浏览器模式下可能被跨域策略拦截。桌面版会走 Tauri 原生下载通道。');
      } else {
        setMessage('下载失败，请检查服务器连接或登录状态后重试。');
      }
      setDownloadProgress(0);
    } finally {
      setDownloading(false);
    }
  };

  const handleOfflineRead = async () => {
    if (!book) return;

    try {
      const record = await getOfflineBook(serverUrl, id!);
      if (record?.filePath && process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri') {
        const { openPath } = await import('@tauri-apps/plugin-opener');
        await openPath(record.filePath);
      } else {
        setMessage('无法打开书籍：未找到本地文件或当前环境不支持。');
      }
    } catch (e) {
      console.error('Failed to open book:', e);
      setMessage('打开书籍失败。');
    }
  };

  if (loading) {
    return (
      <DesktopLayout>
        <div className="px-8 py-16 flex items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
        </div>
      </DesktopLayout>
    );
  }

  if (!book) {
    return (
      <DesktopLayout>
        <div className="px-8 py-16 text-center text-muted-foreground">书籍未找到</div>
      </DesktopLayout>
    );
  }

  return (
    <DesktopLayout>
      <div className="px-8 py-8">
        <div className="mb-8">
          <button onClick={() => router.back()} className="inline-flex items-center gap-1.5 text-sm mb-2 text-muted-foreground transition-colors hover:text-foreground group">
            <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
            <span>返回</span>
          </button>
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">书架</span>
            <ChevronRight className="w-3 h-3 text-muted-foreground/60" />
            <span className="text-foreground font-medium truncate max-w-[300px]">{book.title}</span>
          </div>
        </div>

        <div className="flex gap-10">
          <div className="shrink-0 w-[240px] flex flex-col items-start">
            <div className="w-[220px] rounded-2xl overflow-hidden shadow-xl border border-border/40 transition-transform duration-300 hover:scale-[1.02]">
              <div className="aspect-[2/3] flex items-center justify-center bg-muted/60 relative group">
                {coverUrl ? (
                  <img src={coverUrl} alt={book.title} className="w-full h-full object-cover" />
                ) : (
                  <BookOpen className="w-16 h-16 text-muted-foreground/40" />
                )}
              </div>
            </div>

            <button
              onClick={downloaded ? handleOfflineRead : handleDownload}
              disabled={downloading}
              className={`relative overflow-hidden w-[220px] h-11 rounded-xl font-semibold text-sm mt-6 inline-flex items-center justify-center shadow-md transition-all duration-200 active:scale-[0.98] hover:shadow-lg disabled:opacity-100 ${downloading ? 'border border-primary/15 bg-primary/15 text-primary-foreground' : 'bg-primary text-primary-foreground hover:bg-primary/90'}`}
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
                {downloading ? `下载中 ${downloadProgress}%` : downloaded ? '阅读' : '下载'}
              </span>
            </button>
            {message && <p className="mt-3 w-[220px] text-xs text-muted-foreground leading-relaxed px-1">{message}</p>}
          </div>

          <div className="flex-1 min-w-0 bg-card/40 border border-border/60 rounded-3xl px-6 pt-5 pb-6 shadow-sm">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">{book.title}</h1>

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

            {(book.isbn || book.series || book.language || primaryFile?.format || primaryFile?.size || book.pubdate) && (
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
                      {primaryFile?.format && <MetaRow icon={FileText} label="格式" text={primaryFile.format.toUpperCase()} />}
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
      </div>
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
        <div className="px-8 py-16 flex items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
        </div>
      </DesktopLayout>
    }>
      <DetailContent />
    </Suspense>
  );
}
