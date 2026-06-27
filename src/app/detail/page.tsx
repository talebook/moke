'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { ArrowLeft, ChevronRight, Star, FileText, HardDrive, Calendar, BookOpen } from 'lucide-react';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { downloadBookBlob, request } from '@/lib/api';
import { getOfflineBook, saveOfflineBook } from '@/lib/offline-books';
import { useServerStore } from '@/lib/store/server';
import { resolveServerAssetUrl } from '@/lib/utils';

interface BookDetail {
  id: string;
  title: string;
  authors?: Array<{ name: string }>;
  author?: string;
  img?: string;
  thumb?: string;
  rating?: { value: number; count: number };
  tags?: Array<{ name: string }>;
  publisher?: string;
  pubdate?: string;
  description?: string;
  files?: Array<{ format: string; size: number }>;
}

function DetailContent() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id');
  const router = useRouter();
  const { serverUrl } = useServerStore();
  const [book, setBook] = useState<BookDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [message, setMessage] = useState('');
  const coverUrl = book ? resolveServerAssetUrl(serverUrl, book.img || book.thumb) : '';

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

  const handleDownload = async () => {
    if (!book || downloading) return;

    setDownloading(true);
    setMessage('');

    try {
      const blob = await downloadBookBlob(book.id, 'epub');
      await saveOfflineBook({
        serverUrl,
        bookId: String(book.id),
        title: book.title,
        fileName: `${book.title}.epub`,
        mimeType: blob.type || 'application/epub+zip',
        blob,
      });

      setDownloaded(true);
      setMessage('已下载到本地，现在可以离线阅读。');
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      if (reason.startsWith('http.')) {
        setMessage(`下载失败，服务器返回 ${reason.replace('http.', '')}。`);
      } else if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') {
        setMessage('下载失败：当前浏览器模式下可能被跨域策略拦截。桌面版会走 Tauri 原生下载通道。');
      } else {
        setMessage('下载失败，请检查服务器连接或登录状态后重试。');
      }
    } finally {
      setDownloading(false);
    }
  };

  const handleOfflineRead = () => {
    router.push(`/reader?ids=${encodeURIComponent(String(book?.id || ''))}`);
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
          <button onClick={() => router.back()} className="inline-flex items-center gap-1.5 text-sm mb-2 text-muted-foreground transition-opacity hover:opacity-75">
            <ArrowLeft className="w-4 h-4" />
            <span>返回</span>
          </button>
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">书架</span>
            <ChevronRight className="w-3 h-3 text-muted-foreground" />
            <span className="text-foreground">{book.title}</span>
          </div>
        </div>

        <div className="flex gap-10">
          <div className="shrink-0 w-[320px] flex flex-col items-start">
            <div className="w-[240px] rounded-xl overflow-hidden shadow-card">
              <div className="aspect-[2/3] flex items-center justify-center bg-muted">
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
              className="w-[240px] h-11 rounded-lg font-medium text-sm mt-4 inline-flex items-center justify-center bg-primary text-primary-foreground transition-opacity hover:opacity-90"
            >
              {downloading ? '下载中...' : downloaded ? '离线阅读' : '下载'}
            </button>
            {message && <p className="mt-3 w-[240px] text-sm text-muted-foreground">{message}</p>}
          </div>

          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{book.title}</h1>

            <p className="text-base mt-1.5 text-muted-foreground">
              {book.author || book.authors?.map((a) => a.name).join(' · ') || '未知作者'}
            </p>

            {book.rating && (
              <div className="flex items-center gap-1.5 mt-3">
                <div className="flex gap-0.5">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star key={i} className="w-4 h-4" fill={i < Math.round(book.rating!.value) ? '#B8956A' : 'none'} color={i < Math.round(book.rating!.value) ? '#B8956A' : '#E8E3DC'} />
                  ))}
                </div>
                <span className="text-sm ml-1 text-muted-foreground">{book.rating.value}</span>
              </div>
            )}

            <div className="my-5 border-t border-border" />

            <div className="flex flex-wrap items-center gap-5 text-sm">
              {book.files?.[0] && (
                <>
                  <MetaItem icon={FileText} text={book.files[0].format.toUpperCase()} />
                  <MetaItem icon={HardDrive} text={`${(book.files[0].size / 1024 / 1024).toFixed(1)} MB`} />
                </>
              )}
              {book.pubdate && <MetaItem icon={Calendar} text={book.pubdate} />}
            </div>

            <div className="my-5 border-t border-border" />

            {book.tags && book.tags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {book.tags.map((t, index) => (
                  <span key={`${t.name}-${index}`} className="inline-flex items-center justify-center px-2.5 py-1 text-xs rounded-sm bg-muted text-foreground">
                    {t.name}
                  </span>
                ))}
              </div>
            )}

            <div className="my-5 border-t border-border" />

            {book.description && (
              <div>
                <p className={expanded ? 'text-sm text-foreground leading-relaxed' : 'text-sm text-foreground leading-relaxed line-clamp-4'}>
                  {book.description}
                </p>
                {book.description.length > 200 && (
                  <button onClick={() => setExpanded(!expanded)} className="text-sm mt-2 text-muted-foreground transition-opacity hover:opacity-75">
                    {expanded ? '收起' : '展开全部'}
                  </button>
                )}
              </div>
            )}

            <div className="my-6 border-t border-border" />
          </div>
        </div>
      </div>
    </DesktopLayout>
  );
}

function MetaItem({ icon: Icon, text }: { icon: React.ElementType; text: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon className="w-4 h-4 text-muted-foreground" />
      <span className="text-foreground">{text}</span>
    </div>
  );
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