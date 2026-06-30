'use client';

import Link from 'next/link';
import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { submitWelcomeCode } from '@/lib/api';
import { useServerStore } from '@/lib/store/server';
import { CaptchaModal } from '@/components/auth/CaptchaModal';
import { debugLog } from '@/lib/debug-log';

function AccessPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { serverUrl, hasHydrated } = useServerStore();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showCaptcha, setShowCaptcha] = useState(false);

  // 从 URL query 恢复 serverUrl（welcome 页跳转时带过来），
  // 这是跨页传递最可靠的方式，不受 release WebView 下 persist 不稳定的影响
  useEffect(() => {
    let candidate = searchParams.get('server') || '';
    let source = 'URL';

    // URL 没有就尝试手动写入的 localStorage 键
    if (!candidate) {
      try {
        candidate = localStorage.getItem('moke_server_url') || '';
        source = 'localStorage';
      } catch {
        // ignore
      }
    }

    debugLog('info', 'access', `恢复尝试: URL=${searchParams.get('server') || '(无)'}, localStorage=${(() => { try { return localStorage.getItem('moke_server_url') || '(无)'; } catch { return '(异常)'; } })()}`);

    if (candidate) {
      try {
        const url = new URL(candidate);
        const current = useServerStore.getState().serverUrl;
        if (current !== url.origin) {
          useServerStore.setState({
            serverUrl: url.origin,
            protocol: url.protocol.replace(':', '') as 'http' | 'https',
            host: url.hostname,
            port: url.port || (url.protocol === 'https:' ? '443' : '80'),
            isConnected: true,
          });
          debugLog('success', 'access', `已从 ${source} 恢复 serverUrl=${url.origin}`);
        }
      } catch (e) {
        debugLog('error', 'access', `server 参数解析失败: ${String(e)}`);
      }
    }
  }, [searchParams]);

  const handleVerify = async (captchaData?: any) => {
    if (!code.trim()) return;

    // 守卫：确保有 serverUrl，否则请求会发往相对路径导致网络异常
    let effectiveUrl = useServerStore.getState().serverUrl;

    // 兜底：内存为空时从手动 localStorage 键直接恢复
    if (!effectiveUrl) {
      try {
        const fromLs = localStorage.getItem('moke_server_url') || '';
        if (fromLs) {
          const url = new URL(fromLs);
          useServerStore.setState({
            serverUrl: url.origin,
            protocol: url.protocol.replace(':', '') as 'http' | 'https',
            host: url.hostname,
            port: url.port || (url.protocol === 'https:' ? '443' : '80'),
            isConnected: true,
          });
          effectiveUrl = url.origin;
          debugLog('warn', 'access守卫', `提交前从 localStorage 兜底恢复 serverUrl=${url.origin}`);
        }
      } catch {
        // ignore
      }
    }

    if (!effectiveUrl) {
      if (!hasHydrated) {
        setError('正在加载连接信息，请稍候再试…');
      } else {
        debugLog('error', 'access守卫', '内存、URL、localStorage 均无 serverUrl', { hasHydrated, serverUrl });
        setError('未找到服务器地址，请返回欢迎页重新连接');
      }
      return;
    }

    setLoading(true);
    setError('');
    try {
      const res = await submitWelcomeCode(code, captchaData);
      if (res.err === 'ok') {
        setShowCaptcha(false);
        // 验证成功后进入书架主页，而不是 router.back()（那会退回 welcome 连接页）
        router.push('/shelf');
      } else if (res.err === 'captcha.invalid' || res.err === 'captcha.expired' || res.err === 'captcha.required') {
        setError(res.msg || '请输入人机验证码');
        setShowCaptcha(true);
      } else {
        setError(res.msg || '访问码错误');
        setShowCaptcha(false);
      }
    } catch (e) {
      console.error('[AccessPage] submit error:', e);
      setError('无法连接服务器');
    }
    finally { setLoading(false); }
  };

  return (
    <main className="flex items-center justify-center min-h-screen app-warm-bg px-4">
      <div className="relative w-full max-w-[410px] my-8 overflow-hidden rounded-[32px] app-glass p-10">
        <div className="absolute -right-16 -top-16 h-40 w-40 rounded-full bg-primary/10 blur-2xl" />
        <div className="relative">
        <Link href="/welcome" className="absolute -top-2 -left-2 w-8 h-8 rounded-full bg-muted hover:bg-muted/80 flex items-center justify-center transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </Link>
        <div className="flex justify-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-primary shadow-lg shadow-primary/15 flex items-center justify-center">
            <KeyRound className="w-7 h-7 text-primary-foreground" />
          </div>
        </div>

        <h1 className="text-[22px] font-bold text-center text-foreground">私人图书馆</h1>
        <p className="text-sm text-center mt-2 mb-8 text-muted-foreground">请输入访问码以继续</p>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 text-destructive text-sm rounded-lg p-3 mb-4">{error}</div>
        )}

        <form onSubmit={(e) => { e.preventDefault(); handleVerify(); }} className="flex flex-col gap-4">
          <input type="text" placeholder="请输入访问码" value={code} onChange={(e) => setCode(e.target.value)}
            className="w-full h-11 px-4 rounded-2xl bg-white/65 border border-amber-950/10 shadow-sm text-foreground text-sm text-center outline-none transition-shadow duration-150 focus:ring-2 focus:ring-ring" />
          <button type="submit" disabled={loading || !code.trim()}
            className="w-full h-11 rounded-2xl bg-primary shadow-lg shadow-primary/15 text-primary-foreground text-base font-semibold cursor-pointer transition hover:opacity-90 active:opacity-80 mt-2 disabled:opacity-50">
            {loading ? '验证中...' : '确认'}
          </button>
        </form>
        </div>
      </div>
      <CaptchaModal
        isOpen={showCaptcha}
        serverUrl={serverUrl}
        onClose={() => setShowCaptcha(false)}
        onSuccess={(data: any) => handleVerify(data)}
      />
    </main>
  );
}

export default function AccessPage() {
  return (
    <Suspense fallback={null}>
      <AccessPageInner />
    </Suspense>
  );
}
