'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, LoaderCircle, ShieldAlert, ShieldCheck } from 'lucide-react';
import {
  assertPreviewNativeBuild,
  effectiveEntitlementState,
  nextEntitlementBoundaryDelay,
  type NativeBuildInfo,
  type PreviewEntitlementStatus,
} from '@/lib/preview-entitlement';

const isPreviewBuild = process.env.NEXT_PUBLIC_BUILD_CHANNEL === 'preview';

function formatError(error: unknown): string {
  return typeof error === 'string' && error.trim()
    ? error
    : 'Preview 授权操作失败，请稍后重试。';
}

function PreviewEntitlementGateInner({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<PreviewEntitlementStatus | null>(null);
  const [accessCode, setAccessCode] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const mountedRef = useRef(true);
  const statusRequestRef = useRef<Promise<void> | null>(null);

  const invokeEntitlement = useCallback(async (
    command: 'moke_preview_entitlement_status' | 'moke_preview_activate' | 'moke_preview_refresh',
    args?: Record<string, unknown>,
  ) => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<PreviewEntitlementStatus>(command, args);
  }, []);

  const recheckEntitlement = useCallback(() => {
    if (statusRequestRef.current) return statusRequestRef.current;

    const request = Promise.all([
      invokeEntitlement('moke_preview_entitlement_status'),
      import('@tauri-apps/api/core').then(({ invoke }) => invoke<NativeBuildInfo>('moke_build_info')),
    ])
      .then(([nextStatus, buildInfo]) => {
        assertPreviewNativeBuild(buildInfo);
        if (!mountedRef.current) return;
        setStatus(nextStatus);
        setError('');
      })
      .catch((nextError) => {
        if (!mountedRef.current) return;
        setStatus(null);
        setError(formatError(nextError));
      })
      .finally(() => {
        if (statusRequestRef.current === request) statusRequestRef.current = null;
      });
    statusRequestRef.current = request;
    return request;
  }, [invokeEntitlement]);

  useEffect(() => {
    mountedRef.current = true;
    void recheckEntitlement();
    return () => { mountedRef.current = false; };
  }, [recheckEntitlement]);

  useEffect(() => {
    const recheck = () => { void recheckEntitlement(); };
    const recheckWhenVisible = () => {
      if (document.visibilityState === 'visible') recheck();
    };
    window.addEventListener('focus', recheck);
    window.addEventListener('pageshow', recheck);
    document.addEventListener('visibilitychange', recheckWhenVisible);
    return () => {
      window.removeEventListener('focus', recheck);
      window.removeEventListener('pageshow', recheck);
      document.removeEventListener('visibilitychange', recheckWhenVisible);
    };
  }, [recheckEntitlement]);

  useEffect(() => {
    if (!status) return;
    const delay = nextEntitlementBoundaryDelay(status);
    if (delay === null) return;
    const timer = window.setTimeout(() => { void recheckEntitlement(); }, delay);
    return () => window.clearTimeout(timer);
  }, [recheckEntitlement, status]);

  const runCommand = async (
    command: 'moke_preview_activate' | 'moke_preview_refresh',
    args?: Record<string, unknown>,
  ) => {
    setIsSubmitting(true);
    setError('');
    try {
      const nextStatus = await invokeEntitlement(command, args);
      if (!mountedRef.current) return;
      setStatus(nextStatus);
      if (command === 'moke_preview_activate') setAccessCode('');
    } catch (nextError) {
      if (mountedRef.current) setError(formatError(nextError));
    } finally {
      if (mountedRef.current) setIsSubmitting(false);
    }
  };

  const effectiveState = status ? effectiveEntitlementState(status) : null;

  if (effectiveState === 'active') return <>{children}</>;

  if (effectiveState === 'offlineGrace') {
    return (
      <>
        <div
          role="status"
          className="preview-entitlement-banner fixed inset-x-0 top-0 z-[190] flex min-h-10 items-center justify-center gap-3 bg-amber-500 px-4 py-2 text-center text-xs font-medium text-amber-950 shadow"
        >
          <span>Preview 正在使用离线宽限期，请尽快联网续期。</span>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => void runCommand('moke_preview_refresh')}
            className="rounded-full bg-amber-950/10 px-3 py-1 font-semibold hover:bg-amber-950/20 disabled:opacity-50"
          >
            {isSubmitting ? '续期中…' : '立即续期'}
          </button>
        </div>
        {children}
      </>
    );
  }

  const clockRollback = effectiveState === 'clockRollback';
  const serviceConfigured = status?.serviceConfigured === true;

  return (
    <div className="fixed inset-0 z-[180] flex overflow-y-auto app-warm-bg px-4 py-8">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-entitlement-title"
        className="preview-entitlement-dialog m-auto w-full max-w-lg rounded-[28px] border border-amber-950/10 bg-background p-6 shadow-2xl sm:p-8"
      >
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            {status?.state === 'invalid' || clockRollback ? (
              <ShieldAlert className="h-6 w-6" />
            ) : (
              <KeyRound className="h-6 w-6" />
            )}
          </div>
          <div>
            <h1 id="preview-entitlement-title" className="text-xl font-semibold text-foreground">
              Moke Preview 授权
            </h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              授权与本机生成的设备密钥绑定
            </p>
          </div>
        </div>

        {!status && !error && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            正在检查 Preview 授权…
          </div>
        )}

        {status && (
          <div className="space-y-4">
            <p className="text-sm leading-6 text-foreground/90">
              {clockRollback
                ? '检测到系统时间回拨。请先校准系统时间，再重新启动应用。'
                : status.state === 'notConfigured'
                  ? '此构建尚未配置授权服务和验签公钥，因此已安全锁定。'
                  : effectiveState === 'expired'
                    ? '此设备的 Preview 授权已过期，请输入新的访问码。'
                    : effectiveState === 'invalid'
                      ? '本机授权记录无效或已被修改，请重新激活。'
                      : '请输入开发者提供的一次性 Preview 访问码。'}
            </p>

            <div className="rounded-2xl bg-muted/60 p-3 text-xs text-muted-foreground">
              <div className="mb-1 font-medium text-foreground">设备编号</div>
              <code className="break-all select-all">{status.deviceId}</code>
            </div>

            {serviceConfigured && !clockRollback && (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void runCommand('moke_preview_activate', { accessCode });
                }}
              >
                <label className="block text-sm font-medium text-foreground" htmlFor="preview-access-code">
                  Preview 访问码
                </label>
                <input
                  id="preview-access-code"
                  type="password"
                  autoComplete="one-time-code"
                  maxLength={4096}
                  required
                  value={accessCode}
                  onChange={(event) => setAccessCode(event.target.value)}
                  className="preview-entitlement-input h-11 w-full rounded-2xl border border-border bg-background px-4 text-sm outline-none ring-primary/30 transition focus:ring-4"
                />
                <button
                  type="submit"
                  disabled={isSubmitting || accessCode.trim().length === 0}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-primary text-base font-semibold text-primary-foreground shadow-lg shadow-primary/15 transition hover:opacity-90 disabled:opacity-50"
                >
                  <ShieldCheck className="h-4 w-4" />
                  {isSubmitting ? '正在激活…' : '激活此设备'}
                </button>
              </form>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="mt-4 rounded-2xl bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}

export function PreviewEntitlementGate({ children }: { children: React.ReactNode }) {
  if (!isPreviewBuild) return <>{children}</>;
  return <PreviewEntitlementGateInner>{children}</PreviewEntitlementGateInner>;
}
