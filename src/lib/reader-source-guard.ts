// Legacy Reader launch/progress has no authoritative source lease yet. Keep a
// conservative reservation from the first host attempt through this runtime's
// lifetime, including awaits and unknown/late dispatch. No timeout releases it.
let legacyReaderAttempted = false;
export function markLegacyReaderAttempt(): void { legacyReaderAttempted = true; }
export function hasLegacyReaderAttempt(): boolean { return legacyReaderAttempted; }
