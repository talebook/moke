interface StorageLike {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

function browserLocalStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function safeGetStorageItem(storage: StorageLike | null, name: string): string | null {
  try {
    return storage?.getItem(name) ?? null;
  } catch {
    return null;
  }
}

export function safeSetStorageItem(storage: StorageLike | null, name: string, value: string): void {
  try {
    storage?.setItem(name, value);
  } catch {
    // ArkWeb can expose localStorage while rejecting access for custom schemes.
  }
}

export function safeRemoveStorageItem(storage: StorageLike | null, name: string): void {
  try {
    storage?.removeItem(name);
  } catch {
    // Storage cleanup must never turn a successful server action into an error.
  }
}

export const safeGetLocalStorageItem = (name: string) =>
  safeGetStorageItem(browserLocalStorage(), name);

export const safeSetLocalStorageItem = (name: string, value: string) =>
  safeSetStorageItem(browserLocalStorage(), name, value);

export const safeRemoveLocalStorageItem = (name: string) =>
  safeRemoveStorageItem(browserLocalStorage(), name);
