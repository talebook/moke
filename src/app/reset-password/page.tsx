'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen } from 'lucide-react';
import { useServerStore } from '@/lib/store/server';
import { request } from '@/lib/api';
import { CaptchaModal } from '@/components/auth/CaptchaModal';

interface TalebookResetResponse {
  err: string;
  msg?: string;
}

async function resetPassword(email: string, username: string, captchaData?: any): Promise<TalebookResetResponse> {
  const { serverUrl } = useServerStore.getState();
  const body = new URLSearchParams();
  body.append('email', email);
  body.append('username', username);
  
  if (captchaData) {
    if (typeof captchaData === 'string') {
      body.append('captcha_code', captchaData);
    } else {
      Object.keys(captchaData).forEach(key => {
        body.append(key, captchaData[key]);
      });
    }
  }

  const response = await request(`${serverUrl}/api/user/reset`, {
    method: 'POST',
    body,
    credentials: 'include',
  });
  return response.json();
}

export default function ResetPasswordPage() {
  const router = useRouter();
  const { serverTitle, serverUrl } = useServerStore();
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  
  // Captcha state
  const [showCaptcha, setShowCaptcha] = useState(false);

  const handleReset = async (captchaData?: any) => {
    if (!email.trim() || !username.trim()) return;
    setLoading(true);
    setError('');
    setSuccess(false);

    try {
      const res = await resetPassword(email, username, captchaData);

      if (res.err === 'ok') {
        setShowCaptcha(false);
        setSuccess(true);
        // Do not redirect immediately, let user see the success message
      } else if (res.err === 'captcha.invalid' || res.err === 'captcha.expired' || res.err === 'captcha.required') {
        setError(res.msg || '请输入人机验证码');
        setShowCaptcha(true);
      } else {
        setError(res.msg || '重置失败，请检查邮箱和用户名');
      }
    } catch {
      setError('无法连接服务器');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex items-center justify-center min-h-screen app-warm-bg px-4">
      <div className="relative w-full max-w-[410px] my-8 overflow-hidden rounded-[32px] app-glass p-10">
        <div className="absolute -right-16 -top-16 h-40 w-40 rounded-full bg-primary/10 blur-2xl" />
        <div className="relative">
        <div className="flex justify-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-[#6f5134] shadow-lg shadow-primary/15 flex items-center justify-center">
            <BookOpen className="w-7 h-7 text-primary-foreground" />
          </div>
        </div>

        <h1 className="text-[22px] font-bold text-center text-foreground">重置密码</h1>
        <p className="text-sm text-center mt-2 mb-8 text-muted-foreground">
          {serverTitle || '书库'} 将发送新密码到你的邮箱
        </p>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 text-destructive text-sm rounded-lg p-3 mb-4">
            {error}
          </div>
        )}
        
        {success && (
          <div className="bg-green-500/10 border border-green-500/30 text-green-600 dark:text-green-400 text-sm rounded-lg p-3 mb-4">
            新密码已发送到您的邮箱，请查收并使用新密码登录。
          </div>
        )}

        <form onSubmit={(e) => { e.preventDefault(); handleReset(); }} className="flex flex-col gap-4">
          <div>
            <label className="block text-sm mb-1.5 font-medium text-foreground">邮箱</label>
            <input
              type="email"
              placeholder="请输入注册时的邮箱"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              className="w-full h-11 px-4 rounded-2xl bg-white/65 border border-amber-950/10 shadow-sm text-foreground text-sm outline-none transition-shadow duration-150 focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label className="block text-sm mb-1.5 font-medium text-foreground">用户名</label>
            <input
              type="text"
              placeholder="请输入用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className="w-full h-11 px-4 rounded-2xl bg-white/65 border border-amber-950/10 shadow-sm text-foreground text-sm outline-none transition-shadow duration-150 focus:ring-2 focus:ring-ring"
            />
          </div>

          <button
            type="submit"
            disabled={loading || !email.trim() || !username.trim()}
            className="w-full h-11 rounded-2xl bg-primary shadow-lg shadow-primary/15 text-primary-foreground text-base font-semibold cursor-pointer transition hover:opacity-90 active:opacity-80 mt-2 disabled:opacity-50"
          >
            {loading ? '提交中...' : '重置密码'}
          </button>
        </form>

        <p className="text-sm text-center mt-6 text-muted-foreground">
          记起密码了？{' '}
          <Link
            href="/login"
            className="font-medium text-primary hover:underline"
          >
            返回登录
          </Link>
        </p>

        <CaptchaModal
          isOpen={showCaptcha}
          serverUrl={serverUrl}
          onClose={() => setShowCaptcha(false)}
          onSuccess={(data) => handleReset(data)}
        />
        </div>
      </div>
    </main>
  );
}
