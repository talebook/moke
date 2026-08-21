'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import {
  acceptCurrentPrivacyPolicy,
  hasAcceptedCurrentPrivacyPolicy,
  PRIVACY_CONSENT_CHANGED_EVENT,
} from '@/lib/privacy-consent';
import { ReaderProgressProvider } from './ReaderProgressProvider';
import { ServerProvider } from './ServerProvider';

type ConsentState = 'loading' | 'pending' | 'accepted' | 'declined';

export function PrivacyConsentGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [state, setState] = useState<ConsentState>('loading');
  const [isExiting, setIsExiting] = useState(false);
  const isTauriApp = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';

  useEffect(() => {
    const syncConsent = () => {
      setState(hasAcceptedCurrentPrivacyPolicy() ? 'accepted' : 'pending');
    };
    syncConsent();
    window.addEventListener(PRIVACY_CONSENT_CHANGED_EVENT, syncConsent);
    return () => window.removeEventListener(PRIVACY_CONSENT_CHANGED_EVENT, syncConsent);
  }, []);

  // Keep the policy readable before consent without mounting ServerProvider.
  // This makes the "no server sync before consent" boundary structural rather
  // than dependent on ServerProvider's public-path list.
  if (pathname === '/privacy') return <>{children}</>;

  if (state === 'accepted') {
    return (
      <ServerProvider>
        <ReaderProgressProvider>{children}</ReaderProgressProvider>
      </ServerProvider>
    );
  }

  const handleAccept = () => {
    acceptCurrentPrivacyPolicy();
    setState('accepted');
  };

  const handleDecline = async () => {
    setIsExiting(true);
    if (isTauriApp) {
      try {
        const { exit } = await import('@tauri-apps/plugin-process');
        await exit(0);
        return;
      } catch (error) {
        console.warn('Unable to exit after privacy policy refusal:', error);
      }
    }
    setIsExiting(false);
    setState('declined');
  };

  if (state === 'loading') {
    return <div className="min-h-dvh app-warm-bg" aria-label="正在加载隐私设置" />;
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center overflow-y-auto app-warm-bg px-4 py-8">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="privacy-consent-title"
        className="w-full max-w-lg rounded-[28px] border border-amber-950/10 bg-background p-6 shadow-2xl sm:p-8"
      >
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <h1 id="privacy-consent-title" className="text-xl font-semibold text-foreground">
              隐私政策提示
            </h1>
            <p className="mt-0.5 text-xs text-muted-foreground">请在使用 Moke 前仔细阅读</p>
          </div>
        </div>

        {state === 'declined' ? (
          <div className="space-y-5">
            <p className="text-sm leading-7 text-foreground/90">
              {isTauriApp
                ? '你已拒绝隐私政策，Moke 不会连接书库或处理相关数据。你可以退出应用，或重新阅读后作出选择。'
                : '你已拒绝隐私政策，Moke 不会连接书库或处理相关数据。你可以重新阅读后作出选择，或手动关闭此页面。'}
            </p>
            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={() => setState('pending')}
                className="h-11 w-full rounded-2xl bg-primary text-base font-semibold text-primary-foreground shadow-lg shadow-primary/15 transition hover:opacity-90 active:opacity-80"
              >
                重新选择
              </button>
              {isTauriApp && (
                <button
                  type="button"
                  onClick={() => void handleDecline()}
                  disabled={isExiting}
                  className="min-h-10 w-full text-center text-xs text-muted-foreground transition hover:text-foreground disabled:opacity-50"
                >
                  {isExiting ? '正在退出…' : '退出应用'}
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => router.push('/privacy')}
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              查看隐私政策
            </button>

            <p className="mt-4 text-xs leading-5 text-muted-foreground">
              点击“同意并继续”表示你已阅读并同意隐私政策。点击“拒绝并退出”后，应用不会进入书库或发起服务器同步。
            </p>

            <div className="mt-6 flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={handleAccept}
                className="h-11 w-full rounded-2xl bg-primary text-base font-semibold text-primary-foreground shadow-lg shadow-primary/15 transition hover:opacity-90 active:opacity-80"
              >
                同意并继续
              </button>
              <button
                type="button"
                onClick={() => void handleDecline()}
                disabled={isExiting}
                className="min-h-10 w-full text-center text-xs text-muted-foreground transition hover:text-foreground disabled:opacity-50"
              >
                {isExiting ? '正在退出…' : '拒绝并退出'}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
