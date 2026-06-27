'use client';

import { useState, useEffect } from 'react';
import { X, RefreshCw } from 'lucide-react';
import { request } from '@/lib/api';

interface CaptchaModalProps {
  isOpen: boolean;
  serverUrl: string;
  onClose: () => void;
  onSuccess: (code: string) => void;
}

export function CaptchaModal({ isOpen, serverUrl, onClose, onSuccess }: CaptchaModalProps) {
  const [image, setImage] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadCaptcha = async () => {
    setLoading(true);
    setError('');
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

  useEffect(() => {
    if (isOpen) {
      setCode('');
      loadCaptcha();
    }
  }, [isOpen, serverUrl]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
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
          className="absolute right-4 top-4 text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <h2 className="text-lg font-bold text-foreground mb-4">安全验证</h2>
        
        {error && (
          <div className="bg-destructive/10 text-destructive text-sm rounded-lg p-2 mb-4 text-center">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <div className="w-[120px] h-[44px] rounded-lg bg-muted border border-border overflow-hidden shrink-0 flex items-center justify-center">
              {loading ? (
                <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              ) : image ? (
                <img src={image} alt="验证码" className="w-full h-full object-cover cursor-pointer" onClick={loadCaptcha} />
              ) : (
                <span className="text-xs text-muted-foreground">加载失败</span>
              )}
            </div>
            
            <button
              type="button"
              onClick={loadCaptcha}
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
      </div>
    </div>
  );
}