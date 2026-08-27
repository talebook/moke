'use client';

import { useEffect, useState, type ImgHTMLAttributes } from 'react';
import { fetchImageObjectUrl } from '@/lib/api';
import { useServerStore } from '@/lib/store/server';

interface AuthImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  /** 图片 URL；相对地址始终以当前书库地址为基准解析。 */
  src: string;
  /** 加载失败时渲染的回退内容（如占位封面） */
  fallback?: React.ReactNode;
  /** 明确允许无凭据加载公网 CDN / 网络书源封面。 */
  allowPublicCrossOrigin?: boolean;
}

/**
 * 带认证的图片组件。
 *
 * 所有平台都先通过安全加载器做协议、来源、重定向、大小和像素限制，再把经过
 * 校验的字节转成 object URL。只有书库同源请求可以携带 session；跨源必须由
 * 调用点显式允许且始终匿名。
 */
export function AuthImage({
  src,
  fallback,
  allowPublicCrossOrigin = false,
  alt = '',
  onError,
  ...imgProps
}: AuthImageProps) {
  const serverUrl = useServerStore((state) => state.serverUrl);
  const loadKey = `${serverUrl}\n${allowPublicCrossOrigin ? 'public' : 'same'}\n${src}`;
  const [loaded, setLoaded] = useState<{ key: string; objectUrl: string } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (!serverUrl || !src) return;

    let disposed = false;
    let ownedObjectUrl: string | null = null;

    fetchImageObjectUrl(src, { serverUrl, allowPublicCrossOrigin })
      .then((url) => {
        if (disposed) {
          URL.revokeObjectURL(url);
          return;
        }
        ownedObjectUrl = url;
        setLoaded({ key: loadKey, objectUrl: url });
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });

    return () => {
      disposed = true;
      if (ownedObjectUrl) URL.revokeObjectURL(ownedObjectUrl);
    };
  }, [allowPublicCrossOrigin, loadKey, serverUrl, src]);

  if (failed || !src || loaded?.key !== loadKey) return <>{fallback ?? null}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={loaded.objectUrl}
      alt={alt}
      onError={(event) => {
        URL.revokeObjectURL(loaded.objectUrl);
        setLoaded(null);
        setFailed(true);
        onError?.(event);
      }}
      {...imgProps}
    />
  );
}
