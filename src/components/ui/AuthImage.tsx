'use client';

import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react';
import { fetchImageObjectUrl } from '@/lib/api';

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
 *   会 401。因此改用 fetchImageObjectUrl 走带认证的 tauriFetch 拉取后转 blob URL。
 */
export function AuthImage({ src, fallback, alt = '', ...imgProps }: AuthImageProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const currentObjectUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!isTauriApp || !src) return;

    let cancelled = false;
    setFailed(false);

    fetchImageObjectUrl(src)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        // 释放上一张
        if (currentObjectUrl.current) URL.revokeObjectURL(currentObjectUrl.current);
        currentObjectUrl.current = url;
        setObjectUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [src]);

  // 组件卸载时释放最后一张 blob
  useEffect(() => {
    return () => {
      if (currentObjectUrl.current) URL.revokeObjectURL(currentObjectUrl.current);
    };
  }, []);

  // Web 端：直接用原生 <img>（同源自动带 cookie）
  if (!isTauriApp) {
    if (!src || failed) return <>{fallback ?? null}</>;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} onError={() => setFailed(true)} {...imgProps} />;
  }

  // Tauri 端
  if (failed || !src) return <>{fallback ?? null}</>;
  if (!objectUrl) return <>{fallback ?? null}</>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={objectUrl} alt={alt} {...imgProps} />;
}
