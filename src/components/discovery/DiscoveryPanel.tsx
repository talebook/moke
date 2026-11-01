'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Radio, RefreshCw } from 'lucide-react';
import { DiscoveryController } from '@/lib/discovery/controller';
import { bindDiscoveryLifecycle } from '@/lib/discovery/browser-lifecycle';
import { createNativeDiscoveryAdapter } from '@/lib/discovery/native';
import { createDiscoverySaveAdapter } from '@/lib/discovery/save-adapter';
import { discoverySaveFeedback } from '@/lib/discovery/save-feedback';
import { savedServerFocusHref } from '@/lib/saved-server-focus';
import type { DiscoveryState, DiscoveryStatus } from '@/lib/discovery/types';
import { DiscoveryResults } from './DiscoveryResults';

const STATUS_TEXT: Record<DiscoveryStatus, string> = {
  searching: '正在查找同一局域网内的书库…',
  empty: '暂未发现书库，仍在继续监听。请确认设备与书库处于同一局域网，且管理员已开启发现。',
  network_unavailable: '网络不可用或网络已变化，请检查 Wi-Fi 或以太网后重试。',
  permission_denied: '局域网访问权限被拒绝，请在系统设置中允许访问后重试。',
  error: '自动发现失败，请重试或手动输入服务器地址。',
  unsupported: '当前环境不支持自动发现，请手动输入服务器地址。',
  paused: '应用在后台，已暂停发现；回到前台后会重新查找。',
};

export function DiscoveryPanel() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [requiresReload, setRequiresReload] = useState(false);
  const [state, setState] = useState<DiscoveryState>({
    status: process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri' ? 'searching' : 'unsupported',
    rows: [],
  });
  const controllerRef = useRef<DiscoveryController | null>(null);
  const saveRef = useRef<ReturnType<typeof createDiscoverySaveAdapter> | null>(null);
  const saveRequest = useRef<AbortController | null>(null);
  const pausedSave = useRef<AbortController | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const supported = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri' && '__TAURI_INTERNALS__' in window;
    const adapter = createNativeDiscoveryAdapter();
    saveRef.current = createDiscoverySaveAdapter(adapter);
    const controller = new DiscoveryController({
      adapter,
      supported,
      onChange: (next) => {
        if (next.status === 'paused' && saveRequest.current) pausedSave.current = saveRequest.current;
        setState(next);
      },
    });
    controllerRef.current = controller;
    const cleanup = bindDiscoveryLifecycle(controller, document, window, navigator);
    return () => {
      alive.current = false;
      saveRequest.current?.abort();
      saveRef.current = null;
      controllerRef.current = null;
      cleanup();
    };
  }, []);

  async function save(rowId: string, baseUrl: string) {
    if (saving || requiresReload) return;
    const controller = controllerRef.current;
    const selection = controller?.select(rowId, baseUrl);
    if (!controller || !selection || !saveRef.current) {
      setSaveError('此候选已失效，请重新查找。');
      return;
    }
    const request = new AbortController();
    saveRequest.current = request;
    setSaving(true);
    setSaveError('');
    const result = await saveRef.current(selection, () => controller.isSelectionCurrent(selection), request.signal);
    if (!alive.current) return;
    setSaving(false);
    // Blur still revokes discovery. A confirmed native write survives that
    // revocation, while a lost reply still requires reload rather than retry.
    const feedback = discoverySaveFeedback(result, {
      cancelled: request !== saveRequest.current || request.signal.aborted,
      selectionCurrent: controller.isSelectionCurrent(selection),
      paused: pausedSave.current === request,
    });
    if (saveRequest.current === request) saveRequest.current = null;
    setRequiresReload(feedback.reloadRequired);
    setSaveError(feedback.message);
    if (feedback.focusEntryId) router.push(savedServerFocusHref(feedback.focusEntryId));
  }

  return (
    <main className="min-h-screen app-warm-bg px-6 py-10 md:px-10">
      <div className="mx-auto w-full max-w-2xl">
        <Link href="/welcome" className="mb-6 inline-flex items-center gap-2 text-sm text-muted-foreground">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> 返回服务器列表
        </Link>
        <section className="app-glass rounded-[28px] p-6 md:p-8" aria-labelledby="discovery-heading">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <Radio className="mb-3 h-7 w-7 text-primary" aria-hidden="true" />
              <h1 id="discovery-heading" className="text-xl font-semibold text-foreground">发现局域网书库</h1>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                名称和标识来自书库公开广播，尚未验证服务器身份。
              </p>
            </div>
            {state.status !== 'unsupported' && (
              <button
                type="button"
                onClick={() => { saveRequest.current?.abort(); controllerRef.current?.retry(); }}
                className="inline-flex h-10 items-center gap-2 rounded-2xl border border-amber-950/10 bg-white/65 px-4 text-sm text-foreground disabled:opacity-50"
                disabled={state.status === 'paused'}
                data-dom-id="btn-retry-discovery"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" /> 重新查找
              </button>
            )}
          </div>

          <p className="mt-5 rounded-2xl border border-amber-950/10 bg-white/65 p-4 text-sm text-muted-foreground" role="status" aria-live="polite">
            {STATUS_TEXT[state.status]}
          </p>

          <DiscoveryResults rows={state.rows} saving={saving} onSave={!requiresReload && state.status === 'searching' ? save : undefined} />

          <p id="discovery-save-status" className="mt-5 text-sm leading-relaxed text-muted-foreground" role="status" aria-live="polite">
            {saveError || (saving ? '正在重新校验来源并核实保存结果…' : '添加只保存到服务器列表，不会连接。保存前会再次校验当前来源和地址。')}
          </p>
          <Link href="/welcome" className="mt-5 inline-flex h-11 items-center justify-center rounded-2xl bg-primary px-5 text-sm font-medium text-primary-foreground" data-dom-id="btn-manual-discovery-entry">
            手动输入服务器地址
          </Link>
        </section>
      </div>
    </main>
  );
}
