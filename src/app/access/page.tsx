'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { request, readJsonResponse } from '@/lib/api';
import { parseLibraryBaseUrl } from '@/lib/discovery/base-url';
import { useServerStore } from '@/lib/store/server';
import { CaptchaModal } from '@/components/auth/CaptchaModal';
import { requestAnimatedBack } from '@/lib/native-back';


function AccessPageInner() {
  const router = useRouter();
  const { serverUrl, sessionRevision } = useServerStore();
  const requestRef = useRef<AbortController | null>(null);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showCaptcha, setShowCaptcha] = useState(false);

  // A URL query or old localStorage value cannot select an authentication target.
  useEffect(() => {
    setLoading(false); setError(''); setShowCaptcha(false);
    return () => {
      const pending = requestRef.current;
      requestRef.current = null;
      pending?.abort();
    };
  }, [serverUrl, sessionRevision]);

  const handleVerify = async (captchaData?: any) => {
    if (loading || requestRef.current || !code.trim()) return;
    const session = useServerStore.getState();
    try { parseLibraryBaseUrl(session.serverUrl); }
    catch { setError('未找到已确认的服务器，请返回列表重新连接。'); return; }
    const controller = new AbortController();
    requestRef.current = controller;
    const ownsRequest = () => requestRef.current === controller && useServerStore.getState().serverUrl === session.serverUrl
      && useServerStore.getState().sessionRevision === session.sessionRevision;
    const isCurrent = () => ownsRequest() && !controller.signal.aborted;
    const timer = setTimeout(() => {
      controller.abort();
      // A native transport may ignore abort. The UI deadline must still settle
      // this request, without allowing a late response to navigate or clear a retry.
      if (ownsRequest()) {
        requestRef.current = null;
        setError('验证超时，请重试。'); setLoading(false);
      }
    }, 15000);
    setLoading(true); setError('');
    try {
      const body = new URLSearchParams({ invite_code: code });
      if (typeof captchaData === 'string') body.set('captcha_code', captchaData);
      else if (captchaData) for (const [key, value] of Object.entries(captchaData)) {
        // Captcha metadata must not replace the entered access code.
        if (key !== 'invite_code') body.set(key, String(value));
      }
      const response = await request(`${session.serverUrl}/api/welcome`, {
        method: 'POST', body, credentials: 'include', signal: controller.signal, redirect: 'error',
        ...{ maxRedirections: 0 },
      });
      const res = await readJsonResponse<{ err: string; msg?: string }>(response);
      if (!isCurrent()) return;
      if (response.ok && res.err === 'ok') {
        setShowCaptcha(false); session.invalidateSession(); router.push('/shelf');
      } else if (['captcha.invalid', 'captcha.expired', 'captcha.required'].includes(res.err)) {
        setError('请完成人机验证后重试'); setShowCaptcha(true);
      } else { setError('访问码验证失败'); setShowCaptcha(false); }
    } catch { if (isCurrent()) setError('无法连接服务器'); }
    finally {
      clearTimeout(timer);
      if (requestRef.current === controller) { requestRef.current = null; setLoading(false); }
    }
  };

  return (
    <main className="flex items-center justify-center min-h-screen app-warm-bg px-4">
      <div className="relative w-full max-w-[410px] my-8 overflow-hidden rounded-[32px] app-glass p-10">
        <div className="absolute -right-16 -top-16 h-40 w-40 rounded-full bg-primary/10 blur-2xl" />
        <div className="relative">
        <button type="button" onClick={() => requestAnimatedBack('/welcome')} aria-label="返回" className="absolute -top-2 -left-2 w-8 h-8 rounded-full bg-muted hover:bg-muted/80 flex items-center justify-center transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div className="flex justify-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-primary shadow-lg shadow-primary/15 flex items-center justify-center">
            <KeyRound className="w-7 h-7 text-primary-foreground" />
          </div>
        </div>

        <h1 className="text-[22px] font-bold text-center text-foreground">私人图书馆</h1>
        <p className="text-sm text-center mt-2 mb-8 text-muted-foreground">请输入访问码以继续</p>

        {error && (
          <div role="alert" className="bg-destructive/10 border border-destructive/30 text-destructive text-sm rounded-lg p-3 mb-4">{error}</div>
        )}

        <form onSubmit={(e) => { e.preventDefault(); handleVerify(); }} className="flex flex-col gap-4">
          <input type="text" placeholder="请输入访问码" value={code} onChange={(e) => setCode(e.target.value)}
            className="w-full h-11 px-4 rounded-2xl bg-white/65 border border-amber-950/10 shadow-sm text-foreground text-sm text-center outline-none transition-shadow duration-150 focus:ring-2 focus:ring-ring" />
          <button type="submit" disabled={loading || !code.trim() || !serverUrl}
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
