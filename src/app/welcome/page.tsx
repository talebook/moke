'use client';

import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { BookOpen, Check, Copy, Plus } from 'lucide-react';
import { useServerStore } from '@/lib/store/server';
import { loadSavedServers, saveServer, getSavedServersSnapshot, type SavedServerView } from '@/lib/saved-server-api';
import { connectionState, savedServerConnection, submitSavedServerAccess } from '@/lib/saved-server-connection';
import { CaptchaModal } from '@/components/auth/CaptchaModal';
import { UNLOCK_THRESHOLD, useDeveloperStore } from '@/lib/store/developer';
import { externalLinkClick } from '@/lib/external-link';
import { APP_VERSION } from '@/lib/app-version';
import { copyTextToClipboard } from '@/lib/clipboard';

const DEMO_LIBRARY_URL = 'https://demo.talebook.org';
const COPY_FEEDBACK_DURATION_MS = 2000;
const button = 'min-h-11 rounded-2xl border border-amber-950/10 bg-white/60 px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 disabled:cursor-not-allowed';
const field = 'w-full h-11 px-4 rounded-2xl border border-amber-950/10 bg-white/65 text-foreground text-sm outline-none focus:ring-2 focus:ring-ring';

export default function WelcomePage() {
  const router = useRouter();
  const enterOfflineMode = useServerStore((state) => state.enterOfflineMode);
  const activeUrl = useServerStore((state) => state.serverUrl);
  const connection = useStore(connectionState, (value) => value.state);
  const [entries, setEntries] = useState<SavedServerView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [listBusy, setListBusy] = useState(true);
  const [listError, setListError] = useState('');
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [demoLinkCopied, setDemoLinkCopied] = useState(false);
  const accessController = useRef<AbortController | null>(null);
  const versionClicksRef = useRef(0);
  const versionClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);

  async function reload() {
    setListBusy(true);
    const result = await loadSavedServers();
    if (!alive.current) return;
    setListBusy(false); setLoaded(result.ok);
    if (result.ok) { setEntries(result.savedServers); setListError(''); }
    else setListError('无法确认服务器列表，请检查存储权限或空间后重新加载。原始数据和已输入内容会保留。');
  }
  useEffect(() => {
    alive.current = true; void reload();
    return () => {
      alive.current = false; savedServerConnection.cancel(); accessController.current?.abort();
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
      if (versionClickTimerRef.current) clearTimeout(versionClickTimerRef.current);
    };
  }, []);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true); setError(''); setNotice('');
    const result = await saveServer({ rawBaseUrl: address, displayName });
    if (!alive.current) return;
    setSaving(false);
    if (!result.ok) {
      if (result.outcome === 'storage-failure') {
        setLoaded(false);
        setListError(result.persistence === 'unknown'
          ? '保存结果尚未确认。请先重新加载核对条目，再决定是否重试；不要重复添加。'
          : '保存失败，请检查存储权限或空间后重新加载。');
      }
      setError(result.outcome === 'needs-edit' ? '请输入完整的 http:// 或 https:// 地址及有效名称；名称最多 128 个字符。'
        : result.outcome === 'collision' ? '已有地址冲突，请保留原件并核实条目。' : '未确认保存成功，输入内容已保留。');
      return;
    }
    setEntries(getSavedServersSnapshot().savedServers);
    setNotice(result.outcome === 'existing' ? '该服务器已在列表中，已选中原条目。' : '已保存。点击列表条目后才会连接。');
    setAddress(''); setDisplayName(''); setEditing(false);
    requestAnimationFrame(() => document.getElementById(`saved-${result.server.id}`)?.focus());
  }
  async function handleConnect(entry: SavedServerView) {
    if (!loaded || listBusy || saving || verifying) return;
    setError(''); setNotice(''); setAccessCode(''); setShowCaptcha(false);
    const result = await savedServerConnection.connect(entry);
    if (alive.current && result.phase === 'connected') router.push('/shelf');
  }
  async function verifyAccess(captcha?: unknown) {
    if (verifying || !accessCode.trim()) return;
    const controller = new AbortController();
    accessController.current?.abort(); accessController.current = controller;
    const timer = setTimeout(() => controller.abort(), 15_000);
    setVerifying(true); setError('');
    try {
      const result = await submitSavedServerAccess(accessCode, captcha, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      if (result.err === 'ok') {
        setShowCaptcha(false);
        if ('connection' in result && result.connection.phase === 'connected') router.push('/shelf');
      } else if (['captcha.invalid', 'captcha.expired', 'captcha.required'].includes(result.err)) {
        setError('请完成人机验证后重试。'); setShowCaptcha(true);
      } else setError('访问码验证失败，请检查后重试。');
    } catch {
      if (alive.current) setError(controller.signal.aborted ? '验证已取消或超时，请重试。' : '无法确认该条目和访问码，请重新选择服务器。');
    } finally {
      clearTimeout(timer); if (alive.current) setVerifying(false);
    }
  }
  const handleVersionClick = () => {
    versionClicksRef.current++;
    if (versionClickTimerRef.current) clearTimeout(versionClickTimerRef.current);
    if (versionClicksRef.current >= UNLOCK_THRESHOLD) {
      versionClicksRef.current = 0;
      const developer = useDeveloperStore.getState(); developer.setShowDebugPanel(!developer.showDebugPanel);
    } else versionClickTimerRef.current = setTimeout(() => { versionClicksRef.current = 0; }, 1200);
  };
  const handleCopyDemoLink = async () => {
    setDemoLinkCopied(false);
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
    if (await copyTextToClipboard(DEMO_LIBRARY_URL)) {
      setDemoLinkCopied(true); copyFeedbackTimerRef.current = setTimeout(() => setDemoLinkCopied(false), COPY_FEEDBACK_DURATION_MS);
    } else setError(`复制链接失败，请手动复制：${DEMO_LIBRARY_URL}`);
  };
  const connecting = connection?.phase === 'connecting';

  return (
    <main className="min-h-screen flex flex-col md:flex-row app-warm-bg">
      <div className="hidden flex-1 items-center justify-center bg-primary px-8 py-12 md:flex md:p-16">
        <div className="max-w-md"><BookOpen className="w-16 h-16 text-primary-foreground" /><h1 className="mt-6 text-[36px] font-bold text-primary-foreground">墨客</h1><p className="mt-2 text-lg text-primary-foreground/85">你的个人书库客户端</p><p className="mt-4 text-sm leading-relaxed text-white/60">保存你的书库，在需要时连接。</p></div>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 md:p-12">
        <section className="w-full max-w-md p-6 sm:p-8 rounded-[32px] app-glass" aria-labelledby="servers-title">
          <div className="flex items-center justify-between gap-3 mb-4"><h2 id="servers-title" className="text-xl font-semibold text-card-foreground">服务器列表</h2><button type="button" className={button} disabled={listBusy || saving || connecting || verifying} onClick={() => void reload()}>重新加载</button></div>
          <p className="text-sm text-muted-foreground mb-5">加入只保存地址；点击已保存的条目后才会连接。</p>
          {listError && <p role="alert" className="mb-4 text-sm text-destructive">{listError}</p>}
          {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
          {notice && <p role="status" className="mb-4 text-sm text-foreground">{notice}</p>}
          {listBusy && <p role="status" className="mb-4 text-sm text-muted-foreground">正在加载服务器列表…</p>}
          {loaded && !listBusy && entries.length === 0 && <p className="mb-4 rounded-2xl border border-dashed border-border p-5 text-sm text-muted-foreground">尚未加入服务器。先保存一个书库地址。</p>}
          <ul className="space-y-3 mb-4" aria-label="已保存服务器">
            {entries.map((entry) => <li key={entry.id}>
              <button id={`saved-${entry.id}`} type="button" className={`${button} w-full text-left break-all`} disabled={!loaded || listBusy || saving || verifying || entry.status !== 'ready'} onClick={() => void handleConnect(entry)}>
                <span className="block font-semibold">{entry.displayName || entry.title || '未命名书库'}</span><span className="block mt-1 text-xs text-muted-foreground">{entry.url || '无效地址已保留'}</span>
                <span className="block mt-1 text-xs">{entry.status === 'needs-edit' ? '需要更正，原始记录已保留' : entry.status === 'collision' ? '地址冲突，原始记录已保留' : connection?.entryId === entry.id && connecting ? '连接中…' : entry.url === activeUrl ? '当前书库 · 点击重新确认连接' : '点击连接'}</span>
              </button>
            </li>)}
          </ul>
          {connection && connection.phase !== 'idle' && connection.phase !== 'connected' && <div className="mb-4 rounded-2xl border border-border p-3 text-sm" role="status">
            <p className="break-all">{connection.url}</p><p className="mt-1">{connecting ? '正在确认服务器与访问码状态…' : connection.message}</p>
            {connection.code === 'source-in-use' && <p className="mt-2 text-muted-foreground">请先结束下载；此前尝试打开阅读器时需重启应用。同主机多个书库的直接切换和原生连接目前暂受限，已保存的条目会保留。</p>}
            {connecting && <button type="button" className={`${button} mt-3`} onClick={() => savedServerConnection.cancel()}>取消连接</button>}
            {connection.needsAccessCode && <form className="mt-3 space-y-3" onSubmit={(e) => { e.preventDefault(); void verifyAccess(); }}>
              <label className="block" htmlFor="candidate-access">该书库的访问码</label><input id="candidate-access" className={field} autoComplete="off" value={accessCode} onChange={(e) => setAccessCode(e.target.value)} disabled={verifying} />
              <button type="submit" className={button} disabled={verifying || !accessCode.trim()}>{verifying ? '验证中…' : '验证并连接'}</button>
              <button type="button" className={`${button} ml-2`} onClick={() => { accessController.current?.abort(); savedServerConnection.cancel(); setAccessCode(''); setShowCaptcha(false); }}>取消验证</button>
            </form>}
          </div>}
          {editing ? <form className="space-y-3 mb-4" onSubmit={handleSave}>
            <label htmlFor="saved-address" className="block text-sm">服务器地址</label><input ref={inputRef} id="saved-address" className={field} type="url" placeholder="https://books.example/team/books" autoComplete="url" spellCheck={false} value={address} onChange={(e) => setAddress(e.target.value)} disabled={saving} required />
            <label htmlFor="saved-name" className="block text-sm">名称（可选）</label><input id="saved-name" className={field} value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={saving} />
            <div className="flex gap-3"><button type="submit" className={`${button} flex-1 bg-primary text-primary-foreground`} disabled={saving || !loaded || listBusy || !address}>{saving ? '保存中…' : '保存服务器'}</button><button type="button" className={button} disabled={saving} onClick={() => { setEditing(false); setError(''); requestAnimationFrame(() => addButtonRef.current?.focus()); }}>取消添加</button></div>
          </form> : <button ref={addButtonRef} type="button" className={`${button} w-full flex items-center justify-center gap-2`} disabled={!loaded || listBusy || connecting || verifying} onClick={() => { setEditing(true); setError(''); }}><Plus className="h-4 w-4" />加入服务器</button>}
          <Link href="/join" prefetch={false} className="mt-3 flex min-h-11 items-center justify-center rounded-2xl border border-amber-950/10 px-4 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">加入服务器 · 局域网发现</Link>
          <div className="flex items-center my-5"><div className="flex-1 border-t border-border" /><span className="mx-3 text-xs text-muted-foreground">或者</span><div className="flex-1 border-t border-border" /></div>
          <button data-dom-id="btn-copy-demo-link" type="button" className={`${button} w-full flex items-center justify-center gap-2`} onClick={() => void handleCopyDemoLink()}>{demoLinkCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{demoLinkCopied ? '已复制' : '复制链接'}</button>
          <button data-dom-id="btn-offline-mode" type="button" className={`${button} mt-3 w-full`} disabled={saving || connecting || verifying} onClick={() => { enterOfflineMode(); router.push('/shelf'); }}>进入离线模式</button>
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">保存不代表连接成功。本阶段的书库连接暂未开放阅读功能。</p>
        </section>
        <div className="flex items-center justify-center gap-4 mt-6 text-xs text-muted-foreground"><button type="button" onClick={handleVersionClick} className="rounded px-1 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">{APP_VERSION}</button><a href="https://github.com/talebook/moke" onClick={externalLinkClick('https://github.com/talebook/moke')} rel="noopener noreferrer" className="hover:underline">GitHub</a></div>
      </div>
      <CaptchaModal isOpen={showCaptcha && Boolean(connection?.needsAccessCode)} serverUrl={connection?.url || ''} requireValidTls onClose={() => setShowCaptcha(false)} onSuccess={(data) => void verifyAccess(data)} />
    </main>
  );
}
