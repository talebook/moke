/**
 * 跨平台复制文本：优先 Clipboard API，失败回退到 execCommand。
 *
 * 不用 @tauri-apps/plugin-clipboard-manager——它被 readest 的 cfg 排除在
 * OHOS 之外（见 readest lib.rs 的 clipboard-manager 注册），动态 import 会失败。
 *
 * 成功返回 true；两端都失败返回 false（调用方决定如何兜底提示）。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof text !== 'string') return false;

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // WebView/旧环境可能无剪贴板权限，回退到 execCommand
    }
  }

  if (typeof document !== 'undefined') {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  }

  return false;
}
