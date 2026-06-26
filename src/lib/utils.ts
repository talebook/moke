import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function resolveServerAssetUrl(serverUrl: string, assetUrl?: string) {
  if (!assetUrl) return '';
  if (/^https?:\/\//i.test(assetUrl)) return assetUrl;
  if (assetUrl.startsWith('/')) return `${serverUrl}${assetUrl}`;
  return `${serverUrl}/${assetUrl}`;
}
