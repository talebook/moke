'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Grid3X3, List, ChevronDown } from 'lucide-react';
import { useServerStore } from '@/lib/store/server';
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
  files?: Array<{ format: string }>;
  timestamp?: number;
}

export default function LibraryPage() {
  const { serverUrl } = useServerStore();
  const router = useRouter();
  const [books, setBooks] = useState<BookItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'local' | 'online'>('local');
  const [viewGrid, setViewGrid] = useState(true);
  const [searchQ, setSearchQ] = useState('');

  const [currentPage, setCurrentPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 30;

  useEffect(() => {
    if (activeTab === 'local') loadBooks(currentPage);
  }, [serverUrl, activeTab, currentPage]);

  const loadBooks = async (page: number) => {
    setLoading(true);
    try {
      const start = (page - 1) * pageSize;
      const res = await request(`${serverUrl}/api/recent?start=${start}&size=${pageSize}`, { credentials: 'include' });
      const data = await res.json();
      if (data.err === 'user.need_login') { router.push('/login'); return; }
      setBooks(data.books || data.items || []);
      setTotal(data.total || 0);
    } catch {} finally { setLoading(false); }
  };

  const totalPages = Math.ceil(total / pageSize);

  const getPageNumbers = () => {
    const pages: (number | string)[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      if (currentPage <= 4) {
        pages.push(1, 2, 3, 4, 5, '...', totalPages);
      } else if (currentPage >= totalPages - 3) {
        pages.push(1, '...', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
      } else {
        pages.push(1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages);
      }
    }
    return pages;
  };

  const colors = [
    'bg-gradient-to-br from-slate-200 to-slate-300',
    'bg-gradient-to-br from-stone-200 to-stone-300',
    'bg-gradient-to-br from-zinc-200 to-zinc-300',
    'bg-gradient-to-br from-gray-200 to-gray-300',
    'bg-gradient-to-br from-neutral-200 to-neutral-300',
  ];

  return (
    <DesktopLayout>
      <header className="flex items-center gap-4 px-8 py-4 border-b border-border shrink-0">
        <h1 className="text-xl font-semibold shrink-0 text-foreground">全部藏书</h1>
        <div className="flex-1" />

        <div className="relative shrink-0 w-[320px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="搜索书名、作者或标签..."
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && searchQ.trim()) router.push(`/search?q=${encodeURIComponent(searchQ.trim())}`); }}
            className="w-full h-9 pl-9 pr-3 text-sm rounded-xl bg-muted border border-transparent text-foreground outline-none transition-colors focus:border-primary focus:bg-background"
          />
        </div>

        <div className="flex items-center rounded-lg p-1 shrink-0 bg-muted border border-border">
          <button onClick={() => setViewGrid(true)} className={cn('flex items-center justify-center w-7 h-7 rounded-md transition-all', viewGrid ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
            <Grid3X3 className="w-4 h-4" />
          </button>
          <button onClick={() => setViewGrid(false)} className={cn('flex items-center justify-center w-7 h-7 rounded-md transition-all', !viewGrid ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
            <List className="w-4 h-4" />
          </button>
        </div>

        <div className="relative shrink-0">
          <button className="flex items-center gap-1.5 h-9 px-3 text-sm rounded-xl border border-border bg-background text-foreground">
            <span>最近添加</span>
            <ChevronDown className="w-3 h-3 text-muted-foreground" />
          </button>
        </div>
      </header>

      <div className="px-8 border-b border-border shrink-0 relative">
        <div className="flex items-center gap-8 relative">
          <button
            onClick={() => setActiveTab('local')}
            className={cn('py-3 text-sm transition-colors duration-200', activeTab === 'local' ? 'text-foreground font-medium' : 'text-muted-foreground')}
          >本地</button>
          <button
            onClick={() => setActiveTab('online')}
            className={cn('py-3 text-sm transition-colors duration-200', activeTab === 'online' ? 'text-foreground font-medium' : 'text-muted-foreground')}
          >在线</button>
          <div
            className="absolute bottom-0 h-[2px] rounded-full bg-foreground transition-all duration-300 ease-out"
            style={{ left: activeTab === 'local' ? '0' : '52px', width: activeTab === 'local' ? '28px' : '28px' }}
          />
        </div>
      </div>

      {activeTab === 'local' ? (
        <>
          <div className="px-8 py-3 border-b border-border shrink-0">
            <div className="flex items-center gap-6">
              <FilterSelect label="状态" options={['全部', '在读', '已读', '未读']} />
              <FilterSelect label="格式" options={['全部', 'EPUB', 'PDF', 'MOBI', 'TXT', 'AZW3']} />
              <FilterSelect label="标签" options={['全部', '小说', '技术', '历史', '哲学', '科幻']} />
            </div>
          </div>

          <div className="flex-1 overflow-auto px-8 py-6">
            {loading ? (
              <div className="flex items-center justify-center h-64">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
              </div>
            ) : (
              <div className={cn('gap-5', viewGrid ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6' : 'grid grid-cols-1 lg:grid-cols-2 gap-4')}>
                {books.map((book) => {
                  const authorName = book.author || book.authors?.[0]?.name || '';
                  const bookId = String(book.id);
                  const coverUrl = resolveServerAssetUrl(serverUrl, book.img || book.thumb);
                  const ci = Math.abs(bookId.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % colors.length;

                  if (viewGrid) {
                    return (
                      <Link key={bookId} href={`/detail?id=${bookId}`} className="group flex flex-col gap-2.5">
                        <div className="relative w-full overflow-hidden rounded-[14px] transition-transform duration-150 ease-out group-hover:-translate-y-0.5 shadow-card"
                          style={{ aspectRatio: '2/3' }}>
                          {coverUrl ? (
                            <img src={coverUrl} alt={book.title} className="w-full h-full object-cover" loading="lazy" />
                          ) : (
                            <div className={cn('w-full h-full flex items-center justify-center', colors[ci])}>
                              <span className="text-foreground/20 text-2xl font-bold font-serif">{book.title[0]}</span>
                            </div>
                          )}
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
                      className="flex items-center gap-4 px-4 py-3 rounded-lg transition-colors hover:bg-muted border border-transparent hover:border-border">
                      <div className="w-10 h-[60px] rounded overflow-hidden shadow-card shrink-0 flex items-center justify-center relative">
                        {coverUrl ? (
                          <img src={coverUrl} alt={book.title} className="w-full h-full object-cover" loading="lazy" />
                        ) : (
                          <div className={cn('w-full h-full flex items-center justify-center', colors[ci])}>
                            <span className="text-foreground/30 text-xs font-bold font-serif">{book.title[0]}</span>
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate text-foreground">{book.title}</p>
                        {authorName && <p className="text-xs text-muted-foreground truncate">{authorName}</p>}
                      </div>
                      <span className="text-[11px] text-muted-foreground shrink-0">
                        {book.files?.[0]?.format?.toUpperCase() || 'EPUB'}
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-1.5 py-5 border-t border-border shrink-0 px-8">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="flex items-center justify-center h-8 px-3 text-sm rounded-sm transition-colors text-muted-foreground hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent"
              >
                上一页
              </button>
              {getPageNumbers().map((label, i) => (
                <button key={i}
                  onClick={() => typeof label === 'number' && setCurrentPage(label)}
                  disabled={label === '...'}
                  className={cn(
                    'flex items-center justify-center w-8 h-8 text-sm rounded-sm transition-colors',
                    label === currentPage ? 'bg-foreground text-primary-foreground font-medium' : 'text-muted-foreground hover:bg-muted',
                    label === '...' && 'hover:bg-transparent cursor-default'
                  )}
                >{label}</button>
              ))}
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="flex items-center justify-center h-8 px-3 text-sm rounded-sm transition-colors text-muted-foreground hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent"
              >
                下一页
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="flex-1 overflow-auto px-8 py-6">
          <div className="flex items-center gap-3 mb-6 px-4 py-3 rounded-2xl bg-muted border border-border">
            <div className="w-2 h-2 rounded-full bg-success" />
            <span className="text-sm font-medium text-foreground">已连接：Calibre 书库</span>
            <span className="text-xs text-muted-foreground">{serverUrl} · 在线书库</span>
          </div>

          <h2 className="text-sm font-semibold mb-3 text-foreground">浏览分类</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
            {[
              { icon: '🔥', label: '热门推荐', count: '86' },
              { icon: '📖', label: '小说文学', count: '312' },
              { icon: '💻', label: '科技编程', count: '158' },
              { icon: '📜', label: '人文社科', count: '203' },
              { icon: '🌍', label: '外文原版', count: '74' },
              { icon: '🔬', label: '自然科学', count: '126' },
            ].map((cat) => (
              <a key={cat.label} href="#" className="group flex flex-col items-center gap-2 p-4 rounded-2xl bg-muted transition-all duration-150 hover:-translate-y-0.5">
                <div className="w-10 h-10 rounded-2xl bg-muted flex items-center justify-center text-lg">{cat.icon}</div>
                <span className="text-xs font-medium text-foreground">{cat.label}</span>
                <span className="text-[11px] text-muted-foreground">{cat.count} 本</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </DesktopLayout>
  );
}

function FilterSelect({ label, options }: { label: string; options: string[] }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs shrink-0 text-muted-foreground">{label}</span>
      <div className="relative">
        <select className="appearance-none text-sm pl-3 pr-7 py-1.5 rounded-2xl border border-border bg-background text-foreground cursor-pointer outline-none">
          {options.map((o) => <option key={o}>{o}</option>)}
        </select>
        <ChevronDown className="w-3.5 h-3.5 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-muted-foreground" />
      </div>
    </div>
  );
}
