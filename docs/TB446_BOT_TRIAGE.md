# TB-446: disposition of the ten #152 bot comments

The reviewed input is Moke `acff75ede7343db0c77f0ebb3f675419e6faf8b1`
(C, draft #152). The fixes described here belong to its TB-446 successor;
the frozen #152 input and its GitHub review threads are not rewritten or
resolved by this work. These are developer findings and regressions, not
independent Sol/Grok QA or proof of native, TLS, Cookie, or Reader support.

## Welcome contract checked against Talebook

The server reference is fixed at Talebook
`ec0d12c196e7a70d37dc7db970ff31b49e463968`:

- [`webserver/handlers/user.py:468`](https://github.com/talebook/talebook/blob/ec0d12c196e7a70d37dc7db970ff31b49e463968/webserver/handlers/user.py#L468)
  defines `Welcome`. GET returns `free` when no invitation is required or the
  invitation is already accepted (lines 474–477), and `ok` when a code is
  required (line 478). POST reads `invite_code` (line 487), then marks the
  invitation accepted and returns `ok` (line 491).
- [`webserver/handlers/base.py:206`](https://github.com/talebook/talebook/blob/ec0d12c196e7a70d37dc7db970ff31b49e463968/webserver/handlers/base.py#L206)
  emits `not_invited` as an application error in an HTTP 200 response when
  the invitation check fails (lines 206–214).

Therefore `not_invited` must continue to require access-code handling. A
fixture for unrestricted access must use `free`. This source inspection
establishes the checked version's contract; it is not a live deployed-server
test or a survey of older Talebook releases.

## Per-comment decisions

### 4434628176 — retain the strict transport restriction

<https://github.com/talebook/moke/pull/152#discussion_r4434628176>

The scope observation is confirmed: `src/lib/api.ts` derives strict TLS and
redirect rejection from either explicit `requireValidTls` or the current
`savedServerId`. It applies to later requests in a saved session and can
override an explicit redirect mode. Redirect-dependent servers/resources may
fail, and a future native saved connection would reject self-signed TLS.

No relaxation is adopted. This is a declared stage restriction, and native
saved connections remain blocked by `canConnectSavedServer`. A later source
and transport policy must explicitly decide redirect compatibility and
self-signed support before removing that guard. This change does not claim
to distinguish blocked redirects from network failure or to validate real
TLS/Cookie behavior.

### 4434628239 — correct three unrestricted-access fixtures

<https://github.com/talebook/moke/pull/152#discussion_r4434628239>

The fixture mismatch is confirmed against the fixed Talebook contract above.
`tests/helpers/library-layout.mjs`, `tests/detail-actions.spec.mjs`, and
`tests/comic-reader.spec.mjs` now return `free` from `/api/welcome`. The
application still treats `not_invited` as requiring a code and still rejects
unknown or malformed welcome responses. These fixture changes do not restore
the earlier behavior of treating every non-`ok` value as free access.

### 4434628270 — preserve fail-closed synchronization; add safe diagnostics

<https://github.com/talebook/moke/pull/152#discussion_r4434628270>

The early return is confirmed. A failed or unknown welcome result prevents
this Provider cycle from syncing user, title, or capabilities, and an
unchecked capability snapshot allows a later route-triggered retry. The
comment's claim about a supported old server with no welcome endpoint has
not been established by a version contract or live server.

`src/components/providers/ServerProvider.tsx` now calls the existing
`logErrorMetadata` helper before returning. That helper emits only an
allowlisted machine error code, not the server response body. The existing
confirmed auth and capability snapshot is retained. The runtime component
test verifies the diagnostic and absence of synchronization/navigation.

This is a diagnostic improvement only. No new user retry UI, backoff policy,
missing-endpoint compatibility, or automatic bypass is delivered. Those
support/recovery decisions remain open; a welcome failure is not evidence of
permission to synchronize.

### 4434628312 — keep saved-source Reader restrictions

<https://github.com/talebook/moke/pull/152#discussion_r4434628312>

The guard interaction is confirmed: `enterOfflineMode` retains saved identity,
and the offline/managed Reader entry points reject that identity. No Reader
compatibility change is adopted here. The offline button still allows
entering the shelf, while opening a publication from a saved identity can
report the existing Reader guard. That UX limitation remains open; it is not
fixed by clearing `savedServerId` or weakening the Reader guards. Saving and
listing remain independent of Reader
availability; native/Reader source leases and the Reader A/B trust decision
are outside this adapter stage.

`savedEntryRevision` remains persisted session metadata. It is not a
standalone authorization, Reader lease, or evidence that a local publication
belongs to the active saved entry. No new trusted-Reader claim is derived
from it in this work.

### 4434628404 — fix the silent access timeout

<https://github.com/talebook/moke/pull/152#discussion_r4434628404>

Confirmed and fixed in `src/app/access/page.tsx`. Previously the timeout
aborted the controller, then the `!signal.aborted` predicate prevented the
error from being shown. A transport that ignored abort could also leave the
form waiting for completion.

Request ownership is now separate from successful-current-response checks.
The 15-second UI deadline aborts, displays `验证超时，请重试。`, and immediately
allows retry even if transport never settles. Request identity, complete URL,
and session revision prevent a late response from navigating or clearing a
new retry. Source change/unmount revokes the request. The error has
`role="alert"`.

`tests/access-bot-regressions.test.mjs` executes the actual compiled TSX
handlers/effects with deterministic hooks, timers, and request stubs. It
covers abort-insensitive transport, immediate retry, late success, source
change, and unmount. This is component-logic evidence, not DOM/browser or
native transport evidence.

### 4434628435 — clarify the existing captcha-code protection

<https://github.com/talebook/moke/pull/152#discussion_r4434628435>

The original saved-candidate code was already protected by resetting
`invite_code` after applying captcha fields. This is a maintenance suggestion,
not a newly confirmed vulnerability in that wrapper. The loop now explicitly
skips the reserved key and explains why. The active-session `/access` form
uses the same rule.

Existing saved-wrapper tests and the new actual-component runtime test
verify that object captcha data cannot replace the entered code; string
captcha data remains a separate `captcha_code` field. Requests retain
redirect rejection and zero native redirects.

### 4434628487 — map HTTP failure to a non-success result

<https://github.com/talebook/moke/pull/152#discussion_r4434628487>

Confirmed and fixed in `src/lib/saved-server-connection.ts`. A non-2xx response
with JSON `{err:'ok'}` previously returned an `ok` envelope without a
connection, leaving the calling form without a useful new outcome. It did
not activate the entry, but it could silently appear to do nothing.

The wrapper now keeps a specific non-`ok` application error or returns
`http.<status>`. A successful HTTP response without a valid success error
code becomes `server.invalid_response`. Failed responses do not re-probe or
activate a candidate. `tests/saved-server-access.test.mjs` exercises
401/403/500/503 with `err:'ok'`, plus preservation of a specific captcha error.
The active-session component test also verifies no navigation on HTTP 503.

### 4434628529 — defer transport capture until source policy integration

<https://github.com/talebook/moke/pull/152#discussion_r4434628529>

The interface gap is confirmed: reading progress can capture the old URL and
session revision while `request()` still reads the current store's transport
policy. Captured URL alone does not freeze TLS/redirect policy.

No transport change is adopted here. Native saved connection and managed
Reader guards retain the stage boundary. A later Reader/source integration
must bind transport policy to the same trusted source/lease and cover delayed
cleanup after a session switch before making that path available. No
old-source progress failure with a real self-signed server was reproduced.

### 4434628666 — no component extraction required by this adapter

<https://github.com/talebook/moke/pull/152#discussion_r4434628666>

The long JSX lines are a maintenance observation, not a confirmed functional
defect. No standalone component extraction or unrelated layout refactor is
required for the discovery-save adapter. Necessary welcome-page changes are
kept with the serial integration and do not establish a separate UI rewrite.

### 4434628724 — retain explicit cold-start selection

<https://github.com/talebook/moke/pull/152#discussion_r4434628724>

The unused source/offline subscriptions in `src/app/page.tsx` are confirmed
maintenance debt, with no confirmed breakage of this stage's main path.
Dependency/format cleanup is not adopted in this adapter. The fixed
`/welcome` cold-start target is intentional and remains unchanged, including
after an offline restart. It must not be changed to automatic connection or
silently reuse a persisted offline/saved Reader context. The guarded saved
Reader route is still unavailable.

## Focused verification

Commands run from the Moke repository in the successor working tree:

```bash
node --test --experimental-strip-types tests/access-bot-regressions.test.mjs tests/saved-server-access.test.mjs
pnpm exec eslint src/app/access/page.tsx src/lib/saved-server-connection.ts src/components/providers/ServerProvider.tsx tests/access-bot-regressions.test.mjs tests/saved-server-access.test.mjs tests/helpers/library-layout.mjs tests/detail-actions.spec.mjs tests/comic-reader.spec.mjs
```

Final focused results: Node **15/15 pass**, exit 0; targeted ESLint **0 errors,
0 warnings**, exit 0. The first targeted lint run caught the new harness's
local variable named `module`; it was renamed to `compiledModule` before the
clean run. An earlier test attempt was blocked before loading the saved
wrapper by concurrent unsupported TypeScript parameter-property syntax in
the repository change; the final rerun above includes its correction.

The `.spec.mjs` fixture edits were linted, not executed by this Node command.
Whole-tree type/build and browser results, final SHA, and the discovery
adapter/native evidence belong to the integrated TB-446 implementation
report. This focused check does not stand in for those results or for the
outstanding independent same-SHA reviews.
