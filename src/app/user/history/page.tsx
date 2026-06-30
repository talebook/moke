'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, BookOpen, Download, History, Send, Upload } from 'lucide-react';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { request } from '@/lib/api';
import { useServerStore } from '@/lib/store/server';
import { cn, resolveServerAssetUrl } from '@/lib/utils';
import { AuthImage } from '@/components/ui/AuthImage';

type HistoryType = 'reading' | 'finished' | 'read_history' | 'download_history' | 'push_history' | 'upload_history';

interface HistoryItem {
  id: string | number;
  title: string;
  timestamp?: number;
  img?: string;
  thumb?: string;
  href?: string;
  state?: {
    read_state?: number;
  };
}

interface HistoryGroup {
  key: HistoryType;
  label: string;
  icon: typeof BookOpen;
}

const historyGroups: HistoryGroup[] = [
  { key: 'reading', label: '在读', icon: BookOpen },
  { key: 'finished', label: '读完', icon: BookOpen },
  { key: 'read_history', label: '阅读记录', icon: BookOpen },
  { key: 'download_history', label: '下载记录', icon: Download },
  { key: 'push_history', label: '推送记录', icon: Send },
  { key: 'upload_history', label: '上传记录', icon: Upload },
];

const emptyStateConfig: Record<HistoryType, { description: string; actionLabel: string; actionHref: string }> = {
  reading: {
    description: '开始阅读一本书后，这里会显示你的在读书籍。',
    actionLabel: '去书库',
    actionHref: '/library',
  },
  finished: {
    description: '读完一本书后，这里会显示你的读完书籍。',
    actionLabel: '去书库',
    actionHref: '/library',
  },
  read_history: {
    description: '去搜索或阅读一本书后，这里会显示你的阅读记录。',
    actionLabel: '去搜索',
    actionHref: '/search',
  },
  download_history: {
    description: '下载过书籍后，这里会显示你的下载记录。',
    actionLabel: '去书库',
    actionHref: '/library',
  },
  push_history: {
    description: '推送过书籍到设备后，这里会显示你的推送记录。',
    actionLabel: '去书库',
    actionHref: '/library',
  },
  upload_history: {
    description: '上传过书籍后，这里会显示你的上传记录。',
    actionLabel: '去书库',
    actionHref: '/library',
  },
};

export default function UserHistoryPage() {
  const router = useRouter();
  const { serverUrl } = useServerStore();
  const [activeTab, setActiveTab] = useState<HistoryType>('reading');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [historyMap, setHistoryMap] = useState<Record<HistoryType, HistoryItem[]>>({
    reading: [],
    finished: [],
    read_history: [],
    download_history: [],
    push_history: [],
    upload_history: [],
  });

  useEffect(() => {
    const loadHistory = async () => {
      setLoading(true);
      setMessage('');
      try {
        const res = await request(`${serverUrl}/api/user/info?detail=1`, {
          credentials: 'include',
        });
        const data = await res.json();

        if (data.err === 'user.need_login') {
          router.push('/login');
          return;
        }

        if (data.err !== 'ok') {
          setMessage(data.msg || '历史记录加载失败');
          return;
        }

        const extra = data.user?.extra || {};
        const readHistory = Array.isArray(extra.read_history) ? extra.read_history : [];
        const { reading, finished } = await filterReadingStateBooks(serverUrl, readHistory);
        setHistoryMap({
          reading,
          finished,
          read_history: readHistory,
          download_history: Array.isArray(extra.download_history) ? extra.download_history : [],
          push_history: Array.isArray(extra.push_history) ? extra.push_history : [],
          upload_history: Array.isArray(extra.upload_history) ? extra.upload_history : [],
        });
      } catch {
        setMessage('历史记录加载失败');
      } finally {
        setLoading(false);
      }
    };

    loadHistory();
  }, [router, serverUrl]);

  const currentItems = historyMap[activeTab];
  const totalCount = useMemo(
    () => historyGroups.reduce((sum, group) => sum + historyMap[group.key].length, 0),
    [historyMap],
  );
  const emptyState = emptyStateConfig[activeTab];

  return (
    <DesktopLayout>
      <div className="px-8 py-8" style={{ maxWidth: '1200px' }}>
        <div className="flex items-center gap-3 mb-8">
          <button
            onClick={() => router.back()}
            className="flex items-center justify-center w-10 h-10 rounded-2xl border border-amber-950/10 bg-white/60 shadow-sm text-muted-foreground transition hover:text-foreground hover:bg-muted"
            aria-label="返回"
            title="返回"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-11 h-11 rounded-xl bg-muted text-foreground">
              <History className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-foreground">历史记录</h1>
              <p className="text-sm text-muted-foreground">共 {totalCount} 条记录</p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-3 mb-6">
          {historyGroups.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={cn(
                'flex items-center gap-2 px-4 py-2 rounded-2xl border text-sm transition-all shadow-sm',
                activeTab === key
                  ? 'border-foreground bg-muted text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted',
              )}
            >
              <Icon className="w-4 h-4" />
              <span>{label}</span>
              <span className="text-xs opacity-80">{historyMap[key].length}</span>
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-40">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
          </div>
        ) : message ? (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-5 py-4 text-sm text-destructive">
            {message}
          </div>
        ) : currentItems.length === 0 ? (
          <div className="rounded-[32px] app-glass px-8 py-16 text-center">
            <p className="text-lg font-medium text-foreground">暂无记录</p>
            <p className="mt-2 text-sm text-muted-foreground">{emptyState.description}</p>
            <Link
              href={emptyState.actionHref}
              className="inline-flex mt-6 h-11 items-center justify-center rounded-[10px] bg-primary px-5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
            >
              {emptyState.actionLabel}
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {currentItems.map((item) => {
              const detailHref = `/detail?id=${item.id}`;
              const coverUrl = resolveServerAssetUrl(serverUrl, item.img || item.thumb);
              return (
                <Link
                  key={`${activeTab}-${item.id}`}
                  href={detailHref}
                  className="flex items-center gap-4 rounded-2xl border border-amber-950/10 bg-white/55 shadow-sm px-4 py-4 transition-colors hover:bg-muted"
                >
                  <div className="w-12 h-[72px] rounded-lg overflow-hidden shadow-card shrink-0 flex items-center justify-center bg-muted">
                    {coverUrl ? (
                      <AuthImage
                        src={coverUrl}
                        alt={item.title}
                        className="w-full h-full object-cover"
                        loading="lazy"
                        fallback={<span className="text-foreground/30 text-sm font-bold font-serif">{item.title[0]}</span>}
                      />
                    ) : (
                      <span className="text-foreground/30 text-sm font-bold font-serif">{item.title[0]}</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">{item.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatTimestamp(item.timestamp)}
                    </p>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </DesktopLayout>
  );
}

async function filterReadingStateBooks(serverUrl: string, books: HistoryItem[]) {
  const states = await Promise.all(
    books.map(async (book) => {
      if (typeof book.state?.read_state === 'number') return book.state.read_state;

      try {
        const res = await request(`${serverUrl}/api/book/${book.id}/readstate`, {
          credentials: 'include',
        });
        const data = await res.json();
        return data.err === 'ok' ? data.read_state : 0;
      } catch {
        return 0;
      }
    }),
  );

  return {
    reading: books.filter((_, index) => states[index] === 1),
    finished: books.filter((_, index) => states[index] === 2),
  };
}

function formatTimestamp(timestamp?: number) {
  if (!timestamp) return '时间未知';

  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return '时间未知';

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
