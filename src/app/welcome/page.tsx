'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen, Check, Copy, Server } from 'lucide-react';
import { checkWelcomeRequirement, validateServerConnection } from '@/lib/api';
import { prepareServerJoin, type JoinedServer } from '@/lib/join-server';
import { useServerStore } from '@/lib/store/server';
import { useDeveloperStore } from '@/lib/store/developer';
import { safeGetLocalStorageItem, safeSetLocalStorageItem } from '@/lib/browser-storage';
import { debugLog } from '@/lib/debug-log';
import { APP_VERSION } from '@/lib/app-version';
import { copyTextToClipboard } from '@/lib/clipboard';

const DEMO_LIBRARY_URL = 'https://demo.talebook.org';
const COPY_FEEDBACK_DURATION_MS = 2000;
const JOIN_TIMEOUT_MS = 20_000;

export default function WelcomePage() {
  const router = useRouter();
  const { serverUrl: savedServerUrl, offlineMode, setServer, enterOfflineMode } = useServerStore();
  const [serverUrl, setServerUrl] = useState(savedServerUrl);
  const [step, setStep] = useState<'intro' | 'form' | 'success'>('intro');
  const [joined, setJoined] = useState<JoinedServer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const startRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const successRef = useRef<HTMLHeadingElement | null>(null);
  const [demoLinkCopied, setDemoLinkCopied] = useState(false);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    requestRef.current?.abort();
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
    if (versionClickTimerRef.current) clearTimeout(versionClickTimerRef.current);
  }, []);

  useEffect(() => {
    if (step === 'form') {
      if (loading) cancelRef.current?.focus();
      else inputRef.current?.focus();
    } else if (step === 'success') successRef.current?.focus();
    else startRef.current?.focus();
  }, [step, loading]);

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

  const handleJoin = async () => {
    // The ref also guards repeated Enter presses before React renders disabled controls.
    if (requestRef.current || joined) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setError('');
    setNotice('');
    setLoading(true);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, JOIN_TIMEOUT_MS);

    try {
      const parsed = await prepareServerJoin(serverUrl, {
        validate: validateServerConnection,
        welcome: checkWelcomeRequirement,
      }, controller.signal);
      if (requestRef.current !== controller || controller.signal.aborted) return;
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

      setJoined(parsed);
      setStep('success');
    } catch (e) {
      if (requestRef.current !== controller) return;
      if (timedOut) setError('加入超时，请检查服务器地址和网络后重试');
      else if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '加入失败，请稍后重试');
    } finally {
      clearTimeout(timeout);
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  };

  const handleCancel = () => {
    requestRef.current?.abort();
    requestRef.current = null;
    setLoading(false);
    setError('');
    setNotice('已取消加入，现有配置保持不变');
    setStep('intro');
  };

  const handleEnterOfflineMode = () => {
    enterOfflineMode();
    router.push('/shelf');
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

        <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 md:p-16">
          <div className="w-full max-w-sm p-6 sm:p-8 rounded-[32px] app-glass">
            <h2 id="join-title" className="text-xl font-semibold text-card-foreground">加入服务器</h2>

            {error && (
              <div id="join-error" role="alert" className="mt-4 rounded-[10px] border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}

            {step === 'form' ? (
              <form aria-labelledby="join-title" onSubmit={(e) => { e.preventDefault(); void handleJoin(); }} className="mt-4">
                <p id="join-help" className="mb-5 text-sm leading-relaxed text-muted-foreground">填写书库管理员提供的 Talebook 根地址，我们会验证服务器并检查是否需要访问码。</p>
                <label htmlFor="join-server-address" className="block text-xs font-medium mb-1.5 text-muted-foreground">服务器地址</label>
                <input
                  ref={inputRef}
                  id="join-server-address"
                  type="text"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-describedby={error ? 'join-help join-error' : 'join-help'}
                  aria-invalid={Boolean(error)}
                  placeholder="http://192.168.1.100:8080"
                  value={serverUrl}
                  onChange={(e) => { setServerUrl(e.target.value); setError(''); }}
                  disabled={loading}
                  className="w-full h-11 px-4 rounded-2xl border border-amber-950/10 bg-white/65 shadow-sm text-foreground text-sm outline-none transition-colors duration-150 focus:ring-2 focus:ring-ring focus:border-ring disabled:opacity-60"
                />
                <p role="status" className="mt-3 text-xs leading-relaxed text-muted-foreground">{loading ? '正在验证服务器与访问权限…' : '支持 HTTP、HTTPS 和局域网地址，省略协议时使用 HTTP。'}</p>
                <button type="submit" data-dom-id="btn-connect" disabled={loading || !serverUrl.trim()}
                  className="mt-5 inline-flex items-center justify-center w-full h-11 rounded-2xl text-sm font-medium bg-primary text-primary-foreground transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">
                  {loading ? '正在加入…' : error ? '重试加入' : '加入服务器'}
                </button>
                <button ref={cancelRef} type="button" onClick={handleCancel}
                  className="mt-3 w-full h-11 rounded-2xl border border-amber-950/10 text-sm text-foreground hover:bg-white/55 focus-visible:ring-2 focus-visible:ring-ring">取消加入</button>
              </form>
            ) : step === 'success' && joined ? (
              <div className="mt-5">
                <Check aria-hidden="true" className="h-8 w-8 text-primary" />
                <h3 ref={successRef} tabIndex={-1} className="mt-3 text-lg font-semibold text-foreground outline-none">已加入服务器</h3>
                <p className="mt-2 break-all text-sm text-muted-foreground">{joined.origin}</p>
                <p role="status" className="mt-3 text-sm leading-relaxed text-muted-foreground">{joined.needsAccessCode ? '服务器验证成功，请继续输入管理员提供的访问码。' : '服务器验证成功，可以进入书架，或登录后同步个人书架。'}</p>
                <button type="button" onClick={() => router.push(joined.needsAccessCode ? `/access?server=${encodeURIComponent(joined.origin)}` : '/shelf')}
                  className="mt-5 w-full h-11 rounded-2xl bg-primary text-primary-foreground text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">{joined.needsAccessCode ? '继续验证访问码' : '进入书架'}</button>
                {!joined.needsAccessCode && <button type="button" onClick={() => router.push('/login')}
                  className="mt-3 w-full h-11 rounded-2xl border border-amber-950/10 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring">登录账号</button>}
              </div>
            ) : (
              <>
            <p className="mt-3 mb-5 text-sm leading-relaxed text-muted-foreground">加入你的 Talebook 服务器，浏览藏书并在设备上阅读。请先向书库管理员获取服务器地址。</p>
            {notice && <p role="status" className="mb-4 text-sm text-muted-foreground">{notice}</p>}
            <button ref={startRef} type="button" data-dom-id="btn-start-join" onClick={() => { setNotice(''); setError(''); setStep('form'); }}
              className="inline-flex gap-2 items-center justify-center w-full h-11 rounded-2xl text-sm font-medium bg-primary text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
              <Server aria-hidden="true" className="h-4 w-4" />开始加入
            </button>
            {(savedServerUrl || offlineMode) && <button type="button" onClick={() => router.push('/shelf')}
              className="mt-3 w-full h-11 rounded-2xl border border-amber-950/10 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring">返回书架</button>}

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
              data-dom-id="btn-offline-mode"
              onClick={handleEnterOfflineMode}
              disabled={loading}
              className="mt-3 inline-flex items-center justify-center gap-2 w-full h-11 rounded-2xl text-sm font-medium border border-amber-950/10 bg-white/35 text-foreground cursor-pointer transition hover:bg-white/55 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <BookOpen className="h-4 w-4" />
              进入离线模式
            </button>

            <p className="mt-5 text-xs text-center text-muted-foreground leading-relaxed">
              加入服务器后可登录同步书库，也可使用已下载内容离线阅读
            </p>
              </>
            )}
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
