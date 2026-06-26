'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { useServerStore } from '@/lib/store/server';

export default function UserPage() {
  const router = useRouter();
  const { user, serverUrl, logout, setUser } = useServerStore();
  const [nickname, setNickname] = useState(user?.name || '');
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const handleSaveProfile = async () => {
    if (!nickname.trim()) return;
    setSaving(true);
    setMessage('');
    try {
      const res = await fetch(`${serverUrl}/api/user/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: nickname.trim() }),
        credentials: 'include',
      });
      const data = await res.json();
      if (data.err === 'ok' && user) {
        setUser({ ...user, name: nickname.trim() });
      }
      setMessage(data.err === 'ok' ? '保存成功' : data.msg || '保存失败');
    } catch {
      setMessage('保存失败');
    } finally { setSaving(false); }
  };

  const handleChangePassword = async () => {
    if (!oldPassword || !newPassword) return;
    setSaving(true);
    setMessage('');
    try {
      const res = await fetch(`${serverUrl}/api/user/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password0: oldPassword, password1: newPassword, password2: newPassword }),
        credentials: 'include',
      });
      const data = await res.json();
      if (data.err === 'ok') { setMessage('密码修改成功'); setShowChangePassword(false); setOldPassword(''); setNewPassword(''); }
      else setMessage(data.msg || '密码修改失败');
    } catch { setMessage('密码修改失败'); }
    finally { setSaving(false); }
  };

  const handleLogout = async () => {
    try {
      await fetch(`${serverUrl}/api/user/sign_out`, { credentials: 'include' });
    } catch {}
    logout();
    localStorage.removeItem('moke-auth-token');
    router.push('/shelf');
  };

  return (
    <DesktopLayout>
      <div className="px-8 py-8" style={{ maxWidth: '480px' }}>
        <h1 className="text-xl font-semibold mb-8 text-foreground">个人中心</h1>

        {message && (
          <div className={`text-sm rounded-lg p-4 mb-6 ${message.includes('成功') ? 'bg-success/10 border border-success/30 text-success' : 'bg-destructive/10 border border-destructive/30 text-destructive'}`}>
            {message}
          </div>
        )}

        <div className="space-y-6">
          <div className="flex items-center gap-4 pb-6 border-b border-border">
            <div className="w-14 h-14 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-lg font-bold">
              {user?.name?.[0] || '?'}
            </div>
            <div>
              <p className="text-base font-semibold text-foreground">{user?.name}</p>
              <p className="text-sm text-muted-foreground">{user?.username}</p>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label className="text-sm text-muted-foreground mb-1 block">昵称</label>
              <input type="text" placeholder="设置昵称" value={nickname} onChange={(e) => setNickname(e.target.value)}
                className="w-full h-11 px-4 rounded-[10px] bg-muted border border-border text-foreground text-sm outline-none transition-colors focus:border-primary focus:bg-background" />
            </div>

            <button onClick={() => setShowChangePassword(!showChangePassword)}
              className="text-sm text-primary hover:underline">
              {showChangePassword ? '取消修改密码' : '修改密码'}
            </button>

            {showChangePassword && (
              <div className="space-y-3 p-4 bg-card border border-border rounded-xl">
                <input type="password" placeholder="原密码" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)}
                  className="w-full h-11 px-4 rounded-[10px] bg-muted border border-border text-foreground text-sm outline-none transition-colors focus:border-primary focus:bg-background" />
                <input type="password" placeholder="新密码" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full h-11 px-4 rounded-[10px] bg-muted border border-border text-foreground text-sm outline-none transition-colors focus:border-primary focus:bg-background" />
                <button onClick={handleChangePassword} disabled={saving || !oldPassword || !newPassword}
                  className="h-11 px-5 rounded-[10px] bg-primary text-primary-foreground text-sm font-medium transition hover:opacity-90 disabled:opacity-50">
                  {saving ? '修改中...' : '确认修改'}
                </button>
              </div>
            )}
          </div>

          <div className="pt-4 space-y-1">
            <button onClick={handleSaveProfile} disabled={saving}
              className="w-full h-11 rounded-[10px] bg-primary text-primary-foreground text-sm font-medium transition hover:opacity-90 disabled:opacity-50">
              {saving ? '保存中...' : '保存'}
            </button>
            <button onClick={handleLogout}
              className="w-full h-11 rounded-[10px] bg-transparent text-destructive text-sm font-medium transition hover:bg-destructive/5">
              退出登录
            </button>
          </div>
        </div>
      </div>
    </DesktopLayout>
  );
}
