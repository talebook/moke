'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Radio, RefreshCw } from 'lucide-react';
import { DiscoveryController } from '@/lib/discovery/controller';
import { bindDiscoveryLifecycle } from '@/lib/discovery/browser-lifecycle';
import { createNativeDiscoveryAdapter } from '@/lib/discovery/native';
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
  const [state, setState] = useState<DiscoveryState>({
    status: process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri' ? 'searching' : 'unsupported',
    rows: [],
  });
  const controllerRef = useRef<DiscoveryController | null>(null);

  useEffect(() => {
    const supported = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri' && '__TAURI_INTERNALS__' in window;
    const controller = new DiscoveryController({
      adapter: createNativeDiscoveryAdapter(),
      supported,
      onChange: setState,
    });
    controllerRef.current = controller;
    const cleanup = bindDiscoveryLifecycle(controller, document, window, navigator);
    return () => {
      controllerRef.current = null;
      cleanup();
    };
  }, []);

  return (
    <main className="min-h-screen app-warm-bg px-6 py-10 md:px-10">
      <div className="mx-auto w-full max-w-2xl">
        <Link href="/welcome" className="mb-6 inline-flex items-center gap-2 text-sm text-muted-foreground">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> 返回连接页
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
                onClick={() => controllerRef.current?.retry()}
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

          <DiscoveryResults rows={state.rows} />

          <p id="discovery-save-unavailable" className="mt-5 text-sm leading-relaxed text-muted-foreground">
            添加入口尚未就绪。发现结果暂不能保存到服务器列表。
          </p>
          <Link href="/welcome" className="mt-5 inline-flex h-11 items-center justify-center rounded-2xl bg-primary px-5 text-sm font-medium text-primary-foreground" data-dom-id="btn-manual-discovery-entry">
            手动输入服务器地址
          </Link>
        </section>
      </div>
    </main>
  );
}
