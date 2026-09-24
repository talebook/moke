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
  if (error === 'PREVIEW_DEVICE_LIMIT_REACHED') {
    return '此激活码已绑定另一台设备。如需重装迁移，请确认替换原设备。';
  }
  if (error === 'PREVIEW_DEVICE_TRANSFER_COOLDOWN') {
    return '此资格最近已经迁移过设备。为防止激活码被盗刷，七天内不能再次迁移。';
  }
  if (error === 'PREVIEW_DEVICE_TRANSFER_REQUIRES_APPROVAL') {
    return '原设备最近仍在使用。为防止激活码被盗后抢占设备，请等待原设备离线满 24 小时，或联系开发者在控制台中重置设备。';
  }
  return typeof error === 'string' && error.trim()
    ? error
    : 'Preview 授权操作失败，请稍后重试。';
}

function PreviewEntitlementGateInner({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<PreviewEntitlementStatus | null>(null);
  const [accessCode, setAccessCode] = useState('');
  const [error, setError] = useState('');
  const [isChecking, setIsChecking] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [canReplaceDevice, setCanReplaceDevice] = useState(false);
  const [windowLabel, setWindowLabel] = useState<string | null>(null);
  const [entitlementCheckRevision, setEntitlementCheckRevision] = useState(0);
  const [handoffAttempt, setHandoffAttempt] = useState(0);
  const mountedRef = useRef(true);
  const statusRequestRef = useRef<Promise<void> | null>(null);
  const handoffRequestedRef = useRef(false);

  const invokeEntitlement = useCallback(async (
    command: 'moke_preview_entitlement_status' | 'moke_preview_activate' | 'moke_preview_refresh',
    args?: Record<string, unknown>,
  ) => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<PreviewEntitlementStatus>(command, args);
  }, []);

  const recheckEntitlement = useCallback(() => {
    if (statusRequestRef.current) return statusRequestRef.current;

    setIsChecking(true);
    const request = Promise.all([
      invokeEntitlement('moke_preview_entitlement_status'),
      import('@tauri-apps/api/core').then(({ invoke }) => invoke<NativeBuildInfo>('moke_build_info')),
      import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().label),
    ])
      .then(([nextStatus, buildInfo, nextWindowLabel]) => {
        assertPreviewNativeBuild(buildInfo);
        if (!mountedRef.current) return;
        setStatus(nextStatus);
        setWindowLabel(nextWindowLabel);
        setEntitlementCheckRevision((revision) => revision + 1);
        setError('');
      })
      .catch((nextError) => {
        if (!mountedRef.current) return;
        setStatus(null);
        setError(formatError(nextError));
      })
      .finally(() => {
        if (statusRequestRef.current === request) statusRequestRef.current = null;
        if (mountedRef.current) setIsChecking(false);
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

  const effectiveState = status ? effectiveEntitlementState(status) : null;
  const isEntitled = effectiveState === 'active' || effectiveState === 'offlineGrace';
  const canRefreshExpiredLease = effectiveState === 'expired' && Boolean(status?.subject);

  useEffect(() => {
    if (
      (!isEntitled && !canRefreshExpiredLease)
      || windowLabel !== 'preview-bootstrap'
      || handoffRequestedRef.current
    ) return;
    handoffRequestedRef.current = true;
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<void>('moke_preview_enter_app'))
      .catch((nextError) => {
        handoffRequestedRef.current = false;
        if (mountedRef.current) setError(formatError(nextError));
      });
  }, [
    canRefreshExpiredLease,
    entitlementCheckRevision,
    handoffAttempt,
    isEntitled,
    windowLabel,
  ]);

  const retryHandoff = () => {
    handoffRequestedRef.current = false;
    setError('');
    setHandoffAttempt((attempt) => attempt + 1);
  };

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
      if (command === 'moke_preview_activate') {
        setAccessCode('');
        setCanReplaceDevice(false);
      }
    } catch (nextError) {
      if (mountedRef.current) {
        setCanReplaceDevice(
          command === 'moke_preview_activate' && nextError === 'PREVIEW_DEVICE_LIMIT_REACHED',
        );
        setError(formatError(nextError));
      }
    } finally {
      if (mountedRef.current) setIsSubmitting(false);
    }
  };

  if (isEntitled && windowLabel !== 'main') {
    return (
      <div className="fixed inset-0 z-[180] flex items-center justify-center app-warm-bg px-4 text-sm text-muted-foreground">
        {error ? (
          <div className="w-full max-w-md rounded-3xl border border-border bg-background p-6 text-center shadow-2xl">
            <ShieldAlert className="mx-auto mb-3 h-7 w-7 text-destructive" />
            <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>
            <button
              type="button"
              onClick={retryHandoff}
              className="h-10 rounded-2xl bg-primary px-5 font-semibold text-primary-foreground transition hover:opacity-90"
            >
              重试续期并启动
            </button>
          </div>
        ) : (
          <>
            <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
            正在启动已授权的 Preview 工作区…
          </>
        )}
      </div>
    );
  }

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
                    ? canRefreshExpiredLease
                      ? '此设备的 Preview 授权已过期。请联网重试续期，或输入新的访问码。'
                      : '此设备的 Preview 授权已过期，请输入新的访问码。'
                    : effectiveState === 'invalid'
                      ? '本机授权记录无效或已被修改，请重新激活。'
                      : '请输入开发者提供的一次性 Preview 访问码。'}
            </p>

            <div className="rounded-2xl bg-muted/60 p-3 text-xs text-muted-foreground">
              <div className="mb-1 font-medium text-foreground">设备编号</div>
              <code className="break-all select-all">{status.deviceId}</code>
            </div>

            {canRefreshExpiredLease && (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => void runCommand('moke_preview_refresh')}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-2xl border border-primary/30 bg-primary/5 text-sm font-semibold text-primary transition hover:bg-primary/10 disabled:opacity-50"
              >
                <ShieldCheck className="h-4 w-4" />
                {isSubmitting ? '正在续期…' : '重试续期'}
              </button>
            )}

            {serviceConfigured && !clockRollback && (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  setCanReplaceDevice(false);
                  void runCommand('moke_preview_activate', {
                    accessCode,
                    replaceExistingDevice: false,
                  });
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
                  onChange={(event) => {
                    setAccessCode(event.target.value);
                    setCanReplaceDevice(false);
                  }}
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
                {canReplaceDevice && (
                  <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3">
                    <p className="mb-3 text-xs leading-5 text-amber-900 dark:text-amber-100">
                      原设备离线满 24 小时后才允许自动迁移。继续后原设备会立即失效，当前设备将接管该资格；迁移成功后七天内不能再次迁移。
                    </p>
                    <button
                      type="button"
                      disabled={isSubmitting || accessCode.trim().length === 0}
                      onClick={() => void runCommand('moke_preview_activate', {
                        accessCode,
                        replaceExistingDevice: true,
                      })}
                      className="h-10 w-full rounded-2xl bg-amber-700 px-4 text-sm font-semibold text-white transition hover:bg-amber-800 disabled:opacity-50"
                    >
                      {isSubmitting ? '正在迁移…' : '确认替换原设备'}
                    </button>
                  </div>
                )}
              </form>
            )}
          </div>
        )}

        {error && (
          <div className="mt-4 space-y-3">
            <p role="alert" className="rounded-2xl bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </p>
            {!status && (
              <button
                type="button"
                disabled={isChecking}
                onClick={() => void recheckEntitlement()}
                className="flex h-10 w-full items-center justify-center rounded-2xl border border-border bg-background text-sm font-semibold text-foreground transition hover:bg-muted disabled:opacity-50"
              >
                {isChecking ? '检查中…' : '重新检查'}
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

export function PreviewEntitlementGate({ children }: { children: React.ReactNode }) {
  if (!isPreviewBuild) return <>{children}</>;
  return <PreviewEntitlementGateInner>{children}</PreviewEntitlementGateInner>;
}
