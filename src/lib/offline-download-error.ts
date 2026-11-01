import type { AppPlatform } from './api-core.ts';
import { isLoginRequiredError } from './auth-navigation.ts';

/** Snapshots may retain an Error, its message, or an older String(error). */
function storedErrorMessage(error: unknown): string {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return message.replace(/^(?:Error|MokeApiError|TypeError|DOMException):\s*/, '');
}

/** Map known failures to product text; never display arbitrary response bodies. */
export function offlineDownloadErrorMessage(error: unknown, platform: AppPlatform): string {
  const message = storedErrorMessage(error);
  const details = error && typeof error === 'object'
    ? error as { code?: unknown; status?: unknown }
    : {};
  const code = typeof details.code === 'string' ? details.code : message;
  if (isLoginRequiredError(error) || code === 'user.need_login' || code === 'online.auth_required'
    || code === 'http.401' || message === '请先登录') {
    return '下载需要登录，请登录后重试。';
  }

  switch (code) {
    case 'book.download.in_progress':
      return '该书籍正在下载中，请稍候。';
    case 'book.download.paused':
    case '应用上次异常退出，可继续下载':
      return '下载已暂停，可在下载管理中继续。';
    case 'book.download.cancelled':
      return '下载已取消。';
    case 'book.download.invalid_response':
      return '下载失败：服务器返回的内容不是有效书籍，请检查书库响应后重试。';
    case 'book.mobi.invalid':
      return '下载失败：MOBI/AZW 文件格式异常，请重新下载；若仍失败，请检查书库中的原文件。';
    case 'book.epub.invalid':
      return '下载失败：服务端返回的 EPUB 文件不完整或格式错误，请重新上传该书。';
    case 'book.download.transfer_failed':
      return platform === 'tauri'
        ? '下载中断：接收文件内容时连接断开，可在下载管理中继续。'
        : '下载中断：接收文件内容时连接断开，请重试。';
    case 'book.download.incomplete':
      return platform === 'tauri'
        ? '下载中断：文件内容接收不完整，可在下载管理中继续。'
        : '下载中断：文件内容接收不完整，请重试。';
    case 'book.download.range.invalid':
      return '下载失败：服务器返回的断点续传信息异常，请重试。';
    case 'book.download.storage_failed':
    case 'Failed to save book to file system':
      return '下载失败：无法保存到本地，请检查存储空间或权限。';
  }

  const httpStatus = code.match(/^http\.([1-5]\d{2})$/)?.[1];
  const status = httpStatus ? Number(httpStatus) : details.status;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
    return `下载失败，服务器返回 ${status}。`;
  }
  return platform === 'web'
    ? '下载失败：当前浏览器模式下可能被跨域策略拦截。桌面版会走 Tauri 原生下载通道。'
    : '下载失败，请检查服务器连接或登录状态后重试。';
}
