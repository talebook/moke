// Legacy Reader launch/progress has no authoritative source lease yet. Keep a
// conservative reservation from the first host attempt through this runtime's
// lifetime, including awaits and unknown/late dispatch. No timeout releases it.
let legacyReaderAttempted = false;
export function markLegacyReaderAttempt(): void { legacyReaderAttempted = true; }
export function hasLegacyReaderAttempt(): boolean { return legacyReaderAttempted; }

/** Host reservation precedes async work which could dispatch a Reader later. */
export async function reserveLegacyReaderAttempt(): Promise<void> {
  markLegacyReaderAttempt();
  if (process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri') {
    const { invoke } = await import('@tauri-apps/api/core');
    // This stage grants connection authority only on Linux. Other targets
    // retain their existing Reader path without adding platform permissions.
    const platform = await invoke<string>('moke_runtime_platform');
    if (platform === 'linux') await invoke('moke_connection_mark_reader');
  }
}
