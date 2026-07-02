'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { useExtensionStore } from '@/lib/store/extensions';

function ViewContent() {
  const searchParams = useSearchParams();
  const name = searchParams.get('name') ?? '';
  const [uiUrl, setUiUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!name) {
      setError('未指定拓展名称');
      return;
    }

    const isTauri = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';
    if (!isTauri) {
      setError('拓展系统仅在桌面端可用');
      return;
    }

    const loadUi = () => {
      const { extensions, loaded } = useExtensionStore.getState();
      if (!loaded) {
        const unsub = useExtensionStore.subscribe((s) => {
          if (s.loaded) { unsub(); loadUi(); }
        });
        return;
      }
      const ext = extensions.find((e) => e.name === name);
      if (ext?.enabled && ext.hasUi && ext.port > 0) {
        setUiUrl(`http://127.0.0.1:${ext.port}`);
      } else if (ext && !ext.enabled) {
        setError(`拓展 "${ext.displayName}" 未启用`);
      } else if (ext && !ext.hasUi) {
        setError(`拓展 "${ext.displayName}" 没有前端界面`);
      } else {
        setError(`拓展 "${name}" 未找到`);
      }
    };

    loadUi();
  }, [name]);

  return (
    <DesktopLayout>
      <div className="flex-1 min-h-0 flex flex-col">
        {error ? (
          <div className="flex items-center justify-center py-20">
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
        ) : uiUrl ? (
          <iframe
            src={uiUrl}
            sandbox="allow-scripts allow-forms allow-same-origin"
            className="flex-1 w-full border-0"
            title={`拓展: ${name}`}
          />
        ) : (
          <div className="flex items-center justify-center py-20">
            <p className="text-sm text-muted-foreground">加载中...</p>
          </div>
        )}
      </div>
    </DesktopLayout>
  );
}

export default function ExtensionViewPage() {
  return (
    <Suspense fallback={<DesktopLayout><div className="flex-1 min-h-0 flex items-center justify-center"><p className="text-sm text-muted-foreground">加载中...</p></div></DesktopLayout>}>
      <ViewContent />
    </Suspense>
  );
}
