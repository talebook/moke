# Saved-server list and controlled Web connections (TB-272 / TB-293)

This stage consumes frozen S1 `8f9f97baed74104f6e1962d846ffa1b0883e4eb6`
and its parser dependency `b472f0803e1a94be0764c8a246baacc647f15c2b`.
The independent draft targets the S1 branch for review; public
`talebook/moke:main` remains the eventual destination. It does not update any
dependency PR, Reader gitlink, native permission or release configuration.

## Delivered behavior

`/` starts at `/welcome`. Both are public routes: restoring last-session
metadata does not start server probes on the list. Welcome shows stable saved
entries, complete addresses, invalid/collision states, an explicit add form,
cancel, duplicate feedback and reload/recovery. Saving delegates to S1 and never
connects. A failed/unknown save retains the draft and existing rows, disables
further writes/connections and asks for explicit reload. The UI has no destructive
reset or automatic collision merge. Entry correction remains protected by S1.

Selecting an entry uses `savedServerConnection.connect(entry)` from
`src/lib/saved-server-connection.ts`, backed by the injected pure controller in
`server-connection-controller.ts`. It captures local id, complete base,
entryRevision, sessionRevision and attempt number; reads the authoritative saved
entry and checks source availability both before and after probing. Only a
matching successful attempt may synchronously activate the new session.

The two candidate GETs use the saved complete base, credentials, an abort signal
and no redirects. Expected Talebook info outcomes are `ok`, `not_invited`,
`user.need_login`, `not_installed`; welcome must be `free` (no code) or
`ok`/`not_invited` (code required). Unknown/HTTP/JSON failures do not activate.
The 15-second deadline and cancel settle immediately; an uncooperative late
transport cannot replace a later candidate. Retry is a new attempt.

The candidate access-code form posts the existing URL-encoded `invite_code`
contract to that exact entry, not the current live store. It binds the original
entry/session/attempt, preserves captcha handling and repeats the connection
probe after successful verification. Cancelling verification also cancels its
second probe. Existing access/login/register/reset routes use confirmed session
addresses, guard late results and cancel on navigation/source changes; bare
query strings and old localStorage mirrors no longer select `/access` targets.

Activation uses the new `activateSavedServer(entry, expectedSessionRevision)`
action, retaining the complete prefix and stable saved identity. It starts fresh
user/token/title/capability state and advances sessionRevision. The existing
Provider's complete-URL/session checks and info-request cache remain in place.
Read-state cache generations reject late refill; deferred legacy progress saves
retain their captured source, and old failures cannot downgrade a new source.

## Separate persistence owners

S1 remains the sole authority for the saved list:
`moke-saved-servers-v2`, schema 2. Its source comparisons, backups, readback,
unknown-commit reconciliation and raw originals are unchanged.

The runtime connection store now writes `moke-active-session-v1`. It can read the
old `moke-server-storage` only as a cold fallback. No new runtime action writes
that old key or `moke_server_url`; consequently normal connection/authentication
updates no longer invalidate S1's legacy fingerprints. Active-session metadata
uses the existing best-effort persistence semantics; it is not the authority for
successful saved-list writes. Old-client source changes still fail closed in S1.

## Explicit limits and guards

- **Native list connections remain blocked.** The authoritative native source /
  Reader document-generation lease is not integrated. An empty window
  enumeration cannot rule out a late prior IPC dispatch or a reload. Native
  saved-list storage and display are available; this is not native connection or
  restart acceptance.
- A legacy Reader attempt reserves its source for the rest of this host runtime,
  including awaits and unknown dispatch. It is not released by a timeout.
  Outstanding offline downloads also block selecting a different connection,
  with a final synchronous occupancy check immediately before activation.
  Download/retry jobs check their captured base/session before starting and
  after cover IO; binary transfers receive that frozen base explicitly, so an
  old A job cannot fetch B bytes and label them as belonging to A.
- Different complete bases on the same hostname cannot be switched directly in
  this stage. Browser/native cookie jars do not partition by port or library
  prefix. No cookie jar/account isolation has been added or proven.
- Managed saved sessions cannot dispatch embedded/home/offline/system Reader
  opens. Detail guards precede online bootstrap; Reader progress events are not
  accepted into a managed session. Existing Web platform restrictions also stay
  in place. Neither root nor prefix Reader support is claimed for this stage.
- Saved/candidate requests reject redirects; native request options require
  valid certificate/hostname checks for saved/candidate sessions. Existing
  legacy transport behavior is retained. Tests do not establish real TLS or
  cookie identity, and there is no claim of DNS rebinding protection.
- Reader A/B is still undecided. There is no new Reader contract, trusted claim,
  progress namespace, permission or gitlink. S1 originals may contain old auth
  data; API Views/asset denial still do not isolate same-origin Reader code.

#148 (`01c3e92ee3b29dd189e2c702938087ffda4180a0`) was inspected but is not part
of this combination. Its Reader/host recovery and download changes remain for
the original integration chain; they are not prerequisites for this guarded
list/Web stage. No whole historical #139 tree was restored. Existing main and
D offline identity/queue/native fallback fixes remain present. Download/Reader
end-to-end behavior is not newly accepted by this stage.

## Discovery handoff

TB-446 must continue to import only the saved-list facade from the descendant
combination, never add an import from D back into L. Its future adapter owns
authoritative admission and the validation immediately before writing. The
discovery add button stays disabled until those checks exist. Save success
returns the original stable id for duplicate addresses; future UI can focus
`saved-<id>` on the list. Connection is a separate action, with its own current
checks and authentication. No broadcast TTL or save ticket authorizes a later
connection, and expired discovery does not delete an already saved entry.

## Author validation

Run the saved-list/session/controller/probe/access/source-guard Node tests,
`pnpm test`, `pnpm typecheck`, `pnpm lint` and `pnpm build-web`. UI evidence uses
actual Playwright MCP, actual localStorage and task-owned localhost HTTP fixture
services; delayed auth and book-detail responses are explicitly mocked. The
fixture is not a deployed Talebook and does not establish real authentication,
LAN, TLS, Reader, Tauri/ArkWeb or device behavior. Internal helpers and author
self-tests are not independent QA. Freeze the final combination before future
discovery integration and dual QA.
