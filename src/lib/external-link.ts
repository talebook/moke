import type { MouseEvent } from 'react';

const isTauriApp = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';

/**
 * Open a URL outside the app.
 *
 * In Tauri the system browser must be used: the shell plugin injects a body
 * click handler that turns `target="_blank"` links into `plugin:shell|open`,
 * which the main window does not grant, and a WebView window is not a browser
 * tab anyway. The opener plugin is scoped to http(s)/mailto/tel URLs by its
 * `default` permission set.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauriApp) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
      return;
    } catch {
      // Fall through to the WebView's own handling.
    }
  }
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Click handler for external links: a plain left click is routed through
 * {@link openExternalUrl}, while modifier clicks keep the browser defaults.
 */
export function externalLinkClick(url: string) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void openExternalUrl(url);
  };
}
