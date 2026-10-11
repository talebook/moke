import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServerStore } from '../src/lib/store/server.ts';
import { ServerRegistryRepository, SERVER_STORAGE_KEY } from '../src/lib/server-registry.ts';
import { registerReaderProgressFlush } from '../src/lib/reader-source.ts';

const source = readFileSync(
  fileURLToPath(new URL('../src/app/settings/page.tsx', import.meta.url)),
  'utf8',
);

test('设置页在离线书库区域进入 Moke 离线模式，不再打开 Readest 首页', () => {
  const offlineSection = source.indexOf('title="离线书库"');
  const appSection = source.indexOf('title="应用"');
  const offlineAction = source.indexOf('label="进入离线模式"');
  assert.ok(offlineSection >= 0);
  assert.ok(offlineAction > offlineSection && offlineAction < appSection);
  assert.match(source, /await enterOfflineMode\(\);\s*router\.push\('\/shelf'\)/);
  assert.match(source, /<SettingsSection title="连接与数据"/);
  assert.match(source, /offlineMode\s*\?\s*\(\s*<ActionRow\s+icon=\{PlugZap\}\s+label="服务器列表"/);
  assert.doesNotMatch(source, /leaveOfflineMode\(\);\s*router\.push\('\/welcome'\)/);
  assert.match(source, /!offlineMode\s*&&\s*<ActionRow\s+icon=\{BookOpen\}\s+label="进入离线模式"/);
  assert.doesNotMatch(source, /返回离线书架/);
  assert.doesNotMatch(source, /openEmbeddedReaderHome|打开内嵌阅读器/);
});

function runtimeFixture(extraFields = {}) {
  const savedServer = { id: 'fixture-server', url: 'https://books.test', title: 'Moke 测试书库', addedAt: '' };
  const disk = new Map([[SERVER_STORAGE_KEY, JSON.stringify({ version: 1, state: { savedServers: [savedServer], ...extraFields } })]]);
  const repository = new ServerRegistryRepository({ getItem: key => disk.get(key) ?? null, setItem: (key, value) => { disk.set(key, value); } });
  return { disk, repository, store: createServerStore(repository), savedServer };
}

test('v1 冷启动只加载列表，忽略夹具里的在线/离线和能力快照', async () => {
  const { store, savedServer } = runtimeFixture({
    offlineMode: true, serverUrl: 'https://books.test', isConnected: true,
    user: { id: 1, username: 'reader' }, token: 'fixture-token',
    capabilities: { shelfApi: true, checkedAt: 123 },
  });
  await store.getState().loadServers();
  const loaded = store.getState();
  assert.deepEqual(loaded.savedServers, [savedServer]);
  assert.equal(loaded.offlineMode, false);
  assert.equal(loaded.serverUrl, '');
  assert.equal(loaded.isConnected, false);
  assert.equal(loaded.user, null);
  assert.equal(loaded.token, '');
  assert.equal(loaded.capabilities.shelfApi, false);
  assert.equal(loaded.capabilities.checkedAt, null);
});

test('运行时进入离线须等待 Reader 收尾，且新文档仍须重新明确进入', async () => {
  const { store, repository, disk } = runtimeFixture();
  await store.getState().loadServers();
  const before = disk.get(SERVER_STORAGE_KEY);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const remove = registerReaderProgressFlush(async () => { entered(); await gate; });
  try {
    const switching = store.getState().enterOfflineMode();
    await started;
    assert.equal(store.getState().offlineMode, false);
    release(); await switching;
    assert.equal(store.getState().offlineMode, true);
    assert.equal(store.getState().isConnected, false);
    assert.equal(store.getState().serverUrl, '');
    assert.equal(disk.get(SERVER_STORAGE_KEY), before);
    const cold = createServerStore(repository);
    await cold.getState().loadServers();
    assert.equal(cold.getState().offlineMode, false);
    assert.equal(cold.getState().isConnected, false);
    assert.equal(cold.getState().serverUrl, '');
    assert.deepEqual(cold.getState().savedServers, store.getState().savedServers);
  } finally { remove(); release(); }
});
