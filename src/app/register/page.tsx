'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen } from 'lucide-react';
import { useServerStore } from '@/lib/store/server';

export default function RegisterPage() {
  const router = useRouter();
  const { serverTitle, serverUrl } = useServerStore();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleRegister = async () => {
    if (!username.trim() || !password.trim()) return;
    setLoading(true);
    setError('');
    try {
      const body = new URLSearchParams();
      body.append('username', username.trim());
      body.append('nickname', username.trim());
      body.append('password', password);
      body.append('email', email.trim());

      const res = await fetch(`${serverUrl}/api/user/sign_up`, {
        method: 'POST',
        body,
        credentials: 'include',
      });
      const data = await res.json();
      if (data.err === 'ok') {
        router.push('/login');
      } else {
        setError(data.msg || '注册失败');
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

        <h1 className="text-[22px] font-bold text-center text-foreground">创建账号</h1>
        <p className="text-sm text-center mt-2 mb-8 text-muted-foreground">加入 {serverTitle || '书库'}</p>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 text-destructive text-sm rounded-lg p-3 mb-4">{error}</div>
        )}

        <form onSubmit={(e) => { e.preventDefault(); handleRegister(); }} className="flex flex-col gap-4">
          <div>
            <label className="block text-sm mb-1.5 font-medium text-foreground">用户名</label>
            <input type="text" placeholder="请输入用户名" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username"
              className="w-full h-11 px-4 rounded-lg bg-muted border border-border text-foreground text-sm outline-none transition-shadow duration-150 focus:ring-2 focus:ring-ring" />
          </div>
          <div>
            <label className="block text-sm mb-1.5 font-medium text-foreground">邮箱</label>
            <input type="email" placeholder="请输入邮箱" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email"
              className="w-full h-11 px-4 rounded-lg bg-muted border border-border text-foreground text-sm outline-none transition-shadow duration-150 focus:ring-2 focus:ring-ring" />
          </div>
          <div>
            <label className="block text-sm mb-1.5 font-medium text-foreground">密码</label>
            <input type="password" placeholder="请输入密码" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password"
              className="w-full h-11 px-4 rounded-lg bg-muted border border-border text-foreground text-sm outline-none transition-shadow duration-150 focus:ring-2 focus:ring-ring" />
          </div>
          <button type="submit" disabled={loading || !username.trim() || !password.trim()}
            className="w-full h-11 rounded-lg bg-primary text-primary-foreground text-base font-semibold cursor-pointer transition hover:opacity-90 active:opacity-80 mt-2 disabled:opacity-50">
            {loading ? '注册中...' : '注册'}
          </button>
        </form>

        <p className="text-sm text-center mt-6 text-muted-foreground">
          已有账号？{' '}
          <Link href="/login" data-dom-id="link-login" className="font-medium text-primary hover:underline">
            登录
          </Link>
        </p>
      </div>
    </main>
  );
}
