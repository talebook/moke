'use client';

import { useState, useEffect, useRef } from 'react';
import { X, RefreshCw } from 'lucide-react';
import { request } from '@/lib/api';

interface CaptchaModalProps {
  isOpen: boolean;
  serverUrl: string;
  onClose: () => void;
  onSuccess: (data: any) => void;
}

export function CaptchaModal({ isOpen, serverUrl, onClose, onSuccess }: CaptchaModalProps) {
  const [mode, setMode] = useState<'loading' | 'image' | 'geetest' | 'webcode' | 'error'>('loading');
  const [config, setConfig] = useState<any>(null);
  
  // Image Captcha state
  const [image, setImage] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Web Code container
  const webCodeContainerRef = useRef<HTMLDivElement>(null);
  
  // Global callback setup for injected web code
  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).__moke_captcha_success = (data: any) => {
        onSuccess(data);
      };
      (window as any).__moke_captcha_error = (err: string) => {
        setError(err);
      };
    }
  }, [onSuccess]);

  const loadCaptcha = async () => {
    setLoading(true);
    setError('');
    
    try {
      // 1. Fetch Config
      const configRes = await request(`${serverUrl}/api/captcha/config`, { credentials: 'include' });
      const configData = await configRes.json();
      
      if (configData.err !== 'ok' || !configData.config) {
        throw new Error(configData.msg || '无法加载验证码配置');
      }

      const captchaConfig = configData.config;
      setConfig(captchaConfig);
      
      // Delay changing mode to let React commit the mode change, then call specific logic in useEffect
    } catch (err: any) {
      setMode('error');
      setError(err.message || '网络错误，无法加载验证码');
      setLoading(false);
    }
  };

  useEffect(() => {
    if (config) {
      if (config.provider === 'image') {
        setMode('image');
      } else if (config.provider === 'geetest') {
        setMode('geetest');
      } else {
        setMode('webcode');
      }
    }
  }, [config]);

  useEffect(() => {
    if (mode === 'image') {
      fetchImageCaptcha();
    } else if (mode === 'geetest') {
      initGeetest(config);
    } else if (mode === 'webcode') {
      fetchAndInjectWebCode(config);
    }
  }, [mode]);

  const fetchImageCaptcha = async () => {
    setLoading(true);
    try {
      const res = await request(`${serverUrl}/api/captcha/image`, { credentials: 'include' });
      const data = await res.json();
      if (data.err === 'ok' && data.image) {
        setImage(data.image);
      } else {
        setError(data.msg || '无法加载验证码');
      }
    } catch (err) {
      setError('网络错误，无法加载验证码');
    } finally {
      setLoading(false);
    }
  };

  const initGeetest = (captchaConfig: any) => {
    if (!captchaConfig) return;
    
    if ((window as any).initGeetest4) {
      renderGeetest(captchaConfig);
      return;
    }

    const scriptId = 'geetest-sdk-script';
    let script = document.getElementById(scriptId) as HTMLScriptElement;

    if (!script) {
      script = document.createElement('script');
      script.id = scriptId;
      script.src = captchaConfig.sdkUrl || 'https://static.geetest.com/v4/gt4.js';
      script.async = true;
      document.head.appendChild(script);
    }

    const handleLoad = () => {
      renderGeetest(captchaConfig);
    };

    const handleError = () => {
      setMode('error');
      setError('极验 SDK 加载失败');
    };

    script.addEventListener('load', handleLoad);
    script.addEventListener('error', handleError);

    // If script is already loaded but event listeners were attached too late
    if ((window as any).initGeetest4) {
      renderGeetest(captchaConfig);
    }

    return () => {
      script.removeEventListener('load', handleLoad);
      script.removeEventListener('error', handleError);
    };
  };

  const renderGeetest = (captchaConfig: any) => {
    const container = document.getElementById('geetest-container');
    if (!container) return; // Might not be mounted yet
    container.innerHTML = ''; // Clear previous

    (window as any).initGeetest4({
      captchaId: captchaConfig.captchaId,
      product: 'popup',
      language: 'zho'
    }, (gt: any) => {
      gt.appendTo('#geetest-container')
        .onSuccess(() => {
          const result = gt.getValidate();
          onSuccess({
            provider: 'geetest',
            lot_number: result.lot_number,
            captcha_output: result.captcha_output,
            pass_token: result.pass_token,
            gen_time: result.gen_time
          });
        })
        .onError(() => {
          setError('极验验证失败');
        });
        
      // Show automatically for popup product
      gt.showCaptcha();
    });
  };

  const fetchAndInjectWebCode = async (captchaConfig: any) => {
    try {
      let html = captchaConfig.html || captchaConfig.webCode;
      
      // If the config doesn't provide HTML directly, call the API to get it
      if (!html) {
        const res = await request(`${serverUrl}/api/captcha/web_code?provider=${captchaConfig.provider}`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          html = data.html || data.web_code;
        }
      }

      if (html && webCodeContainerRef.current) {
        injectHtmlWithScripts(webCodeContainerRef.current, html);
      } else {
        throw new Error('未提供或无法获取页面代码');
      }
    } catch (err: any) {
      setError(`获取 web 代码失败: ${err.message}`);
    }
  };

  const injectHtmlWithScripts = (container: HTMLElement, html: string) => {
    container.innerHTML = html;
    const scripts = container.querySelectorAll('script');
    scripts.forEach(oldScript => {
      const newScript = document.createElement('script');
      Array.from(oldScript.attributes).forEach(attr => newScript.setAttribute(attr.name, attr.value));
      if (oldScript.innerHTML) {
        newScript.innerHTML = oldScript.innerHTML;
      }
      oldScript.parentNode?.replaceChild(newScript, oldScript);
    });
  };

  useEffect(() => {
    if (isOpen) {
      setCode('');
      setMode('loading'); // 重置模式状态
      setConfig(null); // 清除旧的配置
      if (webCodeContainerRef.current) {
        webCodeContainerRef.current.innerHTML = ''; // 清除之前的注入代码
      }
      loadCaptcha();
    }
  }, [isOpen, serverUrl]);

  if (!isOpen) return null;

  const handleImageSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) {
      setError('请输入验证码');
      return;
    }
    onSuccess(code.trim());
  };

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
            <div id="geetest-container" className="w-full flex justify-center"></div>
          </div>
        )}

        {mode === 'webcode' && (
          <div className="flex flex-col items-center justify-center py-4 min-h-[150px]">
            <div ref={webCodeContainerRef} className="w-full" />
            <p className="text-xs text-muted-foreground mt-4 mb-4 text-center">
              提示：此验证码由远端直接注入页面代码。请确保在远端代码执行完成后调用 <code>window.__moke_captcha_success(data)</code>。
            </p>
            <button
              type="button"
              onClick={() => {
                // 这个按钮仅作为降级/测试使用，实际应该由注入的JS自动调用回调
                // 这里我们调用一个模拟的成功回调，主要为了防止页面卡死
                onSuccess({ provider: config?.provider || 'webcode', fallback: true });
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