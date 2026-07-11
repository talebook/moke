import { create } from 'zustand';

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

  initialize: () => Promise<void>;
  checkForUpdates: () => Promise<void>;
  installUpdate: () => Promise<void>;
  dismissPrompt: () => void;
  simulateUpdate: () => Promise<void>;
}

// ponytail: flag to skip real Tauri APIs when simulating
let fake = false;

type UpdaterMod = typeof import('@tauri-apps/plugin-updater');
type ProcessMod = typeof import('@tauri-apps/plugin-process');
type UpdateObj = NonNullable<Awaited<ReturnType<UpdaterMod['check']>>>;

let pending: UpdateObj | null = null;
let downloading = false;
let downloaded = false;
let watchdog: ReturnType<typeof setTimeout> | null = null;
let startupDone = false;

async function importUpdater(): Promise<UpdaterMod | null> {
  try { return await import('@tauri-apps/plugin-updater'); } catch { return null; }
}

async function importProcess(): Promise<ProcessMod | null> {
  try { return await import('@tauri-apps/plugin-process'); } catch { return null; }
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  status: 'idle',
  availableVersion: null,
  releaseNotes: null,
  progressPercent: 0,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
  checkedAt: null,
  shouldPrompt: false,

  initialize: async () => {
    if (startupDone || process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') return;
    startupDone = true;

    await new Promise((r) => setTimeout(r, 5000));
    try { await get().checkForUpdates(); } catch { /* silent */ }
  },

  checkForUpdates: async () => {
    const updater = await importUpdater();
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
            case 'Progress':
              bytesDownloaded += event.data.chunkLength;
              set({
                downloadedBytes: bytesDownloaded,
                progressPercent: contentLength
                  ? Math.min(Math.round((bytesDownloaded / contentLength) * 100), 100)
                  : 0,
              });
              break;
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
  },

  installUpdate: async () => {
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

    const updater = await importUpdater();
    const process = await importProcess();
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
            case 'Progress':
              bytesDownloaded += event.data.chunkLength;
              set({
                downloadedBytes: bytesDownloaded,
                progressPercent: contentLength
                  ? Math.min(Math.round((bytesDownloaded / contentLength) * 100), 100)
                  : 0,
              });
              break;
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
