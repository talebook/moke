import { loadSavedServers, saveAuthorizedServer, type SaveServerResult } from '../saved-server-api.ts';
import { SavedServerAdmissionRejected, type SavedServerWriteAuthorization } from '../saved-server-repository.ts';
import type { DiscoveryAdapter, DiscoverySelection } from './types.ts';

// Native guarantees these failures precede any authoritative rename. Unknown
// transport/IO failures must remain unknown and go through repository reload.
const UNWRITTEN = new Set(['candidate_unavailable', 'admission_expired',
  'storage_conflict', 'invalid_payload', 'invalid_admission',
  'stopped', 'unsupported', 'forbidden', 'invalid_session', 'admission_busy', 'backend_failure', 'network_changed']);
const codeOf = (error: unknown) => error && typeof error === 'object' && 'code' in error
  ? String(error.code) : 'admission_unavailable';

interface SaveFacade {
  loadSavedServers: typeof loadSavedServers;
  saveAuthorizedServer: typeof saveAuthorizedServer;
}

/** No HTTP, activation or UI-minted authority. The facade's last write is
 * replaced by the native guarded CAS, after its queue/backups/awaits. */
export function createDiscoverySaveAdapter(adapter: DiscoveryAdapter,
  facade: SaveFacade = { loadSavedServers, saveAuthorizedServer }) {
  return async (selected: DiscoverySelection, isCurrent: () => boolean, signal: AbortSignal): Promise<SaveServerResult> => {
    const selection = { ...selected };
    const current = () => !signal.aborted && isCurrent();
    let saving = false;
    if (!adapter.admit || !adapter.commit) return { ok: false, outcome: 'admission-rejected', code: 'unsupported' };
    try {
      // Load/migration is separate from candidate authorization. Never start
      // implicit registry creation inside a discovered save's guarded commit.
      const loaded = await facade.loadSavedServers();
      if (!loaded.ok) return loaded;
      if (!current()) throw new SavedServerAdmissionRejected('cancelled');
      const admitted = await adapter.admit(selection);
      if (!current()) throw new SavedServerAdmissionRejected('cancelled');
      if (admitted.baseUrl !== selection.baseUrl || !admitted.admissionId || typeof admitted.name !== 'string') {
        throw new SavedServerAdmissionRejected('invalid_admission');
      }
      const { admissionId, baseUrl, name } = admitted;
      const commit = adapter.commit.bind(adapter);
      const authorization: SavedServerWriteAuthorization = {
        baseUrl,
        async commit(value, expectedRaw) {
          if (!current()) throw new SavedServerAdmissionRejected('cancelled');
          try { await commit(selection.sessionId, admissionId, expectedRaw, value); }
          catch (error) {
            const code = codeOf(error);
            if (UNWRITTEN.has(code)) throw new SavedServerAdmissionRejected(code);
            // A disconnected IPC reply may hide a completed rename. Never
            // convert it to a safe-to-retry admission failure.
            throw error;
          }
        },
      };
      saving = true;
      return await facade.saveAuthorizedServer({ rawBaseUrl: baseUrl, displayName: name }, authorization);
    } catch (error) {
      if (saving && !(error instanceof SavedServerAdmissionRejected)) {
        return { ok: false, outcome: 'storage-failure', code: 'write-rejected', persistence: 'unknown', reloadRequired: true };
      }
      return { ok: false, outcome: 'admission-rejected', code: error instanceof SavedServerAdmissionRejected ? error.code : codeOf(error) };
    }
  };
}
