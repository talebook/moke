# Saved-server data layer (TB-272 / TB-293 S1)

This is an additive data layer on discovery dependency
`b472f0803e1a94be0764c8a246baacc647f15c2b` (#150). The new draft is temporarily
based on `agent/TB-446-lan-discovery`; the final destination remains public
`talebook/moke:main`. It does not update #148/#150 or the closed #139.

S1 does not wire the welcome/authentication pages, the disabled discovery add
button, or Reader. Existing single-server actions keep their current behavior.
Saving a prefix does not enable prefix connections or online reading.

## Public entry point

```ts
import { loadSavedServers, saveServer, getSavedServersSnapshot } from '@/lib/saved-server-api';

await loadSavedServers(); // explicit load, never auto-connect
const result = await saveServer({
  rawBaseUrl: 'https://books.example/team/books',
  displayName: 'Home library',
});
if (result.ok) {
  // Future UI focuses result.server.id; it must not connect here.
}
```

`saveServer` delegates through a dedicated Zustand list store to one serialized
repository. It never calls HTTP, DNS, discovery, authentication, live connection
setters, Reader, offline-file migration, or progress writers. The facade excludes
private originals from returned objects. All snapshots/results are detached.

Successful outcomes are `created`, `existing`, and `corrected`, with a stable
local `server.id` and `persisted: true`. Broadcast UUIDs do not supply that id.
An existing canonical address returns its original id without renaming it.
Same-origin `/a` and `/b` are distinct. Names are plain text, at most 128 Unicode
code points, with control characters and lone surrogates rejected. Names never
overwrite the server-reported title or change Host/SNI.

Explicit edits provide `target: { id, expectedEntryRevision }`. Missing/stale
targets return `entry-not-found` / `entry-changed`; equivalent distinct entries
return `collision`, never a silent merge. Retrying the immediately successful
edit with its original revision and same content returns `existing`, including
after reload. A changed URL clears the confirmed title and legacy aliases but
keeps flat edit history, original metadata, id and addedAt. It never relabels old
books, credentials, downloads or progress with the new address.

The repository accepts an authoritative `isEntryInUse` guard and rechecks it
after backup IO, along with storage/source fingerprints. Callers must hold the
source stable for the edit; these comparisons are not an inter-process/source
lock. The default facade conservatively rejects address changes with
`entry-in-use` until S2 supplies its actual Reader/candidate reservation. Pure
renames remain available. Dependency-injected data-layer consumers can provide
a real source guard; S1 does not guess from an empty native window enumeration.

Business failures return a discriminated result: `needs-edit`, `collision`,
`entry-in-use`, `entry-changed`, `entry-not-found`, or `storage-failure`.
The latter reports `persistence: unchanged | unknown` and `reloadRequired`.
No failure returns success, activates a connection, or clears authentication.

## Schema and rollback protection

The new authority is **schema 2**, key `moke-saved-servers-v2`:

```ts
{ version: 2, savedServers: SavedServer[], legacySources: { stateRaw, urlRaw } }
```

Each entry carries `id`, `entryRevision`, complete `url`, `status`
(`ready`, `needs-edit`, `collision`), `title`, `addedAt`, optional `displayName`,
`legacyAliases`, and `originals`. Originals preserve complete JSON metadata,
source/key, original position and raw address. Invalid non-string records and
damaged JSON documents remain represented; they are not filtered away. The raw
source strings are retained too. Unknown schema versions and inconsistent v2
statuses are refused, preserving bytes rather than overwriting them.

The active v0/v1 `moke-server-storage` and `moke_server_url` keys are never
rewritten. Known absolute root spellings alone receive narrow migration
compatibility (case/default port, historical boundary whitespace/trailing
slashes); new input uses #150's unique strict parser unchanged. No protocol,
missing prefix or unsafe path is guessed. IDNA/public/long manual addresses do
not inherit discovery's private-network/ASCII/200-byte restrictions.

Equivalent old rows are retained as explicit collisions with their own
metadata. Duplicate legacy ids are preserved in originals while a distinct
local id is assigned to the ambiguous row. An equivalent old single-server
mirror is an additional original/alias, not a second server. Migration is
written and read back once, making ids stable across subsequent loads.

Every save rereads the authority and exact legacy source bytes. A legacy client
changing its old configuration blocks the new writer instead of silently
reimporting or replacing the new list. S2 must coordinate ownership before
changing those keys. Browser/native authorities and conflicting native/browser
legacy records require explicit reconciliation; no fallback chooses one after
an IO failure. S1 does not implement destructive recovery or a collision merge.

Old clients may still change their old keys, but cannot understand or rewrite
the new v2 key. These source checks detect that situation; a version number
alone is not rollback protection. No source/TTL hint becomes a connection gate.
Saved entries survive broadcast disappearance without rediscovery, conversion,
another save, or address replacement. Later connections use the saved complete
address and their own necessary checks/authentication, not an old save ticket.

## Persistence and failure limits

Before a commit, the repository verifies current bytes and writes/verifies a
backup containing the exact previous authority and source originals. It checks
again before replacing the authority, verifies the complete result by readback,
and only then publishes it to memory. Backups have unique keys and are retained;
S1 does not automatically prune or restore them.

Browser storage is explicit localStorage IO: denied getters/quota/readback
errors are failures, never evidence of an empty list. Native uses
`AppConfig/server-registry/<key>.json`, bounded to 4 MiB UTF-8. It completes
short reads/writes, closes an exclusively created temporary file, then renames
it; cleanup only removes a temporary file actually created by that operation.
Legacy H native data at `AppData/books/.servers/moke-server-storage.json` is
read-only input. Native failures never fall back to browser memory/storage.

Original metadata can include old authentication fields. It is private
archival material, never copied into active login state or returned by the
public facade. Native registry/backup paths have command-scoped main-window
permissions, are outside books, and are denied by the asset protocol. Reader
permissions/gitlink are unchanged. This is not isolation from every Reader:
Android/iOS Reader and host share `main`, so their document inherits the host's
plugin-fs permissions; OHOS also already grants `main` broad AppConfig access.
Asset denial does not prevent plugin-fs reads. The legacy H archive remains
inside the already accessible books tree. Native integration must resolve this
shared-document access boundary before claiming private-original isolation.
These policy and injected IO tests do not prove real-device enforcement.

If replacement may have occurred but verification fails, the writer locks its
old snapshot and returns `unknown`. Another save returns `reload-required`.
Explicit reload reconciles the current authority; retrying the same canonical
address finds the already persisted id instead of creating another. Removal of
a previously loaded authority and mismatched legacy fingerprints fail closed.

There is no cross-window/process CAS, file-to-IDB transaction or forced
termination of a hanging storage operation. Compare/readback detects observed
conflicts but cannot eliminate a writer racing after the final comparison.
Native rename/close is not a claimed fsync or power-loss guarantee. Real
Tauri/ArkWeb restart, storage-denial/recovery, devices and TB-322 evidence remain
required. The 4 MiB bound includes retained originals and backups; oversized
archives stop rather than being truncated.

## Verification and next stages

Run `node --test --experimental-strip-types tests/saved-server-*.test.mjs`,
`pnpm typecheck`, `pnpm lint`, and `pnpm test`. Capability scope tests cover the
new private persistence path and asset denial. No UI changed, so S1 does not
start a browser merely to produce screenshots. Native storage tests inject the
filesystem plugin: they are behavior tests, not real native/ArkWeb proof.

S2 still owns connection/authentication/API/session/cache/offline integration
after the actual #148/#150 combination is frozen. TB-446 owns future discovery
admission and save-button wiring, with validation before save and before actual
write. Reader prefix support still needs controlled launch provenance, complete
local progress identity, one remote saver and matching packaged capability.
Reader/gitlink, discovery wiring, TB-447 and old QA are not advanced by S1.
