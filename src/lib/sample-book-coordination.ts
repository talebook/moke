const OPERATION_LOCK = 'moke-sample-book-operation';
const DELETION_GENERATION = 'moke-sample-book-deletion';

// Shared across same-origin WebViews/documents and automatically released
// when a document exits. Never hold it during the network fetch.
export function withSampleBookOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (!globalThis.navigator?.locks) {
    return Promise.reject(new Error('此环境不支持安全的多窗口示例书操作。'));
  }
  return navigator.locks.request(OPERATION_LOCK, operation);
}

export function sampleBookDeletionGeneration(): string {
  return localStorage.getItem(DELETION_GENERATION) || '';
}

export function invalidateSampleBookImports(): void {
  localStorage.setItem(DELETION_GENERATION, crypto.randomUUID());
}
