'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { submitWelcomeCode } from '@/lib/api';
import { requireClosedReaders } from '@/lib/reader-source';
import { useServerStore } from '@/lib/store/server';
import { CaptchaModal } from '@/components/auth/CaptchaModal';

function AccessPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { candidate } = useServerStore();
  const serverUrl = candidate?.url || '';
  const requestId = Number(searchParams.get('requestId'));
  const serverId = searchParams.get('serverId');
  const controller = useRef<AbortController | null>(null);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showCaptcha, setShowCaptcha] = useState(false);

  const validContext = () => {
    const state = useServerStore.getState();
    return state.candidate?.requestId === requestId && state.candidate.id === serverId;
  };
  useEffect(() => () => { controller.current?.abort(); }, [requestId, serverId]);

  const handleVerify = async (captchaData?: any) => {
    if (!code.trim() || loading || !validContext()) return;
    const abort = new AbortController();
    controller.current?.abort(); controller.current = abort;
    setLoading(true);
    setError('');
    try {
      const res = await submitWelcomeCode(code, captchaData, serverUrl, abort.signal);
      if (!validContext() || abort.signal.aborted) return;
      if (res.err === 'ok') {
        await requireClosedReaders();
        if (!validContext() || abort.signal.aborted) return;
        if (!await useServerStore.getState().activateCandidate(requestId)) return;
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
      if (!abort.signal.aborted && validContext()) setError(e instanceof Error ? e.message : '无法连接服务器');
    }
    finally { setLoading(false); }
  };

  return (
    <main className="flex items-center justify-center min-h-screen app-warm-bg px-4">
      <div className="relative w-full max-w-[410px] my-8 overflow-hidden rounded-[32px] app-glass p-10">
        <div className="absolute -right-16 -top-16 h-40 w-40 rounded-full bg-primary/10 blur-2xl" />
        <div className="relative">
        <button type="button" onClick={() => { controller.current?.abort(); useServerStore.getState().cancelConnection(requestId); router.replace('/welcome'); }} aria-label="返回" className="absolute -top-2 -left-2 w-8 h-8 rounded-full bg-muted hover:bg-muted/80 flex items-center justify-center transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div className="flex justify-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-primary shadow-lg shadow-primary/15 flex items-center justify-center">
            <KeyRound className="w-7 h-7 text-primary-foreground" />
          </div>
        </div>

        <h1 className="text-[22px] font-bold text-center text-foreground">私人图书馆</h1>
        <p className="text-sm text-center mt-2 mb-8 text-muted-foreground">请输入访问码以继续</p>

        {!validContext() && <p role="alert" className="text-sm mb-4">连接上下文已失效，请返回服务器列表重新连接。</p>}
        {error && (
          <div className="bg-destructive/10 border border-destructive/30 text-destructive text-sm rounded-lg p-3 mb-4">{error}</div>
        )}

        <form onSubmit={(e) => { e.preventDefault(); handleVerify(); }} className="flex flex-col gap-4">
          <input type="text" placeholder="请输入访问码" value={code} onChange={(e) => setCode(e.target.value)}
            className="w-full h-11 px-4 rounded-2xl bg-white/65 border border-amber-950/10 shadow-sm text-foreground text-sm text-center outline-none transition-shadow duration-150 focus:ring-2 focus:ring-ring" />
          <button type="submit" disabled={loading || !code.trim() || !validContext()}
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
