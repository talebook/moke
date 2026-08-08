import type { ReadingProgressPayload } from './reading-progress';

export const isSingleWebviewRuntime = (platform: string): boolean =>
  platform === 'ohos' || platform === 'android' || platform === 'ios';

export async function getMokeRuntimePlatform(): Promise<string> {
  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') return 'web';

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string>('moke_runtime_platform');
  } catch {
    // Compatibility fallback for an older desktop backend.
    const { platform } = await import('@tauri-apps/plugin-os');
    return await platform();
  }
}

/**
 * Full-document navigation for single-WebView runtimes (OHOS/Android/iOS).
 *
 * ArkWeb cannot reliably execute Next.js App Router RSC navigation over the
 * custom `tauri://` scheme, and URL params across pages are unreliable there
 * (see the welcome page). Landing redirects that run right after hydration are
 * the likeliest to get stuck on a blank screen, so they go through the native
 * `moke_navigate` command instead of `router.replace`. On any other platform
 * (or if the native command is unavailable), fall back to the client router.
 */
export async function navigateFullDocument(
  href: string,
  fallback: (href: string) => void,
): Promise<void> {
  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') {
    fallback(href);
    return;
  }
  let currentPlatform: string;
  try {
    currentPlatform = await getMokeRuntimePlatform();
  } catch (error) {
    // If the runtime probe fails (e.g. IPC unavailable in dev mode), never
    // block navigation — fall through to the client router.
    console.warn('Unable to detect runtime platform, using router navigation:', error);
    fallback(href);
    return;
  }
  if (!isSingleWebviewRuntime(currentPlatform)) {
    fallback(href);
    return;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('moke_navigate', { path: href });
  } catch (error) {
    console.warn('Falling back to client-side navigation:', error);
    fallback(href);
  }
}

export async function openEmbeddedReaderHome({
  eink,
  serverUrl,
  navigate,
}: {
  eink: boolean;
  serverUrl: string;
  navigate: (href: string) => void;
}): Promise<void> {
  const params = new URLSearchParams({
    moke: '1',
    mokeEink: eink ? '1' : '0',
    mokeServerUrl: serverUrl,
  });
  const href = `/readest/?${params.toString()}`;

  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') {
    navigate(href);
    return;
  }

  const currentPlatform = await getMokeRuntimePlatform();

  if (isSingleWebviewRuntime(currentPlatform)) {
    await navigateFullDocument(href, navigate);
    return;
  }

  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const label = `reader-${Date.now()}`;
    const readerWindow = new WebviewWindow(label, {
      url: href,
      title: 'Readest',
      width: 1280,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      resizable: true,
      focus: true,
    });

    await new Promise<void>((resolve, reject) => {
      readerWindow.once('tauri://created', () => resolve());
      readerWindow.once('tauri://error', (event) => {
        reject(new Error(String(event.payload || 'Failed to create reader window')));
      });
    });
  } catch (error) {
    console.warn('Falling back to current-window embedded reader navigation:', error);
    navigate(href);
  }
}

export function buildEmbeddedReaderUrl({
  filePath,
  eink,
  mokeBookId,
  restoreProgress,
  serverUrl,
}: {
  filePath: string;
  eink: boolean;
  mokeBookId: string;
  restoreProgress: ReadingProgressPayload | null;
  serverUrl: string;
}): string {
  const params = new URLSearchParams({
    file: filePath,
    moke: '1',
    mokeEink: eink ? '1' : '0',
    mokeBookId,
    mokeServerUrl: serverUrl,
  });

  if (restoreProgress) {
    params.set('mokeRestoreProgress', JSON.stringify(restoreProgress));
  }

  return `/readest/reader?${params.toString()}`;
}

export async function openEmbeddedReaderBook(
  href: string,
  navigate: (href: string) => void,
): Promise<void> {
  await navigateFullDocument(href, navigate);
}
