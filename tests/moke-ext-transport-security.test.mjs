import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('extension SDK and example never expose the host session token to browser UI', () => {
  const browserFacingSources = [
    'packages/moke-ext/src/commands/init.js',
    'packages/moke-ext/src/commands/dev.js',
    'packages/moke-ext/examples/reading-stats/backend/src/main.rs',
    'packages/moke-ext/examples/reading-stats/ui/index.html',
  ];

  for (const path of browserFacingSources) {
    const source = read(path);
    assert.doesNotMatch(source, /\/api\/token/, `${path} must not expose a token route`);
    assert.doesNotMatch(
      source,
      /Access-Control-Allow-Origin[^\n]*["']\*["']/,
      `${path} must not grant wildcard CORS`,
    );
  }

  const exampleBackend = read('packages/moke-ext/examples/reading-stats/backend/src/main.rs');
  assert.match(exampleBackend, /env::var\("MOKE_EXT_TOKEN"\)/);
  assert.match(exampleBackend, /ws_client_loop\(stats, ws_port, token, ext_name\)/);
});

test('host transport uses session ports and concrete validated CORS origins', () => {
  const extensionRuntime = read('src-tauri/src/extensions/mod.rs');
  assert.match(extensionRuntime, /const API_SERVER_PORT: u16 = 0;/);
  assert.match(extensionRuntime, /const WS_SERVER_PORT: u16 = 0;/);

  const apiServer = read('src-tauri/src/extensions/api_server.rs');
  assert.doesNotMatch(apiServer, /Access-Control-Allow-Origin"[^\n]*"\*"/);
  assert.match(apiServer, /Access-Control-Allow-Origin", origin/);
  const authCall = apiServer.indexOf('authenticate(&ctx');
  const bodyReadCall = apiServer.indexOf('read_request_body(&mut request)');
  assert.ok(authCall < bodyReadCall, 'authentication must precede request body reads');
  const earlyBodyLimit = apiServer.lastIndexOf('validate_body_length(&request)', authCall);
  assert.ok(
    earlyBodyLimit >= 0 && earlyBodyLimit < authCall,
    'declared oversized bodies must be rejected before authentication',
  );
  assert.match(apiServer, /MAX_CONCURRENT_REQUESTS/);
  assert.match(apiServer, /MAX_REQUEST_BODY_BYTES/);

  const events = read('src-tauri/src/extensions/events.rs');
  assert.match(events, /accept_hdr_with_config/);
  assert.match(events, /security::validate_origin/);
  assert.match(events, /expected_authority\(actual_port\)/);
  assert.match(events, /MAX_WS_CLIENTS/);
  assert.match(events, /MAX_WS_MESSAGE_BYTES/);
});

test('runtime persistence stores enablement metadata but no token field', () => {
  const lifecycle = read('src-tauri/src/extensions/lifecycle.rs');
  const persisted = lifecycle.match(/struct PersistedExtension \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.doesNotMatch(persisted, /token/);
  // Token rotation, actual file permissions, legacy migration and replacement
  // failure are exercised by the Rust lifecycle tests.
});
