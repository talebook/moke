import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import {
  safeGetLocalStorageItem,
  safeRemoveLocalStorageItem,
  safeSetLocalStorageItem,
} from '@/lib/browser-storage';

// ArkWeb may expose localStorage but reject access for the tauri:// custom
// scheme. Zustand otherwise treats storage as unavailable and skips hydration
// entirely, leaving the app on its initial loading screen forever. Keep the
// store usable in that case; persistence resumes automatically on platforms
// where localStorage is available.
const safeLocalStorage: StateStorage = {
  getItem: safeGetLocalStorageItem,
  setItem: safeSetLocalStorageItem,
  removeItem: safeRemoveLocalStorageItem,
};

export interface ReaderInfo {
  id: string | number;
  username: string;
  name: string;
  email: string;
  avatar: string;
  admin: boolean;
  permission: string;
}

export interface ServerCapabilities {
  shelfApi: boolean;
  annotationApi: boolean;
  readingStateApi: boolean;
  readingProgressApi: boolean;
  readingStatsApi: boolean;
  networkSourcesApi: boolean;
  checkedAt: number | null;
  version: string;
}

export const DEFAULT_SERVER_CAPABILITIES: ServerCapabilities = {
  shelfApi: false,
  annotationApi: false,
  readingStateApi: false,
  readingProgressApi: false,
  readingStatsApi: false,
  networkSourcesApi: false,
  checkedAt: null,
  version: '',
};

interface ServerState {
  serverUrl: string;
  serverTitle: string;
  capabilities: ServerCapabilities;
  protocol: 'http' | 'https';
  host: string;
  port: string;
  hasHydrated: boolean;
  isConnected: boolean;
  token: string;
  user: ReaderInfo | null;
  setServer: (protocol: 'http' | 'https', host: string, port: string) => void;
  setConnected: (token: string, user: ReaderInfo) => void;
  setUser: (user: ReaderInfo | null) => void;
  setServerTitle: (title: string) => void;
  setServerCapabilities: (capabilities: ServerCapabilities) => void;
  setHasHydrated: (hydrated: boolean) => void;
  logout: () => void;
  disconnect: () => void;
}

// ArkWeb 上 zustand persist 的异步 hydration 后置回调可能不触发
// （onRehydrateStorage 的 post-callback 丢失），导致 hasHydrated 卡在
// false、根页面无限转圈。因此：
// 1. 同步读取 localStorage 初始化 serverUrl（不依赖异步 hydration）；
// 2. hasHydrated 初始即为 true；
// 3. merge 时强制 hasHydrated: true，防止持久化的旧值覆盖。
function readPersistedServerUrl(): string {
  if (typeof window === 'undefined') return '';
  try {
    const raw = safeGetLocalStorageItem('moke-server-storage');
    if (!raw) return '';
    const parsed = JSON.parse(raw) as { state?: { serverUrl?: string } };
    return parsed?.state?.serverUrl || '';
  } catch {
    return '';
  }
}

export const useServerStore = create<ServerState>()(
  persist(
    (set) => ({
      serverUrl: readPersistedServerUrl(),
      serverTitle: '',
      capabilities: DEFAULT_SERVER_CAPABILITIES,
      protocol: 'http',
      host: '',
      port: '8080',
      hasHydrated: true,
      isConnected: false,
      token: '',
      user: null,
      setServer: (protocol, host, port) => {
        const url = `${protocol}://${host}${port ? `:${port}` : ''}`;
        set({ serverUrl: url, protocol, host, port, isConnected: true, token: '', user: null, capabilities: DEFAULT_SERVER_CAPABILITIES });
      },
      setConnected: (token, user) => {
        set({ isConnected: true, token, user });
      },
      setUser: (user) => {
        set((state) => ({ isConnected: Boolean(state.serverUrl), token: user ? state.token : '', user }));
      },
      setServerTitle: (serverTitle) => {
        set({ serverTitle });
      },
      setServerCapabilities: (capabilities) => {
        set({ capabilities });
      },
      setHasHydrated: (hasHydrated) => {
        set({ hasHydrated });
      },
      logout: () => {
        set((state) => ({ isConnected: Boolean(state.serverUrl), token: '', user: null }));
      },
      disconnect: () => {
        set({ serverUrl: '', serverTitle: '', capabilities: DEFAULT_SERVER_CAPABILITIES, protocol: 'http', host: '', port: '8080', isConnected: false, token: '', user: null });
      },
    }),
    {
      name: 'moke-server-storage',
      storage: createJSONStorage(() => safeLocalStorage),
      // 持久化数据里的 hasHydrated 可能被卡住时的旧状态污染（false），
      // merge 时强制为 true；其余字段仍按持久化值恢复。
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<ServerState>;
        const persistedCapabilities = persisted.capabilities as Partial<ServerCapabilities> | undefined;
        const hasAnnotationCapability = typeof persistedCapabilities?.annotationApi === 'boolean';
        return {
          ...currentState,
          ...persisted,
          capabilities: {
            ...currentState.capabilities,
            ...persistedCapabilities,
            // Older persisted stores predate annotationApi. Force one fresh
            // discovery instead of treating a missing field as unsupported.
            checkedAt: hasAnnotationCapability ? persistedCapabilities?.checkedAt ?? null : null,
          },
          hasHydrated: true,
        };
      },
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    }
  )
);

// OHOS ArkWeb 上 persist 的 `onRehydrateStorage` 后置回调可能不触发
// （postRehydrationCallback 丢失），导致 hasHydrated 卡在 false、根页面
// 无限转圈。用 persist 的 onFinishHydration 监听 + 超时兜底双保险，
// 确保 hasHydrated 一定会变为 true（此时 hydration 已完成，serverUrl
// 已从 localStorage 恢复）。
if (typeof window !== 'undefined') {
  useServerStore.persist.onFinishHydration(() => {
    useServerStore.getState().setHasHydrated(true);
  });
  window.setTimeout(() => {
    if (!useServerStore.getState().hasHydrated) {
      useServerStore.getState().setHasHydrated(true);
    }
  }, 600);
}
