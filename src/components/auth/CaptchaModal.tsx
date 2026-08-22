'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { X, RefreshCw } from 'lucide-react';
import { request } from '@/lib/api';
import {
  buildCaptchaSandboxDocument,
  buildGeetestSandboxDocument,
  createCaptchaSandboxChannel,
  parseCaptchaSandboxMessage,
  type GeetestCaptchaConfig,
} from '@/lib/captcha-core';

interface CaptchaModalProps {
  isOpen: boolean;
  serverUrl: string;
  onClose: () => void;
  onSuccess: (data: any) => void;
}

interface CaptchaConfig extends GeetestCaptchaConfig {
  provider?: string;
  html?: unknown;
  webCode?: unknown;
}

export function CaptchaModal({ isOpen, serverUrl, onClose, onSuccess }: CaptchaModalProps) {
  const [mode, setMode] = useState<'loading' | 'image' | 'geetest' | 'webcode' | 'error'>('loading');
  const [config, setConfig] = useState<CaptchaConfig | null>(null);

  // Image Captcha state
  const [image, setImage] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Remote captcha scripts live only in this opaque-origin sandbox frame.
  const captchaFrameRef = useRef<HTMLIFrameElement>(null);
  const sandboxChannelRef = useRef('');
  const [sandboxDocument, setSandboxDocument] = useState('');
  const configRequestIdRef = useRef(0);
  const successHandledRef = useRef(false);

  const completeCaptcha = useCallback((data: any) => {
    if (successHandledRef.current) return;
    successHandledRef.current = true;
    onSuccess(data);
  }, [onSuccess]);

  useEffect(() => {
    const handleSandboxMessage = (event: MessageEvent) => {
      const message = parseCaptchaSandboxMessage(
        event,
        captchaFrameRef.current?.contentWindow,
        sandboxChannelRef.current,
      );
      if (!message) return;

      if (message.type === 'success') {
        completeCaptcha(message.payload);
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
  }, [completeCaptcha]);

  const loadCaptcha = useCallback(async () => {
    const requestId = ++configRequestIdRef.current;
    setLoading(true);
    setError('');

    try {
      const configRes = await request(`${serverUrl}/api/captcha/config`, { credentials: 'include' });
      const configData = await configRes.json();
      if (requestId !== configRequestIdRef.current) return;

      if (configData.err !== 'ok' || !configData.config) {
        throw new Error(configData.msg || '无法加载验证码配置');
      }

      setConfig(configData.config as CaptchaConfig);
    } catch (err) {
      if (requestId !== configRequestIdRef.current) return;
      setMode('error');
      setError(err instanceof Error ? err.message : '网络错误，无法加载验证码');
      setLoading(false);
    }
  }, [serverUrl]);

  const fetchImageCaptcha = useCallback(async () => {
    setLoading(true);
    try {
      const res = await request(`${serverUrl}/api/captcha/image`, { credentials: 'include' });
      const data = await res.json();
      if (data.err === 'ok' && data.image) {
        setImage(data.image);
      } else {
        setError(data.msg || '无法加载验证码');
      }
    } catch {
      setError('网络错误，无法加载验证码');
    } finally {
      setLoading(false);
    }
  }, [serverUrl]);

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

    if (mode === 'image') {
      void fetchImageCaptcha();
      return;
    }

    if (mode === 'geetest') {
      if (!config) return;

      try {
        const channel = createCaptchaSandboxChannel();
        sandboxChannelRef.current = channel;
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

      const fetchWebCode = async () => {
        try {
          let html = typeof config.html === 'string'
            ? config.html
            : typeof config.webCode === 'string'
              ? config.webCode
              : '';

          if (!html) {
            const provider = encodeURIComponent(config.provider || '');
            const res = await request(
              `${serverUrl}/api/captcha/web_code?provider=${provider}`,
              { credentials: 'include' },
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

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
          setSandboxDocument(buildCaptchaSandboxDocument(html, channel));
        } catch (err) {
          if (disposed) return;
          const message = err instanceof Error ? err.message : '网络错误';
          setError(`获取 web 代码失败: ${message}`);
        }
      };

      void fetchWebCode();
    }

    return () => {
      disposed = true;
      sandboxChannelRef.current = '';
    };
  }, [config, fetchImageCaptcha, mode, serverUrl]);

  useEffect(() => {
    if (!isOpen) {
      configRequestIdRef.current += 1;
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
    setMode('loading');
    setConfig(null);
    void loadCaptcha();
  }, [isOpen, loadCaptcha]);

  if (!isOpen) return null;

  const handleImageSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) {
      setError('请输入验证码');
      return;
    }
    completeCaptcha(code.trim());
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm">
      <div className="relative w-full max-w-[320px] mx-4 rounded-xl p-6 bg-card border border-border shadow-lg">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-muted-foreground hover:text-foreground transition-colors z-10"
        >
          <X className="w-5 h-5" />
        </button>

        <h2 className="text-lg font-bold text-foreground mb-4">安全验证</h2>

        {error && (
          <div className="bg-destructive/10 text-destructive text-sm rounded-lg p-2 mb-4 text-center">
            {error}
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
                  <img src={image} alt="验证码" className="w-full h-full object-cover cursor-pointer" onClick={fetchImageCaptcha} />
                ) : (
                  <span className="text-xs text-muted-foreground">加载失败</span>
                )}
              </div>

              <button
                type="button"
                onClick={fetchImageCaptcha}
                disabled={loading}
                className="p-2 text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-muted"
                title="刷新验证码"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            <div>
              <input
                type="text"
                placeholder="请输入图片中的字符"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="w-full h-11 px-4 rounded-lg bg-muted border border-border text-foreground text-sm outline-none focus:ring-2 focus:ring-ring"
                autoFocus
              />
            </div>

            <button
              type="submit"
              disabled={!code.trim() || loading}
              className="w-full h-11 rounded-lg bg-primary text-primary-foreground font-medium transition hover:opacity-90 active:opacity-80 disabled:opacity-50 mt-2"
            >
              确认
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
                completeCaptcha({ provider: config?.provider || 'webcode', fallback: true });
              }}
              className="w-full h-11 rounded-lg border border-primary text-primary font-medium transition hover:bg-primary/5 active:bg-primary/10"
            >
              我已完成验证
            </button>
          </div>
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
    </div>
  );
}
