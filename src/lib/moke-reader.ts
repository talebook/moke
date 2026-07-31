import type { ReadingProgressPayload } from './reading-progress';

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

  const { platform } = await import('@tauri-apps/plugin-os');
  const currentPlatform = await platform();

  if (currentPlatform === 'android' || currentPlatform === 'ios') {
    navigate(href);
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
