import assert from 'node:assert/strict';
import { normalizeServerAddress } from '../../src/lib/server-url.ts';

// Fixture setup only seeds a saved identity. Runtime transitions still use the
// production candidate activation, including its Reader session reservation,
// cancellation guards, account reset and session/capability invalidation.
export async function connectSavedServerFixture(store, address) {
  const url = normalizeServerAddress(address);
  let server = store.getState().savedServers.find(entry => entry.url === url);
  if (!server) {
    server = {id:`fixture:${url}`,url,title:'',addedAt:''};
    store.setState({savedServers:[...store.getState().savedServers,server]});
  }
  const candidate = store.getState().beginConnection(server.id);
  assert.ok(candidate, 'the fixture must obey the live registry reservation');
  assert.equal(await store.getState().activateCandidate(candidate.requestId), true,
    'the fixture must activate through the production Reader session boundary');
  return server;
}
