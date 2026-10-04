'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen } from 'lucide-react';
import { checkWelcomeRequirement, validateServerConnection } from '@/lib/api';
import { checkSavedServer } from '@/lib/server-connection';
import { requireClosedReaders } from '@/lib/reader-source';
import { normalizeServerAddress } from '@/lib/server-url';
import { useServerStore } from '@/lib/store/server';
import { useDeveloperStore } from '@/lib/store/developer';
import { copyTextToClipboard } from '@/lib/clipboard';
import { APP_VERSION } from '@/lib/app-version';

const DEMO_LIBRARY_URL = 'https://demo.talebook.org';
const COPY_FEEDBACK_DURATION_MS = 2000;

const buttonLayout = 'min-h-11 rounded-2xl px-4 py-2 text-sm font-medium border border-amber-950/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50';
const buttonStyle = `${buttonLayout} bg-white/50 text-foreground hover:bg-muted`;
const primaryButtonStyle = `${buttonLayout} bg-primary text-primary-foreground hover:opacity-90`;

export default function WelcomePage() {
  const router = useRouter();
  const store = useServerStore();
  const [demoLinkCopied, setDemoLinkCopied] = useState(false);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const items = useRef(new Map<string, HTMLButtonElement>());
  const controller = useRef<AbortController | null>(null);
  const versionClicks = useRef(0);
  const versionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { if (adding) input.current?.focus(); }, [adding]);
  useEffect(() => () => {
    controller.current?.abort();
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
    if (versionTimer.current) clearTimeout(versionTimer.current);
  }, []);

  const cancelConnection = () => {
    controller.current?.abort();
    controller.current = null;
    store.cancelConnection();
    const id = connectingId;
    setConnectingId(null);
    setError('');
    setNotice('连接已取消，当前连接与服务器列表已保留');
    if (id) items.current.get(id)?.focus();
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (store.saving) return;
    setError(''); setNotice('');
    const result = await store.saveServer(address);
    if (!result.ok) { setError(result.error); input.current?.focus(); return; }
    const duplicate = store.savedServers.some((s) => s.id === result.value.id);
    setAdding(false); setAddress('');
    setNotice(duplicate ? '已在列表中，点击条目即可连接' : '已保存到服务器列表，点击条目即可连接');
    requestAnimationFrame(() => items.current.get(result.value.id)?.focus());
  };

  const connect = async (id: string) => {
    if (connectingId === id || store.saving) return;
    controller.current?.abort();
    const attempt = store.beginConnection(id);
    if (!attempt) return;
    const abort = new AbortController();
    controller.current = abort;
    setConnectingId(id); setError(''); setNotice('');
    const timer = setTimeout(() => abort.abort(new Error('连接超时，请重试')), 20_000);
    try {
      const result = await checkSavedServer(attempt.url, { validate: validateServerConnection, welcome: checkWelcomeRequirement }, abort.signal);
      await requireClosedReaders();
      abort.signal.throwIfAborted();
      if (useServerStore.getState().candidate?.requestId !== attempt.requestId) return;
      if (result.needsAccessCode) {
        store.requireAccess(attempt.requestId);
        router.push(`/access?serverId=${encodeURIComponent(id)}&requestId=${attempt.requestId}`);
      } else if (await store.activateCandidate(attempt.requestId)) {
        router.push('/shelf');
      }
    } catch (failure) {
      if (useServerStore.getState().candidate?.requestId !== attempt.requestId) return;
      store.cancelConnection(attempt.requestId);
      const message = abort.signal.aborted ? (abort.signal.reason instanceof Error ? abort.signal.reason.message : '连接已取消')
        : failure instanceof Error ? failure.message : '连接失败，请重试';
      setError(`${attempt.url}：${message}`);
      items.current.get(id)?.focus();
    } finally {
      clearTimeout(timer);
      if (controller.current === abort) { controller.current = null; setConnectingId(null); }
    }
  };

  const handleCopyDemoLink = async () => {
    setDemoLinkCopied(false);
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
    if (await copyTextToClipboard(DEMO_LIBRARY_URL)) {
      setDemoLinkCopied(true);
      copyFeedbackTimerRef.current = setTimeout(() => setDemoLinkCopied(false), COPY_FEEDBACK_DURATION_MS);
    } else setError(`复制链接失败，请手动复制：${DEMO_LIBRARY_URL}`);
  };

  const disconnect = async () => {
    try { await requireClosedReaders(); store.disconnect(); setNotice('已断开，服务器列表已保留'); }
    catch (failure) { setError((failure as Error).message); }
  };
  let preview = '';
  try { preview = normalizeServerAddress(address); } catch { /* Submit displays the validation error. */ }

  return (
    <main className="min-h-screen flex flex-col md:flex-row app-warm-bg">
      <div className="hidden flex-1 items-center justify-center bg-primary px-8 py-12 md:flex md:p-16">
        <div className="max-w-md"><BookOpen className="w-16 h-16 text-primary-foreground" />
          <h1 className="mt-6 text-[36px] font-bold text-primary-foreground">墨客</h1>
          <p className="mt-2 text-lg text-primary-foreground/85">你的个人书库客户端</p>
          <p className="mt-4 text-sm text-primary-foreground/85">保存你的 Talebook 服务器，点击即可连接</p>
        </div>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 md:p-12 min-w-0">
        <div className="w-full max-w-md p-6 rounded-[32px] app-glass">
          <h2 className="text-xl font-semibold mb-4 text-card-foreground">服务器</h2>
          <p className="text-sm text-muted-foreground mb-5">加入只保存地址；点击已保存条目连接。</p>
          <div role="status" aria-live="polite" className="text-sm mb-3 text-foreground">{notice}</div>
          {(error || store.readerReturnError) && <p id="server-error" role="alert" className="text-sm text-destructive mb-4 break-words">{error || store.readerReturnError}</p>}
          {!store.hasHydrated ? <p role="status">正在加载服务器列表…</p> : store.storageError ? (
            <div role="alert" className="text-sm space-y-3">
              <p className="break-words">{store.storageError}</p>
              <button className={buttonStyle} disabled={store.saving || store.storageBusy} onClick={() => void store.loadServers()}>重试加载</button>
              <p>恢复会先备份可读取的原配置，再重建空列表；无法读取的旧浏览器配置和已有离线文件保留。备份失败时不覆盖原数据。</p>
              <button className={buttonStyle} disabled={store.saving || store.storageBusy} onClick={() => void store.recoverServers()}>保留原数据并重建列表</button>
            </div>
          ) : <>
            {!store.savedServers.length && <p className="text-sm text-muted-foreground mb-4">尚未加入服务器</p>}
            <ul className="space-y-3 mb-4">
              {store.savedServers.map((server) => <li key={server.id} className="rounded-2xl border border-amber-950/10 bg-white/50">
                <button ref={(element) => { if (element) items.current.set(server.id, element); else items.current.delete(server.id); }}
                  className="w-full min-h-11 text-left p-4 rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
                  disabled={store.saving || connectingId === server.id} onClick={() => void connect(server.id)}
                  aria-describedby={error ? 'server-error' : undefined}>
                  <span className="block text-sm font-semibold text-foreground">{server.title || new URL(server.url).host}</span>
                  <span className="block text-xs text-muted-foreground break-all mt-1">{server.url}</span>
                  {store.activeServerId === server.id && <span className="block text-xs text-foreground mt-1">{store.offlineMode ? '当前服务器（离线模式）' : '当前服务器'}</span>}
                  {connectingId === server.id && <span role="status" className="block text-xs mt-1">正在连接…</span>}
                </button>
                {connectingId === server.id && <button className={`${buttonStyle} m-2`} onClick={cancelConnection}>取消连接</button>}
              </li>)}
            </ul>
            {adding ? <form onSubmit={(event) => void save(event)} className="space-y-3">
              <label htmlFor="server-address" className="block text-sm font-medium">服务器地址</label>
              <input ref={input} id="server-address" type="text" value={address} onChange={(event) => setAddress(event.target.value)}
                placeholder="http://192.168.1.100:8080" disabled={store.saving} aria-invalid={Boolean(error)} aria-describedby={error ? 'server-error' : 'server-preview'}
                className="w-full min-h-11 px-4 rounded-2xl border border-amber-950/10 bg-white/65 text-sm focus:ring-2 focus:ring-ring" />
              <p id="server-preview" className="text-xs text-muted-foreground break-all">{preview ? `将保存：${preview}` : '只支持 HTTP/HTTPS 根地址'}</p>
              <button type="submit" disabled={store.saving} className={`${primaryButtonStyle} w-full`}>{store.saving ? '正在保存…' : '保存到列表'}</button>
              <button type="button" disabled={store.saving} className={`${buttonStyle} w-full`} onClick={() => {
                setAdding(false); setAddress(''); setError(''); requestAnimationFrame(() => addButton.current?.focus());
              }}>取消</button>
            </form> : <button ref={addButton} className={`${primaryButtonStyle} w-full`} disabled={store.saving || Boolean(connectingId)} onClick={() => { setAdding(true); setError(''); setNotice(''); }}>加入服务器</button>}
          </>}
          {store.serverUrl && <div className="flex gap-2 mt-4">
            <button className={`${buttonStyle} flex-1`} onClick={() => { controller.current?.abort(); store.cancelConnection(); router.push('/shelf'); }}>返回当前书架</button>
            <button className={buttonStyle} disabled={Boolean(connectingId) || store.saving} onClick={() => void disconnect()}>断开</button>
          </div>}
          <button data-dom-id="btn-copy-demo-link" className={`${buttonStyle} w-full mt-4`} onClick={() => void handleCopyDemoLink()}>{demoLinkCopied ? '已复制' : '复制链接'}</button>
          <button data-dom-id="btn-offline-mode" className={`${buttonStyle} w-full mt-4`} disabled={Boolean(connectingId) || store.saving} onClick={async () => {
            try { await store.enterOfflineMode(); router.push('/shelf'); } catch (failure) { setError((failure as Error).message); }
          }}>进入离线模式</button>
        </div>
        <div className="mt-6 text-xs text-muted-foreground flex gap-4">
          <span className="select-none" onClick={() => {
            versionClicks.current += 1;
            if (versionTimer.current) clearTimeout(versionTimer.current);
            if (versionClicks.current >= 8) { versionClicks.current = 0; useDeveloperStore.getState().unlock(); router.push('/settings/developer'); }
            versionTimer.current = setTimeout(() => { versionClicks.current = 0; }, 2000);
          }}>{APP_VERSION}</span>
          <a href="https://github.com/talebook/moke" target="_blank" rel="noopener noreferrer">GitHub</a>
        </div>
      </div>
    </main>
  );
}
