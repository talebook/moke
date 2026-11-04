'use client';

import { useState, useEffect, useRef, useCallback, useId, type RefObject } from 'react';
import { X, RefreshCw } from 'lucide-react';
import { request } from '@/lib/api';
import { cancelResponseBodyQuietly } from '@/lib/api-core';
import { nativeConnectionErrorMessage } from '@/lib/native-connection';
import {
  buildCaptchaSandboxDocument,
  buildGeetestSandboxDocument,
  createCaptchaSandboxChannel,
  createImageCaptchaRequestLifecycle,
  parseCaptchaSandboxMessage,
  type GeetestCaptchaConfig,
} from '@/lib/captcha-core';

interface CaptchaModalProps {
  isOpen: boolean;
  serverUrl: string;
  requireValidTls?: boolean;
  requestCaptcha?: (url: string, init?: RequestInit) => Promise<Response>;
  submitting?: boolean;
  submissionError?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSuccess: (data: any) => Promise<void>;
}

interface CaptchaConfig extends GeetestCaptchaConfig {
  provider?: string;
  html?: unknown;
  webCode?: unknown;
}

export function CaptchaModal({ isOpen, serverUrl, requireValidTls = false, requestCaptcha, submitting = false, submissionError = '', returnFocusRef, onClose, onSuccess }: CaptchaModalProps) {
  const [mode, setMode] = useState<'loading' | 'image' | 'geetest' | 'webcode' | 'error'>('loading');
  const [config, setConfig] = useState<CaptchaConfig | null>(null);

  // Image Captcha state
  const [image, setImage] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [handlingSuccess, setHandlingSuccess] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();

  // Remote captcha scripts live only in this opaque-origin sandbox frame.
  const captchaFrameRef = useRef<HTMLIFrameElement>(null);
  const sandboxChannelRef = useRef('');
  const sandboxGenerationRef = useRef(0);
  const [sandboxDocument, setSandboxDocument] = useState('');
  const configRequestIdRef = useRef(0);
  const successHandledRef = useRef(false);
  const challengeGenerationRef = useRef(0);
  const successAttemptRef = useRef<object | null>(null);
  const parentSubmittingRef = useRef(submitting);
  useEffect(() => { parentSubmittingRef.current = submitting; }, [submitting]);
  const [imageRequestLifecycle] = useState(() => createImageCaptchaRequestLifecycle(
    (error) => nativeConnectionErrorMessage(error, '网络错误，无法加载验证码'),
  ));
  const configControllerRef = useRef<AbortController | null>(null);
  const captchaRequest = useCallback((url: string, init?: RequestInit) => requestCaptcha
    ? requestCaptcha(url, init) : request(url, init, { requireValidTls }), [requestCaptcha, requireValidTls]);

  const completeCaptcha = useCallback(async (data: any, generation = challengeGenerationRef.current) => {
    if (!isOpen || submitting || loading || successAttemptRef.current || successHandledRef.current
      || generation !== challengeGenerationRef.current) return;
    const attempt = {};
    successAttemptRef.current = attempt;
    successHandledRef.current = true;
    setHandlingSuccess(true);
    try {
      // The parent resolves only after its request has ended. A response does
      // not re-arm this challenge; only a fresh human edit or refresh does.
      await onSuccess(data);
    } catch (error) {
      if (successAttemptRef.current === attempt) {
        setError(nativeConnectionErrorMessage(error, '无法确认验证结果，请重试。'));
      }
    } finally {
      // A late completion from a closed modal cannot unlock a newer attempt.
      if (successAttemptRef.current === attempt) {
        successAttemptRef.current = null;
        setHandlingSuccess(false);
      }
    }
  }, [isOpen, loading, onSuccess, submitting]);

  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const trigger = returnFocusRef?.current ?? document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected && !trigger.matches(':disabled')) trigger.focus();
    };
  }, [isOpen, returnFocusRef]);

  useEffect(() => {
    if (isOpen && mode === 'image' && !loading) inputRef.current?.focus();
  }, [isOpen, loading, mode]);

  useEffect(() => {
    const handleSandboxMessage = (event: MessageEvent) => {
      if (!isOpen || !sandboxChannelRef.current) return;
      const message = parseCaptchaSandboxMessage(
        event,
        captchaFrameRef.current?.contentWindow,
        sandboxChannelRef.current,
      );
      if (!message) return;

      if (message.type === 'success') {
        void completeCaptcha(message.payload, sandboxGenerationRef.current);
        return;
      }

      setError(
        typeof message.payload === 'string' && message.payload
          ? message.payload
          : '验证码验证失败',
      );
    };

    window.addEventListener('message', handleSandboxMessage);
    return () => window.removeEventListener('message', handleSandboxMessage);
  }, [completeCaptcha, isOpen]);

  const loadCaptcha = useCallback(async () => {
    if (successAttemptRef.current || parentSubmittingRef.current) return;
    challengeGenerationRef.current += 1;
    successHandledRef.current = false;
    // Retire the previous frame immediately, before configuration HTTP starts.
    // A queued callback from that challenge must not submit during refresh.
    sandboxChannelRef.current = '';
    setSandboxDocument('');
    const requestId = ++configRequestIdRef.current;
    configControllerRef.current?.abort();
    const controller = new AbortController();
    configControllerRef.current = controller;
    setLoading(true);
    setError('');

    try {
      const configRes = await captchaRequest(`${serverUrl}/api/captcha/config`, { credentials: 'include', signal: controller.signal });
      const configData = await configRes.json();
      if (requestId !== configRequestIdRef.current) return;

      if (configData.err !== 'ok' || !configData.config) {
        throw new Error(configData.msg || '无法加载验证码配置');
      }

      setConfig(configData.config as CaptchaConfig);
      setLoading(false);
    } catch (err) {
      if (requestId !== configRequestIdRef.current) return;
      setMode('error');
      setError(nativeConnectionErrorMessage(err, err instanceof Error ? err.message : '网络错误，无法加载验证码'));
      setLoading(false);
    }
  }, [serverUrl, captchaRequest]);

  const cancelImageCaptcha = useCallback(() => {
    imageRequestLifecycle.cancel();
  }, [imageRequestLifecycle]);

  const fetchImageCaptcha = useCallback(() => {
    if (successAttemptRef.current || parentSubmittingRef.current) return;
    challengeGenerationRef.current += 1;
    successHandledRef.current = false;
    setCode('');
    setError('');
    return imageRequestLifecycle.load(
      async (signal) => {
        const res = await captchaRequest(`${serverUrl}/api/captcha/image`, {
          credentials: 'include',
          signal,
        });
        return res.json();
      },
      {
        onImage: setImage,
        onError: setError,
        onLoadingChange: setLoading,
      },
    );
  }, [imageRequestLifecycle, serverUrl, captchaRequest]);

  useEffect(() => {
    if (!config) return;

    if (config.provider === 'image') {
      setMode('image');
    } else if (config.provider === 'geetest') {
      setMode('geetest');
    } else {
      setMode('webcode');
    }
  }, [config]);

  useEffect(() => {
    let disposed = false;
    setSandboxDocument('');
    sandboxChannelRef.current = '';

    if (!isOpen) return;

    if (mode === 'image') {
      void fetchImageCaptcha();
      return cancelImageCaptcha;
    }

    if (mode === 'geetest') {
      if (!config) return;

      try {
        const channel = createCaptchaSandboxChannel();
        sandboxChannelRef.current = channel;
        sandboxGenerationRef.current = challengeGenerationRef.current;
        setSandboxDocument(buildGeetestSandboxDocument(config, channel));
      } catch (err) {
        setMode('error');
        setError(err instanceof Error ? err.message : '极验 SDK 加载失败');
      }

      return () => {
        sandboxChannelRef.current = '';
      };
    }

    if (mode === 'webcode') {
      if (!config) return;
      const controller = new AbortController();

      const fetchWebCode = async () => {
        try {
          let html = typeof config.html === 'string'
            ? config.html
            : typeof config.webCode === 'string'
              ? config.webCode
              : '';

          if (!html) {
            const provider = encodeURIComponent(config.provider || '');
            const res = await captchaRequest(
              `${serverUrl}/api/captcha/web_code?provider=${provider}`,
              { credentials: 'include', signal: controller.signal },
            );
            if (!res.ok) { await cancelResponseBodyQuietly(res); throw new Error(`HTTP ${res.status}`); }

            const data = await res.json();
            html = typeof data.html === 'string'
              ? data.html
              : typeof data.web_code === 'string'
                ? data.web_code
                : '';
          }

          if (!html) throw new Error('未提供或无法获取页面代码');
          if (disposed) return;

          const channel = createCaptchaSandboxChannel();
          sandboxChannelRef.current = channel;
          sandboxGenerationRef.current = challengeGenerationRef.current;
          setSandboxDocument(buildCaptchaSandboxDocument(html, channel));
        } catch (err) {
          if (disposed) return;
          const message = err instanceof Error ? err.message : '网络错误';
          setError(`获取 web 代码失败: ${message}`);
        }
      };

      void fetchWebCode();
      return () => { disposed = true; controller.abort(); sandboxChannelRef.current = ''; };
    }

    return () => {
      disposed = true;
      sandboxChannelRef.current = '';
    };
  }, [cancelImageCaptcha, config, fetchImageCaptcha, isOpen, mode, serverUrl, captchaRequest]);

  useEffect(() => {
    if (!isOpen) {
      configControllerRef.current?.abort();
      cancelImageCaptcha();
      configRequestIdRef.current += 1;
      challengeGenerationRef.current += 1;
      successAttemptRef.current = null;
      setHandlingSuccess(false);
      sandboxChannelRef.current = '';
      setSandboxDocument('');
      setConfig(null);
      setMode('loading');
      return;
    }

    setCode('');
    setImage('');
    setError('');
    successHandledRef.current = false;
    successAttemptRef.current = null;
    setHandlingSuccess(false);
    setMode('loading');
    setConfig(null);
    void loadCaptcha();
    return () => {
      configControllerRef.current?.abort();
      challengeGenerationRef.current += 1;
      successAttemptRef.current = null;
      sandboxChannelRef.current = '';
    };
  }, [cancelImageCaptcha, isOpen, loadCaptcha]);

  if (!isOpen) return null;

  const busy = submitting || handlingSuccess;
  const challengeGeneration = challengeGenerationRef.current;
  const close = () => {
    if (!submitting && !successAttemptRef.current) onClose();
  };

  const handleImageSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) {
      setError('请输入验证码');
      return;
    }
    void completeCaptcha(code.trim(), challengeGeneration);
  };

  const sandboxFrame = sandboxDocument ? (
    <iframe
      ref={captchaFrameRef}
      title={mode === 'geetest' ? '极验验证码' : '第三方验证码'}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={sandboxDocument}
      className={`w-full border-0 bg-transparent ${mode === 'geetest' ? 'h-[360px]' : 'min-h-[220px]'}`}
    />
  ) : (
    <div className="flex h-[150px] items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
    </div>
  );

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); close(); }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const dialog = event.currentTarget;
        const controls = [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], iframe, [tabindex]')]
          .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        const active = document.activeElement;
        // Native modal inertness blocks the background. Explicit wrapping also
        // prevents a Tab at either edge from moving focus to the browser/body.
        if (!first) { event.preventDefault(); dialog.focus(); }
        else if (event.shiftKey && (active === first || active === dialog)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (active === last || active === dialog)) {
          event.preventDefault(); first.focus();
        }
      }}
      className="max-h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-[320px] overflow-y-auto rounded-xl border border-border bg-card p-0 text-foreground shadow-lg backdrop:bg-background/60 backdrop:backdrop-blur-sm"
    >
      <div className="relative p-6">
        <button
          type="button"
          aria-label="关闭安全验证"
          onClick={close}
          disabled={busy}
          className="absolute right-4 top-4 text-muted-foreground hover:text-foreground transition-colors z-10"
        >
          <X className="w-5 h-5" />
        </button>

        <h2 id={titleId} className="text-lg font-bold text-foreground mb-4">安全验证</h2>

        {(error || submissionError) && (
          <div role="alert" className="bg-destructive/10 text-destructive text-sm rounded-lg p-2 mb-4 text-center">
            {error || submissionError}
          </div>
        )}

        {mode === 'loading' && (
          <div className="flex flex-col items-center justify-center py-8">
            <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin mb-4" />
            <p className="text-sm text-muted-foreground">正在加载安全验证...</p>
          </div>
        )}

        {mode === 'image' && (
          <form onSubmit={handleImageSubmit} className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <div className="w-[120px] h-[44px] rounded-lg bg-muted border border-border overflow-hidden shrink-0 flex items-center justify-center">
                {loading ? (
                  <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                ) : image ? (
                  <img src={image} alt="验证码" className="w-full h-full object-cover cursor-pointer" onClick={() => { if (!busy && !loading) void fetchImageCaptcha(); }} />
                ) : (
                  <span className="text-xs text-muted-foreground">加载失败</span>
                )}
              </div>

              <button
                type="button"
                onClick={fetchImageCaptcha}
                disabled={loading || busy}
                className="p-2 text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-muted"
                title="刷新验证码"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            <div>
              <input
                ref={inputRef}
                type="text"
                aria-label="图片验证码"
                placeholder="请输入图片中的字符"
                value={code}
                onChange={(e) => {
                  if (!successAttemptRef.current && !submitting) successHandledRef.current = false;
                  setCode(e.target.value);
                }}
                disabled={busy}
                className="w-full h-11 px-4 rounded-lg bg-muted border border-border text-foreground text-sm outline-none focus:ring-2 focus:ring-ring"
                autoFocus
              />
            </div>

            <button
              type="submit"
              disabled={!code.trim() || loading || busy}
              className="w-full h-11 rounded-lg bg-primary text-primary-foreground font-medium transition hover:opacity-90 active:opacity-80 disabled:opacity-50 mt-2"
            >
              {busy ? '验证中…' : '确认'}
            </button>
          </form>
        )}

        {mode === 'geetest' && (
          <div className="flex flex-col items-center justify-center py-4 min-h-[150px]">
            {sandboxFrame}
          </div>
        )}

        {mode === 'webcode' && (
          <div className="flex flex-col items-center justify-center py-4 min-h-[150px]">
            {sandboxFrame}
            <p className="text-xs text-muted-foreground mt-4 mb-4 text-center">
              验证码在隔离环境中运行，完成后将自动提交结果。
            </p>
            <button
              type="button"
              onClick={() => {
                // 这个按钮仅作为降级/测试使用，实际由沙箱内的 JS 调用回调。
                void completeCaptcha({ provider: config?.provider || 'webcode', fallback: true }, challengeGeneration);
              }}
              disabled={busy}
              className="w-full h-11 rounded-lg border border-primary text-primary font-medium transition hover:bg-primary/5 active:bg-primary/10"
            >
              我已完成验证
            </button>
          </div>
        )}

        {(mode === 'geetest' || mode === 'webcode') && (
          <button type="button" onClick={loadCaptcha} disabled={busy || loading}
            className="mt-3 w-full min-h-11 rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50">
            刷新验证码
          </button>
        )}

        {mode === 'error' && (
          <div className="flex flex-col items-center justify-center py-8">
            <button
              type="button"
              onClick={loadCaptcha}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition"
            >
              重试
            </button>
          </div>
        )}
      </div>
    </dialog>
  );
}
