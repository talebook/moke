import type { ReadingProgressPayload } from './reading-progress';

export const isSingleWebviewRuntime = (platform: string): boolean =>
  platform === 'ohos' || platform === 'android' || platform === 'ios';

export const requiresMokeNavigate = (platform: string): boolean =>
  platform === 'ohos' || platform === 'android';

/**
 * Android/iOS render the main WebView edge-to-edge, so Moke's controls need
 * the top safe-area inset. Android multi-window and OHOS already keep the
 * WebView below the status bar and must not receive a second offset.
 */
export const shouldApplyTopSafeArea = (
  platform: string,
  isMultiWindow = false,
): boolean =>
  (platform === 'android' && !isMultiWindow) || platform === 'ios';

type RuntimeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface AndroidSystemUIBridge {
  showStatusBar?: (darkMode: boolean) => void;
}

interface SystemUIVisibilityResponse {
  success: boolean;
  error?: string;
}

/**
 * Restore the system status bar while the Moke shell is active. Android uses
 * a Moke-owned bridge so restoring the top bar does not also change the
 * navigation bar; iOS uses the existing native-bridge command. Readest has a
 * separate frontend and keeps ownership of its own immersive/fullscreen UI.
 */
export async function showMokeSystemStatusBar(
  platform: string,
  darkMode: boolean,
  androidBridge?: AndroidSystemUIBridge,
  invokeOverride?: RuntimeInvoke,
): Promise<boolean> {
  if (platform === 'android') {
    if (!androidBridge?.showStatusBar) return false;
    androidBridge.showStatusBar(darkMode);
    return true;
  }
  if (platform !== 'ios') return false;

  const invoke = invokeOverride ?? (await import('@tauri-apps/api/core')).invoke;
  const response = await invoke<SystemUIVisibilityResponse>(
    'plugin:native-bridge|set_system_ui_visibility',
    { payload: { visible: true, darkMode } },
  );
  if (!response.success) {
    throw new Error(response.error || 'Unable to show the iOS status bar');
  }
  return true;
}

interface StatusBarHeightResponse {
  height: number;
  error?: string;
}

interface SafeAreaInsetsResponse {
  top: number;
  error?: string;
}

/**
 * Read the top inset from the native bridge instead of relying only on CSS
 * env(safe-area-inset-top). Some Android WebView versions report that CSS env
 * value as 0 during a cold start. Android returns physical pixels, while the
 * iOS safe-area command already returns logical pixels.
 */
export async function getNativeTopSafeAreaInset(
  platform: string,
  devicePixelRatio = 1,
  invokeOverride?: RuntimeInvoke,
  isMultiWindow = false,
): Promise<number> {
  if (!shouldApplyTopSafeArea(platform, isMultiWindow)) return 0;

  const invoke = invokeOverride ?? (await import('@tauri-apps/api/core')).invoke;
  if (platform === 'android') {
    const response = await invoke<StatusBarHeightResponse>(
      'plugin:native-bridge|get_status_bar_height',
    );
    if (response.error) throw new Error(response.error);
    const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
    const height = response.height / ratio;
    return Number.isFinite(height) && height > 0 ? height : 0;
  }

  const response = await invoke<SafeAreaInsetsResponse>(
    'plugin:native-bridge|get_safe_area_insets',
  );
  if (response.error) throw new Error(response.error);
  return Number.isFinite(response.top) && response.top > 0 ? response.top : 0;
}

/**
 * Whether the reader itself must save progress to the server (and therefore the
 * embedded reader URL should carry `mokeServerUrl`).
 *
 * Single-WebView runtimes (OHOS/Android/iOS) and the web build replace the host
 * app, so there is no main-window ReaderProgressProvider to save for them.
 * Desktop keeps the old behavior — the reader-home window gets no serverUrl and
 * the main window's ReaderProgressProvider is the single saver.
 */
export const shouldIncludeServerUrl = (isTauri: boolean, platform: string): boolean =>
  !isTauri || isSingleWebviewRuntime(platform);

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

/** Full-document navigation is restricted to routes inside this app origin. */
export function isSafeAppNavigationPath(href: string): boolean {
  return href.startsWith('/') && !href.startsWith('//');
}

/**
 * Full-document navigation for single-WebView runtimes (OHOS/Android/iOS).
 *
 * ArkWeb cannot reliably execute Next.js App Router RSC navigation over the
 * custom `tauri://` scheme, and URL params across pages are unreliable there
 * (see the welcome page). OHOS and Android therefore use the narrowly
 * registered native `moke_navigate` command. Android WebView can otherwise
 * leave the bundled reader on a blank document when browser navigation crosses
 * between the separate Moke and Readest Next apps. iOS can use the browser
 * navigation API.
 */
export async function navigateFullDocument(
  href: string,
  fallback: (href: string) => void,
  platformOverride?: string,
): Promise<void> {
  if (!isSafeAppNavigationPath(href)) {
    console.warn('Refusing unsafe full-document navigation:', href);
    return;
  }
  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') {
    fallback(href);
    return;
  }
  let currentPlatform: string;
  if (platformOverride) {
    currentPlatform = platformOverride;
  } else {
    try {
      currentPlatform = await getMokeRuntimePlatform();
    } catch (error) {
      // If the runtime probe fails (e.g. IPC unavailable in dev mode), never
      // block navigation — fall through to the client router.
      console.warn('Unable to detect runtime platform, using router navigation:', error);
      fallback(href);
      return;
    }
  }
  if (!isSingleWebviewRuntime(currentPlatform)) {
    fallback(href);
    return;
  }
  if (!requiresMokeNavigate(currentPlatform)) {
    // Crossing app boundaries intentionally discards the current shell state;
    // the launch URL carries all context the embedded reader needs.
    try {
      window.location.assign(href);
    } catch (error) {
      console.warn('Full-document navigation failed, using router navigation:', error);
      fallback(href);
    }
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

/**
 * Only carry mokeServerUrl when non-empty: a bare `mokeServerUrl=` param would
 * be treated by readest as "server configured" when it only checks for the
 * param's presence. Shared by both embedded-reader URL builders.
 */
function setServerUrlParam(
  params: URLSearchParams,
  serverUrl?: string,
  allowInvalidCertificate = false,
): void {
  if (serverUrl) {
    params.set('mokeServerUrl', serverUrl);
    try {
      if (allowInvalidCertificate && new URL(serverUrl).protocol === 'https:') {
        params.set('mokeAllowInvalidCertificate', '1');
      }
    } catch {
      // The caller's existing URL validation owns malformed server errors.
    }
  }
}

export function buildEmbeddedReaderHomeUrl({
  eink,
  debugPanel = false,
  serverUrl,
  allowInvalidCertificate = false,
}: {
  eink: boolean;
  debugPanel?: boolean;
  serverUrl?: string;
  allowInvalidCertificate?: boolean;
}): string {
  const params = new URLSearchParams({
    moke: '1',
    mokeEink: eink ? '1' : '0',
    mokeDebug: debugPanel ? '1' : '0',
  });

  setServerUrlParam(params, serverUrl, allowInvalidCertificate);

  return `/readest/?${params.toString()}`;
}

interface ReaderHomeWindowEvent {
  payload?: unknown;
}

interface ReaderHomeWindow {
  once(
    event: 'tauri://created' | 'tauri://error',
    handler: (event: ReaderHomeWindowEvent) => void,
  ): unknown;
}

interface ReaderHomeWindowOptions {
  url: string;
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  resizable: boolean;
  focus: boolean;
}

export type ReaderHomeWindowFactory = (
  label: string,
  options: ReaderHomeWindowOptions,
) => ReaderHomeWindow;

export async function openEmbeddedReaderHome({
  eink,
  debugPanel = false,
  serverUrl,
  allowInvalidCertificate = false,
  navigate,
  platformOverride,
  windowFactory,
}: {
  eink: boolean;
  debugPanel?: boolean;
  serverUrl?: string;
  allowInvalidCertificate?: boolean;
  navigate: (href: string) => void;
  platformOverride?: string;
  windowFactory?: ReaderHomeWindowFactory;
}): Promise<void> {
  const isTauri = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';

  let currentPlatform = 'web';
  let probeFailed = false;
  if (isTauri) {
    if (platformOverride) {
      currentPlatform = platformOverride;
    } else {
      try {
        currentPlatform = await getMokeRuntimePlatform();
      } catch (error) {
        // A failed probe must not block opening the reader. Fall back to the
        // desktop window flow (on single-WebView runtimes window creation fails
        // and we degrade to in-place navigation, which is the right flow there).
        console.warn('Unable to detect runtime platform, assuming desktop reader window flow:', error);
        currentPlatform = 'desktop';
        probeFailed = true;
      }
    }
  }

  const singleWebview = isSingleWebviewRuntime(currentPlatform);

  // Only pass mokeServerUrl where the reader must save progress itself:
  // single-WebView runtimes (OHOS/Android/iOS) and the web build replace the
  // host app, so there is no main-window ReaderProgressProvider to save for
  // them (mokeBridge would otherwise POST a second, duplicate write on every
  // page:changed). Desktop keeps the old behavior — the reader-home window gets
  // no serverUrl and the main window's ReaderProgressProvider is the single
  // saver. That is safe for the desktop built-in library: it does not read
  // mokeServerUrl at all — server browsing (shelf/library/search/detail) is
  // served by the main window, and the reader-home window is only a reading
  // container.
  //
  // Trade-off on probe failure: keep mokeServerUrl. A single-WebView runtime
  // that fails the probe (its main-window ReaderProgressProvider is already
  // unloaded) would otherwise silently lose progress saving — worse than an
  // occasional duplicate save on desktop.
  const includeServerUrl =
    (isTauri && probeFailed) || shouldIncludeServerUrl(isTauri, currentPlatform);

  const readerHref = buildEmbeddedReaderHomeUrl({
    eink,
    debugPanel,
    serverUrl: includeServerUrl ? serverUrl : undefined,
    allowInvalidCertificate: includeServerUrl && allowInvalidCertificate,
  });

  if (!isTauri) {
    navigate(readerHref);
    return;
  }

  if (singleWebview) {
    // Reuse the platform already probed above instead of probing again inside
    // navigateFullDocument (each probe is a Rust IPC call).
    await navigateFullDocument(readerHref, navigate, currentPlatform);
    return;
  }

  try {
    let createWindow = windowFactory;
    if (!createWindow) {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      createWindow = (label, options) => new WebviewWindow(label, options);
    }
    // 书库首页窗口不代表阅读器，不能落入扩展的 `reader-*` 枚举（H20-L4）。
    const label = buildReaderHomeWindowLabel();
    const readerWindow = createWindow(label, {
      url: readerHref,
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
    // The main-window ReaderProgressProvider is unmounted by this navigation,
    // so the reader must take over progress saving in the fallback path.
    navigate(buildEmbeddedReaderHomeUrl({
      eink,
      debugPanel,
      serverUrl,
      allowInvalidCertificate,
    }));
  }
}

export function buildEmbeddedReaderUrl({
  filePath,
  eink,
  debugPanel = false,
  mokeBookId,
  restoreProgress,
  serverUrl,
  allowInvalidCertificate = false,
}: {
  filePath: string;
  eink: boolean;
  debugPanel?: boolean;
  mokeBookId: string;
  restoreProgress: ReadingProgressPayload | null;
  serverUrl?: string;
  allowInvalidCertificate?: boolean;
}): string {
  const params = new URLSearchParams({
    file: filePath,
    moke: '1',
    mokeEink: eink ? '1' : '0',
    mokeDebug: debugPanel ? '1' : '0',
    mokeBookId,
    mokeReturnTo: '/library',
  });

  setServerUrlParam(params, serverUrl, allowInvalidCertificate);

  if (restoreProgress) {
    params.set('mokeRestoreProgress', JSON.stringify(restoreProgress));
  }

  return `/readest/reader?${params.toString()}`;
}

export async function openEmbeddedReaderBook(
  href: string,
  navigate: (href: string) => void,
  platformOverride?: string,
): Promise<void> {
  await navigateFullDocument(href, navigate, platformOverride);
}
