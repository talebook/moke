import { create } from 'zustand';
import { copyTextToClipboard } from '../clipboard.ts';

// ponytail: state machine mirrors cc-haha but without DesktopHost abstraction
// (Moke is Tauri-only). Proxy settings skipped — add when LAN users need them.

type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'restarting'
  | 'error';

// GitHub 上每次发版都会上传安卓 APK / OHOS HAP / 桌面安装包。
// 移动端（android/ios/ohos）没有内置 updater（@tauri-apps/plugin-updater
// 官方不支持移动端），检查更新时提示用户去浏览器手动下载。
// 注意：tauri-plugin-opener 的 openUrl 在移动端走 open crate 的 unix 分支
//（依赖 xdg-open/gio 等），Android/OHOS 上都不存在这些命令，因此无法调起
// 系统浏览器——这里改为复制下载链接让用户自己粘贴打开。
const RELEASE_URL = 'https://github.com/talebook/moke/releases/latest';

const DISMISSED_KEY = 'moke-dismissed-update-version';

function readDismissed(): string | null {
  try { return localStorage.getItem(DISMISSED_KEY); } catch { return null; }
}
function writeDismissed(v: string | null) {
  try { v ? localStorage.setItem(DISMISSED_KEY, v) : localStorage.removeItem(DISMISSED_KEY); } catch { /* noop */ }
}

function parseVersion(v: string | null | undefined): [number, number, number] | null {
  const m = v?.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) as [number, number, number] : null;
}

function isNewer(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return true; // can't parse → assume newer
  for (let i = 0; i < 3; i++) {
    const d = pa[i]! - pb[i]!;
    if (d !== 0) return d > 0;
  }
  return false; // equal
}

interface UpdateStore {
  status: UpdateStatus;
  availableVersion: string | null;
  releaseNotes: string | null;
  progressPercent: number;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
  checkedAt: number | null;
  shouldPrompt: boolean;
  /** null 表示尚未检测；mobile = 无内置 updater，走跳转 release 流程 */
  platform: 'desktop' | 'mobile' | null;

  initialize: () => Promise<void>;
  checkForUpdates: () => Promise<void>;
  installUpdate: () => Promise<void>;
  copyReleaseUrl: () => Promise<void>;
  dismissPrompt: () => void;
  simulateUpdate: () => Promise<void>;
}

type UpdaterMod = typeof import('@tauri-apps/plugin-updater');
type ProcessMod = typeof import('@tauri-apps/plugin-process');
type UpdateObj = NonNullable<Awaited<ReturnType<UpdaterMod['check']>>>;

export interface UpdateStoreDependencies {
  importUpdater: () => Promise<UpdaterMod | null>;
  importProcess: () => Promise<ProcessMod | null>;
  resolvePlatform: () => Promise<'desktop' | 'mobile'>;
  sleep: (delayMs: number) => Promise<void>;
}

async function importUpdater(): Promise<UpdaterMod | null> {
  try { return await import('@tauri-apps/plugin-updater'); } catch { return null; }
}

async function importProcess(): Promise<ProcessMod | null> {
  try { return await import('@tauri-apps/plugin-process'); } catch { return null; }
}

// NEXT_PUBLIC_APP_PLATFORM 无法区分桌面与 OHOS/安卓（都是 'tauri'），
// 需要运行时平台检测来判定是否有内置 updater。
async function resolvePlatform(): Promise<'desktop' | 'mobile'> {
  try {
    const { resolveRuntimeCategory } = await import('@/lib/moke-reader');
    return await resolveRuntimeCategory();
  } catch {
    // 模块加载失败时按桌面处理（兼容旧后端）。
    return 'desktop';
  }
}

const defaultDependencies: UpdateStoreDependencies = {
  importUpdater,
  importProcess,
  resolvePlatform,
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
};

export function createUpdateStore(overrides: Partial<UpdateStoreDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  // ponytail: flag to skip real Tauri APIs when simulating
  let fake = false;
  let pending: UpdateObj | null = null;
  let downloading = false;
  let downloaded = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let startupDone = false;
  let checkInFlight: Promise<void> | null = null;

  return create<UpdateStore>((set, get) => ({
  status: 'idle',
  availableVersion: null,
  releaseNotes: null,
  progressPercent: 0,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
  checkedAt: null,
  shouldPrompt: false,
  platform: null,

  initialize: async () => {
    if (startupDone || process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') return;
    // Claim initialization before platform detection so concurrent mounts cannot
    // schedule more than one automatic update check.
    startupDone = true;

    // OHOS/移动端单 WebView 构建里没有注册 updater 插件，且 plugin-updater
    // 官方不支持移动端，需要运行时平台检测区分。
    const runtimePlatform = await dependencies.resolvePlatform();
    set({ platform: runtimePlatform });

    // 移动端不自动检查（避免启动即弹浏览器），由用户在设置页点击跳转 release。
    if (runtimePlatform === 'mobile') return;

    await dependencies.sleep(5000);
    try { await get().checkForUpdates(); } catch { /* silent */ }
  },

  checkForUpdates: () => {
    if (checkInFlight) return checkInFlight;

    // Defer the implementation to a microtask so checkInFlight is assigned
    // before platform detection or any other asynchronous work can begin.
    const flight = Promise.resolve().then(async () => {
      // 平台未缓存时先检测（initialize 尚未完成时点击也能正确跳转）。
      let platform = get().platform;
      if (!platform) {
        platform = await dependencies.resolvePlatform();
        set({ platform });
      }
      // 移动端：没有内置 updater，复制下载链接让用户去浏览器手动下载。
      if (platform === 'mobile') {
        await get().copyReleaseUrl();
        return;
      }

      const updater = await dependencies.importUpdater();
      if (!updater) return;
      if (downloading) return;

      set({ status: 'checking', error: null });

      try {
        // Close previous pending update
        if (pending) {
          try { await pending.close(); } catch { /* best effort */ }
          pending = null;
          downloaded = false;
        }

        const update = await updater.check();
        if (!update) {
          writeDismissed(null);
          set({
            status: 'up-to-date',
            availableVersion: null,
            releaseNotes: null,
            checkedAt: Date.now(),
            error: null,
            shouldPrompt: false,
          });
          return;
        }

        // Ignore if not newer than current
        const current = update.currentVersion;
        if (current && !isNewer(update.version, current)) {
          try { await update.close(); } catch { /* best effort */ }
          writeDismissed(null);
          set({
            status: 'up-to-date',
            availableVersion: null,
            releaseNotes: null,
            checkedAt: Date.now(),
            error: null,
            shouldPrompt: false,
          });
          return;
        }

        pending = update;

        // Already dismissed this version → don't prompt, don't download
        if (readDismissed() === update.version) {
          set({
            status: 'available',
            availableVersion: update.version,
            releaseNotes: update.body ?? null,
            checkedAt: Date.now(),
            error: null,
            shouldPrompt: false,
          });
          return;
        }

        set({
          status: 'available',
          availableVersion: update.version,
          releaseNotes: update.body ?? null,
          checkedAt: Date.now(),
          error: null,
          shouldPrompt: false,
        });

        // Auto-download (don't install yet — user decides when to restart)
        downloading = true;
        set({ status: 'downloading', progressPercent: 0, downloadedBytes: 0, totalBytes: null });

        let contentLength: number | null = null;
        let bytesDownloaded = 0;

        try {
          await update.download((event) => {
            switch (event.event) {
              case 'Started':
                contentLength = event.data.contentLength ?? null;
                set({ totalBytes: contentLength });
                break;
              case 'Progress': {
                bytesDownloaded += event.data.chunkLength;
                const nextBytes = bytesDownloaded;
                const nextPercent = contentLength
                  ? Math.min(Math.round((nextBytes / contentLength) * 100), 100)
                  : 0;
                // Keep shared progress monotonic if callbacks arrive out of order.
                set((current) => ({
                  downloadedBytes: Math.max(current.downloadedBytes, nextBytes),
                  progressPercent: Math.max(current.progressPercent, nextPercent),
                }));
                break;
              }
              case 'Finished':
                set({ progressPercent: 100 });
                break;
            }
          });

          downloaded = true;
          set({
            status: 'downloaded',
            progressPercent: 100,
            shouldPrompt: true,
            error: null,
          });
        } catch (e) {
          set({
            status: 'available',
            error: e instanceof Error ? e.message : String(e),
            shouldPrompt: true,
          });
        } finally {
          downloading = false;
        }
      } catch (e) {
        set({
          status: 'error',
          error: e instanceof Error ? e.message : String(e),
          checkedAt: Date.now(),
        });
      }
    }).finally(() => {
      if (checkInFlight === flight) checkInFlight = null;
    });

    checkInFlight = flight;
    return flight;
  },

  installUpdate: async () => {
    // 平台未缓存时先检测，避免移动端误走内置 updater。
    let platform = get().platform;
    if (!platform) {
      platform = await dependencies.resolvePlatform();
      set({ platform });
    }
    // 移动端：复制下载链接，由用户去浏览器手动下载安装（没有内置安装流程）。
    if (platform === 'mobile') {
      await get().copyReleaseUrl();
      return;
    }

    // ponytail: fake update skips real Tauri calls, just simulates restart
    if (fake) {
      writeDismissed(null);
      set({ status: 'installing', shouldPrompt: false });
      await new Promise((r) => setTimeout(r, 1000));
      set({ status: 'restarting' });

      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        set({ status: 'downloaded', error: '重启未能自动启动（模拟），请手动重启应用以完成更新。', shouldPrompt: true });
      }, 15_000);

      // Don't actually relaunch — restore after 3s for re-testing
      await new Promise((r) => setTimeout(r, 3000));
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      fake = false;
      set({ status: 'idle', availableVersion: null, releaseNotes: null, shouldPrompt: false, error: null, progressPercent: 0, checkedAt: null });
      (await import('@/lib/toast')).useToast.getState().show('虚假更新流程已走完，状态已重置。', 'info');
      return;
    }

    const updater = await dependencies.importUpdater();
    const process = await dependencies.importProcess();
    if (!updater || !process) return;

    if (!pending) {
      await get().checkForUpdates();
      if (!pending) return;
    }

    try {
      // Download if not yet downloaded
      if (!downloaded) {
        downloading = true;
        set({ status: 'downloading', progressPercent: 0, downloadedBytes: 0, totalBytes: null });

        let contentLength: number | null = null;
        let bytesDownloaded = 0;

        await pending.download((event) => {
          switch (event.event) {
            case 'Started':
              contentLength = event.data.contentLength ?? null;
              set({ totalBytes: contentLength });
              break;
            case 'Progress': {
              bytesDownloaded += event.data.chunkLength;
              const nextBytes = bytesDownloaded;
              const nextPercent = contentLength
                ? Math.min(Math.round((nextBytes / contentLength) * 100), 100)
                : 0;
              // Keep shared progress monotonic if callbacks arrive out of order.
              set((current) => ({
                downloadedBytes: Math.max(current.downloadedBytes, nextBytes),
                progressPercent: Math.max(current.progressPercent, nextPercent),
              }));
              break;
            }
            case 'Finished':
              set({ progressPercent: 100 });
              break;
          }
        });

        downloading = false;
        downloaded = true;
      }

      writeDismissed(null);

      set({ status: 'installing', shouldPrompt: false, error: null });

      await pending.install();

      set({ status: 'restarting', progressPercent: 100 });

      // Watchdog: if still here after 15s, relaunch didn't work
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        set({
          status: 'downloaded',
          error: '重启未能自动启动，请手动重启应用以完成更新。',
          shouldPrompt: true,
        });
      }, 15_000);

      await process.relaunch();
    } catch (e) {
      downloading = false;
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      set({
        status: downloaded ? 'downloaded' : 'available',
        error: e instanceof Error ? e.message : String(e),
        shouldPrompt: true,
      });
    }
  },

  copyReleaseUrl: async () => {
    const copied = await copyTextToClipboard(RELEASE_URL);
    const toast = (await import('@/lib/toast')).useToast.getState();
    if (copied) {
      toast.show('已复制下载链接，请在浏览器中打开并下载安装。', 'info');
    } else {
      toast.show(`复制失败，请手动访问 ${RELEASE_URL}`, 'error');
    }
  },

  dismissPrompt: () => {
    writeDismissed(get().availableVersion);
    set({ shouldPrompt: false });
  },

  simulateUpdate: async () => {
    fake = true;
    writeDismissed(null);

    set({ status: 'checking', error: null });
    await new Promise((r) => setTimeout(r, 800));

    set({ status: 'available', availableVersion: 'v9.9.9-test', releaseNotes: '🧪 虚假更新测试\n\n这个更新是假的，用于验证更新流程的 UI 交互是否正常。', checkedAt: Date.now(), error: null });
    await new Promise((r) => setTimeout(r, 600));

    set({ status: 'downloading', progressPercent: 0, downloadedBytes: 0, totalBytes: 1024 * 1024 * 50 });
    for (let p = 0; p <= 100; p += 10) {
      await new Promise((r) => setTimeout(r, 250));
      set({ progressPercent: p, downloadedBytes: (1024 * 1024 * 50) * p / 100 });
    }

    set({ status: 'downloaded', progressPercent: 100, shouldPrompt: true });
  },
  }));
}

export const useUpdateStore = createUpdateStore();
