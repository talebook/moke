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

export type RuntimeCategory = 'desktop' | 'mobile';

/**
 * 运行时平台分类：单 WebView 运行时（OHOS/Android/iOS）→ 'mobile'，其余 → 'desktop'。
 *
 * 与 `getMokeRuntimePlatform` 不同，这里在 `moke_runtime_platform` 不可用时
 * 直接按 mobile 判定。原因：plugin-os 在 OHOS 上会报 "linux"（Rust target_os
 * = linux），`isSingleWebviewRuntime('linux')` 为 false，降级结果会误判为桌面，
 * 进而去调用未注册的 updater 插件导致检查更新静默失败。而单 WebView 移动构建
 * 必定注册 `moke_runtime_platform`，invoke 失败只可能是旧桌面后端或 IPC 异常，
 * 此时按 mobile 走"复制下载链接"流程是最安全的兜底。
 */
export async function resolveRuntimeCategory(): Promise<RuntimeCategory> {
  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') return 'desktop';
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return runtimeCategoryFromPlatform(await invoke<string>('moke_runtime_platform'));
  } catch {
    return 'mobile';
  }
}

export function runtimeCategoryFromPlatform(platform: string): RuntimeCategory {
  return isSingleWebviewRuntime(platform) ? 'mobile' : 'desktop';
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

/**
 * 桌面 reader-home（书库首页）窗口的 label。
 * 不能落入扩展的 `reader-*` 枚举（H20-L4）：该书库窗口不代表阅读器，
 * 扩展不应把它当作阅读器寻址/列出来。
 */
export function buildReaderHomeWindowLabel(timestamp: number = Date.now()): string {
  return `moke-home-${timestamp}`;
}

export function buildEmbeddedReaderHomeUrl({
  eink,
  serverUrl,
  includeServerUrl,
}: {
  eink: boolean;
  serverUrl: string;
  includeServerUrl: boolean;
}): string {
  const params = new URLSearchParams({
    moke: '1',
    mokeEink: eink ? '1' : '0',
  });

  if (includeServerUrl) {
    params.set('mokeServerUrl', serverUrl);
  }

  return `/readest/?${params.toString()}`;
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
  const isTauri = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';

  let currentPlatform = 'web';
  if (isTauri) {
    currentPlatform = await getMokeRuntimePlatform();
  }

  const singleWebview = isSingleWebviewRuntime(currentPlatform);

  // Only pass mokeServerUrl where the reader must save progress itself: single-
  // WebView runtimes (OHOS/Android/iOS) and the web build replace the host app,
  // so there is no main-window ReaderProgressProvider to save for them. Desktop
  // keeps the old behavior — the reader-home window gets no serverUrl and the
  // main window's ReaderProgressProvider is the single saver (mokeBridge would
  // otherwise POST a second, duplicate write on every page:changed).
  const href = buildEmbeddedReaderHomeUrl({
    eink,
    serverUrl,
    includeServerUrl: !isTauri || singleWebview,
  });

  if (!isTauri) {
    navigate(href);
    return;
  }

  if (singleWebview) {
    await navigateFullDocument(href, navigate);
    return;
  }

  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    // 书库首页窗口不代表阅读器，不能落入扩展的 `reader-*` 枚举（H20-L4）。
    const label = buildReaderHomeWindowLabel();
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
