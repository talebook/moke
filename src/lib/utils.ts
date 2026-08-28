import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function resolveServerAssetUrl(serverUrl: string, assetUrl?: string) {
  if (!assetUrl) return '';
  // Offline covers are stored as data URLs. Some servers label image bytes as
  // application/octet-stream, so preserve every data URL just as AuthImage does.
  if (/^(?:https?:\/\/|data:|blob:)/i.test(assetUrl)) return assetUrl;
  if (assetUrl.startsWith('/')) return `${serverUrl}${assetUrl}`;
  return `${serverUrl}/${assetUrl}`;
}
