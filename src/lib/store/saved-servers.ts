import { createStore } from 'zustand/vanilla';
import { SavedServerRepository, type LoadSavedServersResult, type SaveServerInput, type SaveServerResult } from '../saved-server-repository.ts';
import type { SavedServerRegistry } from '../saved-server-model.ts';

/** S1's list state is intentionally separate from the live connection store. */
export function createSavedServerStore(repository: SavedServerRepository) {
  let operations = 0;
  return createStore<{
    registry: SavedServerRegistry | null;
    busy: boolean;
    error: string | null;
    load(): Promise<LoadSavedServersResult>;
    saveServer(input: SaveServerInput): Promise<SaveServerResult>;
  }>()((set) => ({
    registry: null, busy: false, error: null,
    async load() {
      operations++;
      set({ busy: true });
      try {
        const result = await repository.load();
        set(result.ok ? { registry: repository.getSnapshot(), error: null } : { error: result.code });
        return result;
      } finally { set({ busy: --operations !== 0 }); }
    },
    async saveServer(input) {
      operations++;
      set({ busy: true });
      try {
        const result = await repository.saveServer(input);
        if (result.ok) set({ registry: repository.getSnapshot(), error: null });
        else set({ error: result.outcome === 'storage-failure' || result.outcome === 'needs-edit' ? result.code : result.outcome });
        return result;
      } finally { set({ busy: --operations !== 0 }); }
    },
  }));
}
