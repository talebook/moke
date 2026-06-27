'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen, Eye, EyeOff } from 'lucide-react';
import { useServerStore } from '@/lib/store/server';
import { fetchCurrentUser, request } from '@/lib/api';
import { CaptchaModal } from '@/components/auth/CaptchaModal';

interface TalebookLoginResponse {
  err: string;
  msg?: string;
}

async function login(username: string, password: string, captchaData?: any): Promise<TalebookLoginResponse> {
  const { serverUrl } = useServerStore.getState();
  const body = new URLSearchParams();
  body.append('username', username);
  body.append('password', password);
  
  if (captchaData) {
    if (typeof captchaData === 'string') {
      body.append('captcha_code', captchaData);
    } else {
      Object.keys(captchaData).forEach(key => {
        body.append(key, captchaData[key]);
      });
    }
  }

  const response = await request(`${serverUrl}/api/user/sign_in`, {
    method: 'POST',
    body,
    credentials: 'include',
  });
  return response.json();
}

export default function LoginPage() {
  const router = useRouter();
  const { logout, serverTitle, setConnected } = useServerStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  // Captcha state
  const [showCaptcha, setShowCaptcha] = useState(false);
  const { serverUrl } = useServerStore.getState();

  const handleLogin = async (captchaData?: any) => {
    if (!username.trim() || !password.trim()) return;
    setLoading(true);
    setError('');

    try {
      const res = await login(username, password, captchaData);

      if (res.err === 'ok') {
        setShowCaptcha(false);
        const info = await fetchCurrentUser();
        if (!info.isLogin || !info.user) {
          logout();
          setError('登录请求已成功，但服务器没有建立登录状态。请检查浏览器是否阻止了跨站 Cookie，或确认当前服务器地址是否可被前端正常携带会话。');
          return;
        }

        localStorage.removeItem('moke-auth-token');
        setConnected('', info.user);
        router.push('/shelf');
      } else if (res.err === 'user.private.not_valid') {
        router.push('/access');
      } else if (res.err === 'captcha.invalid' || res.err === 'captcha.expired' || res.err === 'captcha.required') {
        setError(res.msg || '请输入人机验证码');
        setShowCaptcha(true);
      } else {
        setError(res.msg || '登录失败，请检查用户名和密码');
      }
    } catch {
      setError('无法连接服务器');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex items-center justify-center min-h-screen bg-background">
      <div className="w-full max-w-[390px] mx-4 my-8 rounded-xl p-10 bg-card border border-border">
        <div className="flex justify-center mb-8">
          <div className="w-14 h-14 rounded-full bg-primary flex items-center justify-center">
            <BookOpen className="w-7 h-7 text-primary-foreground" />
          </div>
        </div>

        <h1 className="text-[22px] font-bold text-center text-foreground">登录</h1>
        <p className="text-sm text-center mt-2 mb-8 text-muted-foreground">欢迎回到 {serverTitle || '书库'}</p>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 text-destructive text-sm rounded-lg p-3 mb-4">
            {error}
          </div>
        )}

        <form onSubmit={(e) => { e.preventDefault(); handleLogin(); }} className="flex flex-col gap-4">
          <div>
            <label className="block text-sm mb-1.5 font-medium text-foreground">用户名</label>
            <input
              type="text"
              placeholder="请输入用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className="w-full h-11 px-4 rounded-lg bg-muted border border-border text-foreground text-sm outline-none transition-shadow duration-150 focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label className="block text-sm mb-1.5 font-medium text-foreground">密码</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="请输入密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="w-full h-11 px-4 pr-11 rounded-lg bg-muted border border-border text-foreground text-sm outline-none transition-shadow duration-150 focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center cursor-pointer text-muted-foreground"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || !username.trim() || !password.trim()}
            className="w-full h-11 rounded-lg bg-primary text-primary-foreground text-base font-semibold cursor-pointer transition hover:opacity-90 active:opacity-80 mt-2 disabled:opacity-50"
          >
            {loading ? '登录中...' : '登录'}
          </button>
        </form>

        <p className="text-sm text-center mt-6 text-muted-foreground">
          还没有账号？{' '}
          <Link
            href="/register"
            data-dom-id="link-register"
            className="font-medium text-primary hover:underline"
          >
            注册
          </Link>
          <span className="mx-2 text-border">|</span>
          <Link
            href="/reset-password"
            className="font-medium text-primary hover:underline"
          >
            忘记密码？
          </Link>
        </p>

        <CaptchaModal 
          isOpen={showCaptcha} 
          serverUrl={serverUrl} 
          onClose={() => setShowCaptcha(false)} 
          onSuccess={(data) => handleLogin(data)} 
        />
      </div>
    </main>
  );
}
