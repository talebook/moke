'use client';

import { useEffect, useState, type ImgHTMLAttributes } from 'react';
import { acquireImageObjectUrl, getCachedImageObjectUrl, releaseImageObjectUrl } from '@/lib/api';
import { useServerStore } from '@/lib/store/server';

const isTauriApp = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';

interface AuthImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  /** 完整的图片 URL（已通过 resolveServerAssetUrl 拼好） */
  src: string;
  /** 加载失败时渲染的回退内容（如占位封面） */
  fallback?: React.ReactNode;
}

/**
 * 带认证的图片组件。
 *
 * - Web 端：服务器与前端同源，cookie 会自动随 <img> 发送，直接用原生 <img>。
 * - Tauri 端：前端在 tauri:// 协议下，与 http(s):// 服务器跨源，<img> 不会带 session，
 *   会 401。因此改用 acquireImageObjectUrl 走带认证的 tauriFetch 拉取后转 blob URL。
 *
 * object URL 由 api.ts 中的缓存托管：同一 URL 跨组件/跨页面复用且并发去重，
 * 组件卸载时 release（而不是 revoke），仍在别处使用的缓存不会被误释放。
 */
export function AuthImage({ src, fallback, alt = '', ...imgProps }: AuthImageProps) {
  const sessionRevision = useServerStore((state) => isTauriApp ? state.sessionRevision : 0);
  const [loadedImage, setLoadedImage] = useState<{ src: string; sessionRevision: number; objectUrl: string } | null>(() => {
    const objectUrl = isTauriApp ? getCachedImageObjectUrl(src, sessionRevision) : null;
    return objectUrl ? { src, sessionRevision, objectUrl } : null;
  });
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  useEffect(() => {
    // 重新访问曾经失败的 src 时允许重试；失败和已加载状态都按 src 区分，
    // 避免换源后的第一帧显示上一张封面。
    setFailedSrc(null);
    if (!isTauriApp || !src || /^(blob:|data:)/i.test(src)) return;

    let cancelled = false;

    // 已缓存时同步命中，避免回退占位闪一下。
    const cached = getCachedImageObjectUrl(src, sessionRevision);
    if (cached) setLoadedImage({ src, sessionRevision, objectUrl: cached });

    acquireImageObjectUrl(src, sessionRevision)
      .then((url) => {
        if (!cancelled) setLoadedImage({ src, sessionRevision, objectUrl: url });
      })
      .catch(() => {
        if (!cancelled) setFailedSrc(src);
      });

    return () => {
      cancelled = true;
      releaseImageObjectUrl(src, sessionRevision);
    };
  }, [src, sessionRevision]);

  // Web 端：直接用原生 <img>（同源自动带 cookie）
  if (!isTauriApp || /^(blob:|data:)/i.test(src)) {
    if (!src || failedSrc === src) return <>{fallback ?? null}</>;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} onError={() => setFailedSrc(src)} {...imgProps} />;
  }

  // Tauri 端
  if (failedSrc === src || !src) return <>{fallback ?? null}</>;
  const objectUrl = loadedImage?.src === src && loadedImage.sessionRevision === sessionRevision
    ? loadedImage.objectUrl
    : getCachedImageObjectUrl(src, sessionRevision);
  if (!objectUrl) return <>{fallback ?? null}</>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={objectUrl} alt={alt} {...imgProps} />;
}
