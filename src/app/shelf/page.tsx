'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { useServerStore } from '@/lib/store/server';
import { useRouter } from 'next/navigation';
import { BookOpen, History, Search } from 'lucide-react';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { request } from '@/lib/api';
import { cn, resolveServerAssetUrl } from '@/lib/utils';
import { AuthImage } from '@/components/ui/AuthImage';

interface BookItem {
  id: string | number;
  title: string;
  authors?: Array<{ name: string }>;
  author?: string;
  img?: string;
  thumb?: string;
}

function BookCard({ book, viewGrid = true }: { book: BookItem; viewGrid?: boolean }) {
  const { serverUrl } = useServerStore();
  const authorName = book.author || book.authors?.[0]?.name || '';
  const bookId = String(book.id);
  const coverUrl = resolveServerAssetUrl(serverUrl, book.img || book.thumb);
  const colors = [
    'from-emerald-800/20 via-teal-700/15 to-cyan-700/20',
    'from-amber-700/20 via-yellow-600/15 to-orange-700/20',
    'from-slate-700/20 via-gray-600/15 to-zinc-700/20',
    'from-rose-700/20 via-red-600/15 to-pink-700/20',
    'from-indigo-700/20 via-blue-600/15 to-purple-700/20',
  ];
  const ci = Math.abs(bookId.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % colors.length;

  if (viewGrid) {
    return (
      <Link href={`/detail?id=${bookId}`}
        className="group flex flex-col gap-3 cursor-pointer rounded-[22px] p-2.5 transition-all duration-300 hover:bg-white/65 hover:shadow-[0_18px_45px_-30px_rgba(74,57,35,0.65)]"
      >
        <div className="relative w-full overflow-hidden rounded-[18px] bg-white book-cover-shadow ring-1 ring-black/5 transition-all duration-300 ease-out group-hover:-translate-y-1.5"
          style={{ aspectRatio: '2/3' }}>
          {coverUrl ? (
            <AuthImage
              src={coverUrl}
              alt={book.title}
              className="w-full h-full object-cover transition-transform duration-500 ease-out group-hover:scale-105"
              loading="lazy"
              fallback={
                <div className={cn('w-full h-full flex items-center justify-center bg-gradient-to-br transition-transform duration-500 ease-out group-hover:scale-105', colors[ci])}>
                  <span className="text-white/75 text-lg font-bold font-serif px-3 text-center leading-tight drop-shadow-sm">
                    {book.title.length > 4 ? book.title.slice(0, 4) : book.title}
                  </span>
                </div>
              }
            />
          ) : (
            <div className={cn('w-full h-full flex items-center justify-center bg-gradient-to-br transition-transform duration-500 ease-out group-hover:scale-105', colors[ci])}>
              <span className="text-white/75 text-lg font-bold font-serif px-3 text-center leading-tight drop-shadow-sm">
                {book.title.length > 4 ? book.title.slice(0, 4) : book.title}
              </span>
            </div>
          )}
          <div className="absolute inset-x-0 top-0 h-1/3 bg-gradient-to-b from-white/18 to-transparent opacity-80" />
          <div className="absolute inset-y-0 left-0 w-[10%] bg-gradient-to-r from-black/18 via-black/4 to-transparent mix-blend-multiply" />
          <div className="absolute inset-0 bg-black/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
        </div>
        <div className="flex flex-col gap-1 px-1">
          <span className="text-[13px] font-semibold leading-snug truncate text-foreground group-hover:text-primary transition-colors duration-200">{book.title}</span>
          {authorName && <span className="text-[11px] truncate text-muted-foreground/85">{authorName}</span>}
        </div>
      </Link>
    );
  }

  return (
      <Link href={`/detail?id=${bookId}`}
      className="flex items-center gap-4 px-4 py-3 rounded-2xl transition-all duration-200 hover:bg-muted/70 border border-transparent hover:border-border/60 hover:shadow-xs group">
      <div className="w-10 h-[60px] rounded-lg overflow-hidden shadow-sm shrink-0 flex items-center justify-center relative transition-transform duration-300 group-hover:scale-[1.03]">
        {coverUrl ? (
          <AuthImage
            src={coverUrl}
            alt={book.title}
            className="w-full h-full object-cover"
            loading="lazy"
            fallback={
              <div className={cn('w-full h-full flex items-center justify-center bg-gradient-to-br', colors[ci])}>
                <span className="text-white/70 text-xs font-bold font-serif px-1 text-center leading-tight">
                  {book.title.length > 2 ? book.title.slice(0, 2) : book.title}
                </span>
              </div>
            }
          />
        ) : (
          <div className={cn('w-full h-full flex items-center justify-center bg-gradient-to-br', colors[ci])}>
            <span className="text-white/70 text-xs font-bold font-serif px-1 text-center leading-tight">
              {book.title.length > 2 ? book.title.slice(0, 2) : book.title}
            </span>
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold truncate text-foreground group-hover:text-primary transition-colors duration-200">{book.title}</p>
        {authorName && <p className="text-xs text-muted-foreground truncate">{authorName}</p>}
      </div>
      <span className="text-[11px] font-semibold text-muted-foreground shrink-0 px-2 py-0.5 bg-muted rounded-md border border-border/30">
        {(book as any).files?.[0]?.format?.toUpperCase() || 'EPUB'}
      </span>
    </Link>
  );
}

export default function ShelfPage() {
  const { serverUrl } = useServerStore();
  const router = useRouter();
  const [books, setBooks] = useState<BookItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [requiresLogin, setRequiresLogin] = useState(false);
  const viewMode = 'grid';

  useEffect(() => {
    loadBooks();
  }, [serverUrl]);

  const loadBooks = async () => {
    setLoading(true);
    setRequiresLogin(false);
    try {
      const res = await request(`${serverUrl}/api/shelf`, { credentials: 'include' });
      const data = await res.json();

      if (data.err === 'user.need_login') {
        setBooks([]);
        setRequiresLogin(true);
        return;
      }

      setBooks(data.books || []);
    } catch {} finally { setLoading(false); }
  };

  return (
    <DesktopLayout>
      <div className="flex min-h-screen flex-col bg-[radial-gradient(circle_at_top_left,rgba(184,149,106,0.18),transparent_32%),linear-gradient(180deg,#fffdf8_0%,#fbf9f2_44%,#f6f0e6_100%)]">
        <header className="sticky top-0 z-10 shrink-0 border-b border-amber-950/10 bg-[#fffdf8]/80 px-8 py-5 backdrop-blur-xl">
          <div className="flex items-center justify-between gap-6">
            <div>
              <div className="mb-1 flex items-center gap-2 text-xs font-medium text-primary/80">
                <BookOpen className="h-3.5 w-3.5" />
                <span>{books.length > 0 ? `${books.length} 本藏书` : '私人阅读空间'}</span>
              </div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">我的书架</h1>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative shrink-0 w-[320px]">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  placeholder="搜索我的书..."
                  onKeyDown={(e) => { if (e.key === 'Enter') router.push(`/search?q=${encodeURIComponent((e.target as HTMLInputElement).value)}`); }}
                  className="w-full h-10 pl-10 pr-3 text-sm rounded-2xl border border-amber-950/10 bg-white/70 text-foreground shadow-sm outline-none transition focus:border-primary/60 focus:bg-white focus:shadow-[0_8px_24px_-18px_rgba(74,57,35,0.55)]"
                />
              </div>
              <Link
                href="/user/history"
                aria-label="查看历史记录"
                title="查看历史记录"
                className="shrink-0 flex items-center justify-center w-10 h-10 rounded-2xl border border-amber-950/10 bg-white/70 text-muted-foreground shadow-sm transition hover:text-foreground hover:bg-white hover:shadow-[0_8px_24px_-18px_rgba(74,57,35,0.55)]"
              >
                <History className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto no-scrollbar">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
            </div>
          ) : books.length === 0 ? (
            <div className="flex min-h-[520px] items-center justify-center px-8 py-24 text-center">
              <div className="relative w-full max-w-md overflow-hidden rounded-[32px] border border-amber-950/10 bg-white/65 px-8 py-12 shadow-[0_24px_70px_-45px_rgba(74,57,35,0.65)] backdrop-blur">
                <div className="absolute -right-16 -top-16 h-40 w-40 rounded-full bg-primary/10 blur-2xl" />
                <div className="relative mx-auto mb-6 flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-primary/15 to-amber-200/40 text-primary shadow-inner">
                  <Search className="w-10 h-10" />
                </div>
                <p className="relative text-lg font-semibold mb-2 text-foreground">{requiresLogin ? '登录后查看你的书架' : '书架还是空的'}</p>
                <p className="relative text-sm leading-6 max-w-xs mx-auto text-muted-foreground">
                  {requiresLogin ? '当前服务器已连接，但书架状态属于个人数据，请先登录后查看书架。' : '去书库挑几本书，开始你的阅读之旅。'}
                </p>
              </div>
            </div>
          ) : (
            <div className="px-8 py-8">
              <div className={cn('gap-x-4 gap-y-7 rounded-[30px] border border-amber-950/10 bg-white/35 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] backdrop-blur-sm', viewMode === 'grid' ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6' : 'grid grid-cols-1 lg:grid-cols-2')}>
                {books.map((book) => (
                  <BookCard key={String(book.id)} book={book} viewGrid={viewMode === 'grid'} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </DesktopLayout>
  );
}

