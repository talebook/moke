import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    }
  )
);
