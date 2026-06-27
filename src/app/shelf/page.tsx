'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { useServerStore } from '@/lib/store/server';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { request } from '@/lib/api';
import { cn, resolveServerAssetUrl } from '@/lib/utils';

interface BookItem {
  id: string | number;
  title: string;
  authors?: Array<{ name: string }>;
  author?: string;
  img?: string;
  thumb?: string;
}

function BookCard({ book }: { book: BookItem }) {
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

  return (
    <Link
      href={`/detail/${bookId}`}
      className="group flex flex-col gap-2.5 cursor-pointer"
    >
      <div className="relative w-full overflow-hidden rounded-[14px] transition-transform duration-150 ease-out group-hover:-translate-y-0.5 shadow-card"
        style={{ aspectRatio: '2/3' }}>
        {coverUrl ? (
          <img src={coverUrl} alt={book.title} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className={cn('w-full h-full flex items-center justify-center bg-gradient-to-br', colors[ci])}>
            <span className="text-white/70 text-lg font-bold font-serif px-3 text-center leading-tight">
              {book.title.length > 4 ? book.title.slice(0, 4) : book.title}
            </span>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-0.5 px-0.5">
        <span className="text-[13px] font-medium truncate text-foreground">{book.title}</span>
        {authorName && <span className="text-[11px] truncate text-muted-foreground">{authorName}</span>}
      </div>
    </Link>
  );
}

export default function ShelfPage() {
  const { serverUrl } = useServerStore();
  const router = useRouter();
  const [reading, setReading] = useState<BookItem[]>([]);
  const [toread, setToread] = useState<BookItem[]>([]);
  const [finished, setFinished] = useState<BookItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [requiresLogin, setRequiresLogin] = useState(false);

  useEffect(() => {
    loadBooks();
  }, [serverUrl]);

  const loadBooks = async () => {
    setLoading(true);
    setRequiresLogin(false);
    try {
      const [readingRes, wantsRes, finishedRes] = await Promise.all([
        request(`${serverUrl}/api/reading`, { credentials: 'include' }),
        request(`${serverUrl}/api/wants`, { credentials: 'include' }),
        request(`${serverUrl}/api/read-done`, { credentials: 'include' }),
      ]);

      const [readingData, wantsData, finishedData] = await Promise.all([
        readingRes.json(),
        wantsRes.json(),
        finishedRes.json(),
      ]);

      if (
        readingData.err === 'user.need_login' ||
        wantsData.err === 'user.need_login' ||
        finishedData.err === 'user.need_login'
      ) {
        setReading([]);
        setToread([]);
        setFinished([]);
        setRequiresLogin(true);
        return;
      }

      setReading(readingData.books || []);
      setToread(wantsData.books || []);
      setFinished(finishedData.books || []);
    } catch {} finally { setLoading(false); }
  };

  return (
    <DesktopLayout>
      <header className="flex items-center justify-between px-8 h-16 shrink-0 border-b border-border">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">我的书架</h1>
        <div className="flex items-center gap-4">
          <div className="relative shrink-0 w-[280px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              placeholder="搜索我的书..."
              onKeyDown={(e) => { if (e.key === 'Enter') router.push(`/search?q=${encodeURIComponent((e.target as HTMLInputElement).value)}`); }}
              className="w-full h-9 pl-9 pr-3 text-sm rounded-xl border border-transparent bg-muted text-foreground outline-none transition-colors focus:border-primary focus:bg-background"
            />
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto no-scrollbar">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
          </div>
        ) : reading.length === 0 && toread.length === 0 && finished.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-8 py-24 text-center">
            <div className="w-24 h-24 mb-6 rounded-full bg-muted flex items-center justify-center">
              <Search className="w-10 h-10 text-muted-foreground" />
            </div>
            <p className="text-base font-medium mb-2 text-foreground">{requiresLogin ? '登录后查看你的书架' : '书架还是空的'}</p>
            <p className="text-sm mb-8 max-w-xs text-muted-foreground">
              {requiresLogin ? '当前服务器已连接，但书架状态属于个人数据，请先登录后查看在读、待读和已读完书籍。' : '去书库挑几本书，开始你的阅读之旅。'}
            </p>
          </div>
        ) : (
          <>
            {reading.length > 0 && (
              <Section title="阅读中" count={reading.length} books={reading} bg />
            )}
            {toread.length > 0 && (
              <Section title="待读" count={toread.length} books={toread} />
            )}
            {finished.length > 0 && (
              <Section title="已读完" count={finished.length} books={finished} />
            )}
          </>
        )}
      </div>
    </DesktopLayout>
  );
}

function Section({ title, count, books, bg }: { title: string; count: number; books: BookItem[]; bg?: boolean }) {
  return (
    <section className={`px-8 pt-7 pb-6 ${bg ? 'bg-muted' : ''}`}>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
        <span className="text-xs text-muted-foreground">{count} 本</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 gap-x-4 gap-y-6">
        {books.map((book) => (
          <BookCard key={String(book.id)} book={book} />
        ))}
      </div>
    </section>
  );
}
