import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerRegistryRepository, SERVER_STORAGE_KEY, serializeServerRegistry, emptyRegistry } from '../src/lib/server-registry.ts';

const malformedAddresses = [
  'http://a.example.test\tb.example.test', 'books.exa\nmple.test:8080', 'https://books.example.test:\r8443/',
  'http://boo\u00a0ks.test', 'http://boo\u007fks.test',
];

function storage(initial) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values, writes,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { writes.push(key); values.set(key, value); },
  };
}

test('legacy migration skips embedded whitespace without rewriting or losing the original address bytes', async () => {
  for (const url of malformedAddresses) {
    const original = `  ${JSON.stringify({ version: 0, state: { serverUrl: url } })}\n`;
    const disk = storage({ [SERVER_STORAGE_KEY]: original });
    const repository = new ServerRegistryRepository(disk);
    const loaded = await repository.load();
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.value, emptyRegistry());
    assert.match(loaded.notice, /旧服务器地址无效.*已跳过.*原数据已保留/);
    assert.equal(disk.values.get(SERVER_STORAGE_KEY), original);
    assert.deepEqual(disk.writes, []);

    const replacement = { savedServers: [{ id: 'nas', url: 'http://nas:8080', title: 'LAN', addedAt: '' }] };
    assert.equal((await repository.save(replacement)).ok, true);
    const backup = [...disk.values].find(([key]) => key.startsWith(`${SERVER_STORAGE_KEY}-damaged-backup-`));
    assert.equal(backup[1], original);
    assert.ok(disk.writes.indexOf(backup[0]) < disk.writes.indexOf(SERVER_STORAGE_KEY));
    assert.equal(disk.values.get(SERVER_STORAGE_KEY), serializeServerRegistry(replacement));
  }
});

test('compatibility-only migration skips embedded controls and backs up exact bytes before explicit save', async () => {
  for (const original of malformedAddresses) {
    const disk = storage({ moke_server_url: original });
    const repository = new ServerRegistryRepository(disk);
    const loaded = await repository.load();
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.value, emptyRegistry());
    assert.match(loaded.notice, /旧服务器地址无效.*已跳过/);
    assert.equal(disk.values.has(SERVER_STORAGE_KEY), false);
    assert.equal(disk.values.get('moke_server_url'), original);
    assert.deepEqual(disk.writes, []);
    assert.equal((await repository.save(emptyRegistry())).ok, true);
    const backup = [...disk.values].find(([key]) => key.startsWith(`${SERVER_STORAGE_KEY}-damaged-legacy-url-backup-`));
    assert.equal(backup[1], original);
    assert.ok(disk.writes.indexOf(backup[0]) < disk.writes.indexOf(SERVER_STORAGE_KEY));
  }
});

test('v1 lists skip each malformed entry, keep trimmed LAN hosts usable and preserve the source before later save', async () => {
  const lan = { id: 'nas', url: 'http://nas:8080', title: 'LAN', addedAt: '' };
  const original = JSON.stringify({ version: 1, state: { savedServers: [
    ...malformedAddresses.map((url, index) => ({ id: `malformed-${index}`, url })),
    { ...lan, url: ' \n nas:8080/ \t' },
  ] } });
  const disk = storage({ [SERVER_STORAGE_KEY]: original });
  const repository = new ServerRegistryRepository(disk);
  const loaded = await repository.load();
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.value.savedServers, [lan]);
  assert.match(loaded.notice, /有 5 条.*已跳过.*原数据已保留/);
  assert.equal(disk.values.get(SERVER_STORAGE_KEY), original);
  assert.deepEqual(disk.writes, []);

  assert.equal((await repository.save(loaded.value)).ok, true);
  const backup = [...disk.values].find(([key]) => key.startsWith(`${SERVER_STORAGE_KEY}-damaged-backup-`));
  assert.equal(backup[1], original);
  assert.ok(disk.writes.indexOf(backup[0]) < disk.writes.indexOf(SERVER_STORAGE_KEY));
  const restarted = await new ServerRegistryRepository(disk).load();
  assert.deepEqual(restarted.value.savedServers, [lan]);
  assert.equal(restarted.notice, undefined);
});
