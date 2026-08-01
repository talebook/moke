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

async function navigateSingleWebview(href: string, fallback: (href: string) => void): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('moke_navigate', { path: href });
  } catch (error) {
    console.warn('Falling back to client-side reader navigation:', error);
    fallback(href);
  }
}

export async function openEmbeddedReaderHome({
  eink,
  navigate,
}: {
  eink: boolean;
  navigate: (href: string) => void;
}): Promise<void> {
  const href = `/readest/${eink ? '?moke=1&mokeEink=1' : '?moke=1&mokeEink=0'}`;

  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') {
    navigate(href);
    return;
  }

  const currentPlatform = await getMokeRuntimePlatform();

  if (isSingleWebviewRuntime(currentPlatform)) {
    await navigateSingleWebview(href, navigate);
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
}: {
  filePath: string;
  eink: boolean;
  mokeBookId: string;
  restoreProgress: ReadingProgressPayload | null;
}): string {
  const params = new URLSearchParams({
    file: filePath,
    moke: '1',
    mokeEink: eink ? '1' : '0',
    mokeBookId,
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
  await navigateSingleWebview(href, navigate);
}
