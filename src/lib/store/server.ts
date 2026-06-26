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

interface ServerState {
  serverUrl: string;
  serverTitle: string;
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
  setHasHydrated: (hydrated: boolean) => void;
  logout: () => void;
  disconnect: () => void;
}

export const useServerStore = create<ServerState>()(
  persist(
    (set) => ({
      serverUrl: '',
      serverTitle: '',
      protocol: 'http',
      host: '',
      port: '8080',
      hasHydrated: false,
      isConnected: false,
      token: '',
      user: null,
      setServer: (protocol, host, port) => {
        const url = `${protocol}://${host}${port ? `:${port}` : ''}`;
        set({ serverUrl: url, protocol, host, port, isConnected: true, token: '', user: null });
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
      setHasHydrated: (hasHydrated) => {
        set({ hasHydrated });
      },
      logout: () => {
        set((state) => ({ isConnected: Boolean(state.serverUrl), token: '', user: null }));
      },
      disconnect: () => {
        set({ serverUrl: '', serverTitle: '', protocol: 'http', host: '', port: '8080', isConnected: false, token: '', user: null });
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
