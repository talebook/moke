import type { DiscoveryAdapter, DiscoverySnapshot } from './types.ts';

type NativeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const invokeNative: NativeInvoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
};

/** Loading this module never loads Tauri or starts discovery. Only page entry does. */
export function createNativeDiscoveryAdapter(invoke: NativeInvoke = invokeNative): DiscoveryAdapter {
  const startedSessions = new Set<string>();
  return {
    async start(sessionId) {
      // OS plugin reports OHOS as Linux. The app-owned runtime command is the
      // authority; incomplete platforms must not even invoke discovery IPC.
      const platform = await invoke<string>('moke_runtime_platform');
      if (platform !== 'windows' && platform !== 'linux') {
        throw { code: 'unsupported', message: 'Automatic discovery is unavailable on this platform' };
      }
      startedSessions.add(sessionId);
      return invoke('moke_discovery_start', { sessionId });
    },
    snapshot: (sessionId) => invoke<DiscoverySnapshot>('moke_discovery_snapshot', { sessionId }),
    async stop(sessionId) {
      if (!startedSessions.has(sessionId)) return;
      await invoke('moke_discovery_stop', { sessionId });
      startedSessions.delete(sessionId);
    },
  };
}
