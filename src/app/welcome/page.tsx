'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen, Check, Copy } from 'lucide-react';
import { checkWelcomeRequirement, validateServerConnection } from '@/lib/api';
import { logErrorMetadata } from '@/lib/api-log';
import { useServerStore } from '@/lib/store/server';
import { useDeveloperStore } from '@/lib/store/developer';
import { useSettingsStore } from '@/lib/store/settings';
import { safeGetLocalStorageItem, safeSetLocalStorageItem } from '@/lib/browser-storage';
import { debugLog } from '@/lib/debug-log';
import { APP_VERSION } from '@/lib/app-version';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openEmbeddedReaderHome } from '@/lib/moke-reader';

const DEMO_LIBRARY_URL = 'https://demo.talebook.org';
const COPY_FEEDBACK_DURATION_MS = 2000;

export default function WelcomePage() {
  const router = useRouter();
  const { setServer } = useServerStore();
  const [serverUrl, setServerUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [demoLinkCopied, setDemoLinkCopied] = useState(false);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
  }, []);

  // 主页版本号连点 8 次：解锁并直接进入开发者选项（无任何提示）
  const versionClicksRef = useRef(0);
  const versionClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleVersionClick = () => {
    versionClicksRef.current += 1;
    if (versionClickTimerRef.current) clearTimeout(versionClickTimerRef.current);
    if (versionClicksRef.current >= 8) {
      versionClicksRef.current = 0;
      useDeveloperStore.getState().unlock();
      router.push('/settings/developer');
      return;
    }
    versionClickTimerRef.current = setTimeout(() => {
      versionClicksRef.current = 0;
    }, 2000);
  };

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
        logErrorMetadata('WelcomePage validateServerConnection failed', result);
        setError(result.msg || '服务器校验失败');
        return;
      }

      const welcome = await checkWelcomeRequirement(parsed.origin);

      if (welcome.err !== 'ok') {
        logErrorMetadata('WelcomePage checkWelcomeRequirement failed', welcome);
        setError(welcome.msg || '访问码状态检查失败');
        return;
      }

      console.log('[WelcomePage] connect OK, needsAccessCode:', welcome.needsAccessCode);
      setServer(parsed.protocol, parsed.host, parsed.port);

      // release WebView 下 zustand persist 与 URL query 跨页都不可靠，
      // 直接手动写一个独立的 localStorage 键，并立即回读校验。
      // 用安全包装：ArkWeb 的 domStorageAccess 可能未开启（localStorage 为
      // null），此时静默跳过持久化，不要 console.error 以免触发
      // Next dev overlay 显示误导性的错误。
      try {
        safeSetLocalStorageItem('moke_server_url', parsed.origin);
        const verify = safeGetLocalStorageItem('moke_server_url');
        debugLog('info', 'welcome', `手动写入 localStorage moke_server_url=${parsed.origin}, 回读=${verify}`);
      } catch (e) {
        debugLog('info', 'welcome', `localStorage 不可用，跳过持久化: ${String(e)}`);
      }

      if (welcome.needsAccessCode) {
        router.push(`/access?server=${encodeURIComponent(parsed.origin)}`);
      } else {
        router.push('/shelf');
      }
    } catch (e) {
      console.error('[WelcomePage] connect exception:', e);
      setError('请输入正确的服务器地址');
    } finally {
      setLoading(false);
    }
  };

  const handleOpenReaderHome = async () => {
    setError('');
    try {
      await openEmbeddedReaderHome({
        eink: useSettingsStore.getState().eink,
        debugPanel: useDeveloperStore.getState().showDebugPanel,
        serverUrl: useServerStore.getState().serverUrl,
        navigate: (href) => router.push(href),
      });
    } catch (e) {
      console.error('[WelcomePage] open embedded reader failed:', e);
      setError('打开阅读器失败');
    }
  };

  const handleCopyDemoLink = async () => {
    setError('');
    setDemoLinkCopied(false);
    if (copyFeedbackTimerRef.current) {
      clearTimeout(copyFeedbackTimerRef.current);
      copyFeedbackTimerRef.current = null;
    }
    const copied = await copyTextToClipboard(DEMO_LIBRARY_URL);
    if (copied) {
      setDemoLinkCopied(true);
      copyFeedbackTimerRef.current = setTimeout(() => {
        setDemoLinkCopied(false);
        copyFeedbackTimerRef.current = null;
      }, COPY_FEEDBACK_DURATION_MS);
      return;
    }
    setError(`复制链接失败，请手动复制：${DEMO_LIBRARY_URL}`);
  };

  return (
    <main className="min-h-screen flex flex-col md:flex-row app-warm-bg">
        <div className="hidden flex-1 items-center justify-center bg-primary px-8 py-12 md:flex md:p-16">
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
              data-dom-id="btn-copy-demo-link"
              onClick={() => void handleCopyDemoLink()}
              disabled={loading}
              className="inline-flex items-center justify-center gap-2 w-full h-11 rounded-2xl text-sm font-medium border border-amber-950/10 bg-white/50 text-foreground cursor-pointer transition hover:opacity-80 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {demoLinkCopied
                ? <Check className="h-4 w-4" />
                : <Copy className="h-4 w-4" />}
              {demoLinkCopied ? '已复制' : '复制链接'}
            </button>

            <button
              data-dom-id="btn-open-reader"
              onClick={handleOpenReaderHome}
              disabled={loading}
              className="mt-3 inline-flex items-center justify-center gap-2 w-full h-11 rounded-2xl text-sm font-medium border border-amber-950/10 bg-white/35 text-foreground cursor-pointer transition hover:bg-white/55 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <BookOpen className="h-4 w-4" />
              打开内嵌阅读器
            </button>

            <p className="mt-5 text-xs text-center text-muted-foreground leading-relaxed">
              连接到你的 Talebook 服务器以开始使用 · 数据完全由你掌控
            </p>
          </div>

          <div className="flex items-center justify-center gap-4 mt-6 text-xs text-muted-foreground">
            <span onClick={handleVersionClick} className="cursor-default select-none">{APP_VERSION}</span>
            <a href="https://github.com/talebook/moke" target="_blank" rel="noopener noreferrer" className="hover:underline">
              GitHub
            </a>
          </div>
        </div>
    </main>
  );
}
