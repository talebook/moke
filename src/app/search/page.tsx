'use client';

import { Suspense, useState, useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { useServerStore } from '@/lib/store/server';
import { resolveServerAssetUrl } from '@/lib/utils';

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
      const res = await fetch(`${serverUrl}/api/search?name=${encodeURIComponent(term)}`, { credentials: 'include' });
      const data = await res.json();
      if (data.err === 'ok') setResults(data.books || data.items || []);
    } finally { setLoading(false); }
  };

  return (
    <DesktopLayout>
      <div className="px-8 py-8" style={{ maxWidth: '1400px' }}>
        <div className="flex items-center gap-3 mb-8">
          <div className="relative flex-1 max-w-xl">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
            <input type="text" placeholder="搜索书名、作者、标签..."
              value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }}
              className="w-full h-12 pl-11 pr-4 rounded-xl bg-muted border border-transparent text-foreground text-base outline-none transition-colors focus:border-primary focus:bg-background" />
          </div>
          <button onClick={() => handleSearch()} disabled={loading || !query.trim()}
            className="h-11 px-6 rounded-[10px] bg-primary text-primary-foreground text-sm font-semibold transition hover:opacity-90 disabled:opacity-50">
            {loading ? '搜索中...' : '搜索'}
          </button>
        </div>

        <div className="flex items-center gap-3 mb-6">
          {['全部', 'EPUB', 'PDF', 'MOBI', 'TXT'].map((f) => (
            <button key={f} onClick={() => setActiveFilter(f)}
              className={`text-xs px-3 py-1.5 rounded-2xl border transition-colors ${activeFilter === f ? 'border-foreground text-foreground bg-muted' : 'border-border text-muted-foreground hover:text-foreground'}`}>
              {f}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
          </div>
        ) : searched && results.length === 0 ? (
          <div className="text-center py-20 text-muted-foreground">
            <p className="text-lg">未找到相关书籍</p>
            <p className="text-sm mt-2">尝试使用不同的关键词搜索</p>
          </div>
        ) : results.length > 0 ? (
          <div>
            <p className="text-sm text-muted-foreground mb-5">找到 {results.length} 本书</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
              {results.map((book) => {
                const bookId = String(book.id);
                const coverUrl = resolveServerAssetUrl(serverUrl, book.img || book.thumb);

                return (
                  <Link key={bookId} href={`/detail/${bookId}`} className="group flex flex-col gap-2.5">
                    <div className="relative w-full overflow-hidden rounded-[14px] transition-transform duration-150 ease-out group-hover:-translate-y-0.5 shadow-card"
                      style={{ aspectRatio: '2/3' }}>
                      {coverUrl ? (
                        <img src={coverUrl} alt={book.title} className="w-full h-full object-cover" loading="lazy" />
                      ) : (
                        <div className="w-full h-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center">
                          <span className="text-foreground/25 text-xl font-bold font-serif">{book.title[0]}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col gap-0.5 px-0.5">
                      <span className="text-sm font-medium truncate text-foreground">{book.title}</span>
                      <span className="text-xs truncate text-muted-foreground">{book.author || book.authors?.[0]?.name || ''}</span>
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
