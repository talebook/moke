import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getDebugPanelLaunchState,
  useDeveloperStore,
} from '../src/lib/store/developer.ts';

const storage = (value) => ({
  getItem(key) {
    assert.equal(key, 'moke-developer-storage');
    return value;
  },
});

test('embedded reader launch uses the current in-memory debug switch', () => {
  useDeveloperStore.setState({ showDebugPanel: true });
  assert.equal(getDebugPanelLaunchState(storage(null)), true);
  useDeveloperStore.setState({ showDebugPanel: false });
});

test('embedded reader launch recovers a persisted true during hydration', () => {
  useDeveloperStore.setState({ showDebugPanel: false });
  const persisted = JSON.stringify({
    state: { unlocked: true, enabled: true, showDebugPanel: true },
    version: 0,
  });
  assert.equal(getDebugPanelLaunchState(storage(persisted)), true);
});

test('embedded reader launch stays disabled for false or malformed persisted state', () => {
  useDeveloperStore.setState({ showDebugPanel: false });
  assert.equal(
    getDebugPanelLaunchState(
      storage(JSON.stringify({ state: { showDebugPanel: false }, version: 0 })),
    ),
    false,
  );
  assert.equal(getDebugPanelLaunchState(storage('{broken')), false);
});
