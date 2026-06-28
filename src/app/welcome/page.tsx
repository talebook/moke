'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen } from 'lucide-react';
import { checkWelcomeRequirement, validateServerConnection } from '@/lib/api';
import { useServerStore } from '@/lib/store/server';

export default function WelcomePage() {
  const router = useRouter();
  const { setServer } = useServerStore();
  const [serverUrl, setServerUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const normalizeServerUrl = (value: string) => {
    const input = value.trim();
    if (!input) {
      throw new Error('empty');
    }

    const url = new URL(input.startsWith('http') ? input : `http://${input}`);
    return {
      protocol: url.protocol.replace(':', '') as 'http' | 'https',
      host: url.hostname,
      port: url.port || (url.protocol === 'https:' ? '443' : '80'),
      origin: url.origin,
    };
  };

  const handleConnect = async (value: string) => {
    setError('');
    setLoading(true);

    try {
      const parsed = normalizeServerUrl(value);
      const result = await validateServerConnection(parsed.origin);

      if (result.err !== 'ok') {
        setError(result.msg || '服务器校验失败');
        return;
      }

      const welcome = await checkWelcomeRequirement(parsed.origin);

      if (welcome.err !== 'ok') {
        setError(welcome.msg || '访问码状态检查失败');
        return;
      }

      setServer(parsed.protocol, parsed.host, parsed.port);
      router.push(welcome.needsAccessCode ? '/access' : '/shelf');
    } catch {
      setError('请输入正确的服务器地址');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex flex-col md:flex-row app-warm-bg">
        <div className="flex-1 flex items-center justify-center px-8 py-12 md:p-16 bg-primary">
          <div className="max-w-md">
            <BookOpen className="w-16 h-16 text-primary-foreground" />
            <h1 className="mt-6 text-[36px] font-bold text-primary-foreground">墨客</h1>
            <p className="mt-2 text-lg text-primary-foreground/85">你的个人书库客户端</p>
            <p className="mt-4 text-sm leading-relaxed text-white/60">
              连接 Talebook 书库，在任何设备上阅读你的藏书
            </p>
          </div>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-8 py-12 md:p-16">
          <div className="w-full max-w-sm p-8 rounded-[32px] app-glass">
            <h2 className="text-xl font-semibold mb-6 text-card-foreground">连接书库</h2>

            {error && (
              <div className="mb-4 rounded-[10px] border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}

            <div className="mb-4">
              <label className="block text-xs font-medium mb-1.5 text-muted-foreground">
                服务器地址
              </label>
              <input
                type="text"
                placeholder="http://192.168.1.100:8080"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleConnect(serverUrl);
                  }
                }}
                className="w-full h-11 px-4 rounded-2xl border border-amber-950/10 bg-white/65 shadow-sm text-foreground text-sm outline-none transition-colors duration-150 focus:ring-2 focus:ring-ring focus:border-ring"
              />
            </div>

            <button
              data-dom-id="btn-connect"
              onClick={() => handleConnect(serverUrl)}
              disabled={loading || !serverUrl.trim()}
              className="inline-flex items-center justify-center w-full h-11 rounded-2xl text-sm font-medium bg-primary shadow-lg shadow-primary/15 text-primary-foreground cursor-pointer transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? '连接中...' : '连接'}
            </button>

            <div className="flex items-center my-5">
              <div className="flex-1 border-t border-border"></div>
              <span className="mx-3 text-xs text-muted-foreground">或者</span>
              <div className="flex-1 border-t border-border"></div>
            </div>

            <button
              data-dom-id="btn-browse-demo"
              onClick={() => handleConnect('https://demo.talebook.org')}
              disabled={loading}
              className="inline-flex items-center justify-center w-full h-11 rounded-2xl text-sm font-medium border border-amber-950/10 bg-white/50 text-foreground cursor-pointer transition hover:opacity-80 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              浏览演示书库
            </button>

            <p className="mt-5 text-xs text-center text-muted-foreground leading-relaxed">
              连接到你的 Talebook 服务器以开始使用 · 数据完全由你掌控
            </p>
          </div>

          <div className="flex items-center justify-center gap-4 mt-6 text-xs text-muted-foreground">
            <span>v0.1.0</span>
            <a href="https://github.com/talebook/moke" target="_blank" rel="noopener noreferrer" className="hover:underline">
              GitHub
            </a>
          </div>
        </div>
    </main>
  );
}
