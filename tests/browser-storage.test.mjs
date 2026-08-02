import test from 'node:test';
import assert from 'node:assert/strict';

import {
  safeGetStorageItem,
  safeRemoveStorageItem,
  safeSetStorageItem,
} from '../src/lib/browser-storage.ts';

test('storage helpers tolerate ArkWeb access errors', () => {
  const deniedStorage = {
    getItem() {
      throw new DOMException('Access denied', 'SecurityError');
    },
    setItem() {
      throw new DOMException('Access denied', 'SecurityError');
    },
    removeItem() {
      throw new DOMException('Access denied', 'SecurityError');
    },
  };

  assert.equal(safeGetStorageItem(deniedStorage, 'key'), null);
  assert.doesNotThrow(() => safeSetStorageItem(deniedStorage, 'key', 'value'));
  assert.doesNotThrow(() => safeRemoveStorageItem(deniedStorage, 'key'));
});

test('storage helpers preserve normal browser storage behavior', () => {
  const values = new Map();
  const storage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, value),
    removeItem: (name) => values.delete(name),
  };

  safeSetStorageItem(storage, 'key', 'value');
  assert.equal(safeGetStorageItem(storage, 'key'), 'value');
  safeRemoveStorageItem(storage, 'key');
  assert.equal(safeGetStorageItem(storage, 'key'), null);
});
