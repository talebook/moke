'use client';

import { Suspense, useState, useEffect } from 'react';
import { useServerStore } from '@/lib/store/server';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Search, Grid3X3, List } from 'lucide-react';
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

function SearchContent() {
  const searchParams = useSearchParams();
  const { serverUrl } = useServerStore();
  const [query, setQuery] = useState(searchParams.get('q') || '');
  const [results, setResults] = useState<BookItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [activeFilter, setActiveFilter] = useState('全部');
  const [viewGrid, setViewGrid] = useState(true);

  useEffect(() => {
    const q = searchParams.get('q');
    if (q) {
      setQuery(q);
      handleSearch(q);
    }
  }, [searchParams]);

  const handleSearch = async (q?: string) => {
    const term = (q || query).trim();
    if (!term) return;
    setLoading(true);
    setSearched(true);
    try {
      const res = await request(`${serverUrl}/api/search?name=${encodeURIComponent(term)}`, { credentials: 'include' });
      const data = await res.json();
      if (data.err === 'ok') setResults(data.books || data.items || []);
    } finally { setLoading(false); }
  };

  return (
    <DesktopLayout>
      <div className="px-8 py-8 h-full overflow-y-auto" style={{ maxWidth: '1400px' }}>
        <div className="mb-6">
          <p className="text-xs font-medium text-primary/80">探索书库</p>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">搜索</h1>
        </div>
        <div className="flex items-center gap-3 mb-8 rounded-[28px] app-card p-3">
          <div className="relative flex-1 max-w-xl">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
            <input type="text" placeholder="搜索书名、作者、标签..."
              value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }}
              className="w-full h-12 pl-11 pr-4 rounded-2xl bg-white/70 border border-amber-950/10 shadow-sm text-foreground text-base outline-none transition-colors focus:border-primary focus:bg-background" />
          </div>
          <button onClick={() => handleSearch()} disabled={loading || !query.trim()}
            className="h-11 px-6 rounded-2xl bg-primary shadow-lg shadow-primary/15 text-primary-foreground text-sm font-semibold transition hover:opacity-90 disabled:opacity-50">
            {loading ? '搜索中...' : '搜索'}
          </button>
        </div>

        <div className="flex items-center gap-3 mb-6 justify-between rounded-3xl app-card px-4 py-3">
          <div className="flex gap-3">
            {['全部', 'EPUB', 'PDF', 'MOBI', 'TXT'].map((f) => (
              <button key={f} onClick={() => setActiveFilter(f)}
                className={`text-xs px-3 py-1.5 rounded-2xl border transition-colors ${activeFilter === f ? 'border-foreground text-foreground bg-muted' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                {f}
              </button>
            ))}
          </div>
          
          <div className="flex items-center rounded-lg p-1 shrink-0 bg-muted border border-border">
            <button onClick={() => setViewGrid(true)} className={cn('flex items-center justify-center w-7 h-7 rounded-md transition-all', viewGrid ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              <Grid3X3 className="w-4 h-4" />
            </button>
            <button onClick={() => setViewGrid(false)} className={cn('flex items-center justify-center w-7 h-7 rounded-md transition-all', !viewGrid ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
          </div>
        ) : searched && results.length === 0 ? (
          <div className="rounded-[32px] app-glass px-8 py-16 text-center text-muted-foreground">
            <p className="text-lg font-semibold text-foreground">未找到相关书籍</p>
            <p className="text-sm mt-2">尝试使用不同的关键词搜索</p>
          </div>
        ) : results.length > 0 ? (
          <div>
            <p className="text-sm text-muted-foreground mb-5">找到 {results.length} 本书</p>
            <div className={cn('rounded-[30px] app-card p-4 gap-x-4 gap-y-7', viewGrid ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6' : 'grid grid-cols-1 lg:grid-cols-2 gap-4')}>
              {results.map((book) => {
                const bookId = String(book.id);
                const coverUrl = resolveServerAssetUrl(serverUrl, book.img || book.thumb);
                const authorName = book.author || book.authors?.[0]?.name || '';

                if (viewGrid) {
                  return (
                    <Link key={bookId} href={`/detail?id=${bookId}`} className="group flex flex-col gap-3 rounded-[22px] p-2.5 transition-all duration-300 hover:bg-white/65 hover:shadow-[0_18px_45px_-30px_rgba(74,57,35,0.65)]">
                      <div className="relative w-full overflow-hidden rounded-[18px] bg-white book-cover-shadow ring-1 ring-black/5 transition-all duration-300 ease-out group-hover:-translate-y-1.5"
                        style={{ aspectRatio: '2/3' }}>
                        {coverUrl ? (
                          <AuthImage
                            src={coverUrl}
                            alt={book.title}
                            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                            loading="lazy"
                            fallback={
                              <div className="w-full h-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center">
                                <span className="text-foreground/25 text-xl font-bold font-serif">{book.title[0]}</span>
                              </div>
                            }
                          />
                        ) : (
                          <div className="w-full h-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center">
                            <span className="text-foreground/25 text-xl font-bold font-serif">{book.title[0]}</span>
                          </div>
                        )}
                        <div className="absolute inset-x-0 top-0 h-1/3 bg-gradient-to-b from-white/18 to-transparent opacity-80" />
                        <div className="absolute inset-y-0 left-0 w-[10%] bg-gradient-to-r from-black/18 via-black/4 to-transparent mix-blend-multiply" />
                      </div>
                      <div className="flex flex-col gap-0.5 px-0.5">
                        <span className="text-sm font-medium truncate text-foreground">{book.title}</span>
                        {authorName && <span className="text-xs truncate text-muted-foreground">{authorName}</span>}
                      </div>
                    </Link>
                  );
                }

                return (
                  <Link key={bookId} href={`/detail?id=${bookId}`}
                    className="flex items-center gap-4 px-4 py-3 rounded-2xl transition-all hover:bg-white/70 border border-transparent hover:border-amber-950/10 hover:shadow-sm">
                    <div className="w-10 h-[60px] rounded overflow-hidden shadow-card shrink-0 flex items-center justify-center relative">
                      {coverUrl ? (
                        <AuthImage
                          src={coverUrl}
                          alt={book.title}
                          className="w-full h-full object-cover"
                          loading="lazy"
                          fallback={
                            <div className="w-full h-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center">
                              <span className="text-foreground/30 text-xs font-bold font-serif">{book.title[0]}</span>
                            </div>
                          }
                        />
                      ) : (
                        <div className="w-full h-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center">
                          <span className="text-foreground/30 text-xs font-bold font-serif">{book.title[0]}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate text-foreground">{book.title}</p>
                      {authorName && <p className="text-xs text-muted-foreground truncate">{authorName}</p>}
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </DesktopLayout>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={
      <DesktopLayout>
        <div className="px-8 py-16 flex items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
        </div>
      </DesktopLayout>
    }>
      <SearchContent />
    </Suspense>
  );
}
