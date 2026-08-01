import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

// ArkWeb may expose localStorage but reject access for the tauri:// custom
// scheme. Zustand otherwise treats storage as unavailable and skips hydration
// entirely, leaving the app on its initial loading screen forever. Keep the
// store usable in that case; persistence resumes automatically on platforms
// where localStorage is available.
const safeLocalStorage: StateStorage = {
  getItem: (name) => {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(name, value);
    } catch {
      // Keep the in-memory Zustand state working when storage is unavailable.
    }
  },
  removeItem: (name) => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(name);
    } catch {
      // Nothing to remove when storage is unavailable.
    }
  },
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
  readingStateApi: boolean;
  readingProgressApi: boolean;
  readingStatsApi: boolean;
  networkSourcesApi: boolean;
  checkedAt: number | null;
  version: string;
}

export const DEFAULT_SERVER_CAPABILITIES: ServerCapabilities = {
  shelfApi: false,
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

export const useServerStore = create<ServerState>()(
  persist(
    (set) => ({
      serverUrl: '',
      serverTitle: '',
      capabilities: DEFAULT_SERVER_CAPABILITIES,
      protocol: 'http',
      host: '',
      port: '8080',
      hasHydrated: false,
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
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    }
  )
);
