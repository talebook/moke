import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const commands = ['start', 'snapshot', 'stop'].map((action) => `moke_discovery_${action}`);

test('discovery commands are declared and granted only to the main host', () => {
  const build = read('src-tauri/build.rs');
  const handler = read('src-tauri/src/lib.rs');
  const capabilities = new URL('../src-tauri/capabilities/', import.meta.url);
  for (const command of commands) {
    assert.ok(build.includes(`"${command}"`));
    assert.ok(handler.includes(`discovery::${command}`));
    const permission = `allow-${command.replaceAll('_', '-')}`;
    for (const file of readdirSync(capabilities).filter((file) => file.endsWith('.json'))) {
      const capability = JSON.parse(read(`src-tauri/capabilities/${file}`));
      const granted = capability.permissions.some((entry) => (typeof entry === 'string' ? entry : entry.identifier) === permission);
      assert.equal(granted, file === 'default.json', `${file}: ${permission}`);
      if (granted) {
        assert.deepEqual(capability.windows, ['main']);
        assert.equal(capability.remote, undefined);
      }
    }
  }
});

test('discovery IPC requires a join document and never accepts service types or addresses', () => {
  const ipc = read('src-tauri/src/discovery.rs');
  assert.match(ipc, /webview\.label\(\) != "main"/);
  assert.match(ipc, /super::require_moke_shell\(webview\)/);
  assert.match(ipc, /matches!\(path, "\/join" \| "\/join\/" \| "\/join\.html"\)/);
  assert.match(ipc, /id\.get_version_num\(\) == 4/);
  assert.match(ipc, /current\.id == session_id/);
  assert.equal((ipc.match(/require_owner\(&webview, &session_id, true\)/g) || []).length, 2);
  assert.match(ipc, /require_owner\(&webview, &session_id, false\)/);
  assert.doesNotMatch(ipc, /server_url:\s*String|service_type:\s*String|reqwest|plugin_http|set_server/);
});
