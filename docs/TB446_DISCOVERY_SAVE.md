# TB-446 discovery-to-saved-list adapter

This successor to fixed C (`acff75ede7343db0c77f0ebb3f675419e6faf8b1`,
draft #152) adds developer-stage discovery admission and persistence. It is
partial delivery, not native/device acceptance or independent QA.

## Interface and write order

1. The join-page controller selects an existing joinable row by current
   session, generation, row ID and exact complete base URL. These fields are
   untrusted selectors, not permission.
2. `moke_discovery_admit({sessionId,rowId,baseUrl})` checks the main shell's
   join document and selects actual native cache state. Its opaque, native
   admission binds the cache incarnation, source RR/interface/address state,
   and fresh system DNS result. It returns `{admissionId,baseUrl,name}`.
   Every resolved address must satisfy the discovery LAN policy and at least
   one must match the selected source. No HTTP, authentication, service-port
   TCP probe, Host/SNI replacement or HTTPS downgrade is performed.
3. The adapter explicitly loads/migrates the existing saved repository before
   admission, then calls `saveAuthorizedServer(input, authorization)`. Normal
   `saveServer(input)` remains independent of discovery, DNS and LAN policy.
4. The repository captures inputs before its queue, does existing validation,
   backup and source checks, and substitutes the final authoritative writer
   with `authorization.commit(value,expectedRaw)`. An outer preflight followed
   by ordinary asynchronous FS persistence is not used.
5. `moke_discovery_commit({sessionId,admissionId,expectedRaw,value})` consumes
   the single-use native handle (five-second maximum lifetime), performs
   fresh system DNS validation again, and holds discovery state through the
   fixed-file writer. The writer prepares and syncs a private temporary file,
   rechecks ownership, current interfaces, queued RR/monitor changes, TTL,
   source incarnation and DNS generation, compares current bytes, checks
   again, then synchronously renames. There is no await between this final
   source gate and rename.
6. The only destination is AppConfig
   `server-registry/moke-saved-servers-v2.json`. Native validation permits
   exactly one ready entry for the admitted complete base, preserving all
   existing entries, originals and root fields. No caller path is accepted.
   A duplicate uses identical expected/value bytes for check-only validation;
   it creates no directory/temp file and preserves the original stable ID and
   name. The local ID is not the discovery UUID.
7. JS verifies persisted bytes using the existing repository. Success routes
   only the encoded stable local ID to `/welcome?focusSaved=...`; the list
   checks membership and focuses `saved-${id}` with `getElementById`. Valid
   legacy IDs are preserved. No address, grant, activation or authentication
   is carried in this navigation. A separate list click uses the existing
   guarded connection controller.

## Revocation and result handling

Stop and superseding start publish an independent atomic revocation before
waiting for session ownership, including while an older start/DNS operation
is in progress. RR replacement, TTL expiry, goodbye, interface/network
change, DNS generation change and session replacement invalidate admission.
Goodbye's cache grace can remain visible, but that source is immediately
nonjoinable. Canceled/stale UI requests do not navigate on a late result;
they cannot roll back an already dispatched native rename.

Guaranteed unwritten native rejections are `invalid_session`, `forbidden`,
`unsupported`, `stopped`, `candidate_unavailable`, `backend_failure`,
`network_changed`, `admission_busy`, `invalid_admission`, `admission_expired`,
`storage_conflict`, and `invalid_payload`. Generic errors, `storage_io`, IPC
timeouts and lost replies remain conservative unknown results. The UI disables
further save attempts and asks for list reload/reconciliation, rather than
blindly retrying or minting another ID.

Once saved, a record is independent of discovery TTL. Expiry does not delete,
rewrite, require rediscovery, or convert it to manual. Its old admission is
never used as connection authority.

## Explicit ordering and platform limits

The final gate drains revocations already queued at that gate and orders the
write under the discovery state lock. A packet arriving after that drain is
applied by the next actor operation. This does not provide an atomic snapshot
of all network packets/DNS at the physical rename instant. The byte comparison
also is not a cross-process OS CAS; persistence assumes the controlled main
repository queue. Independent external writers are outside this guarantee.

The runtime platform gate retains Windows/Linux discovery only. Web,
Apple/Android/OHOS and unknown platforms keep unsupported behavior. No FS or
HTTP scope, dependency, lockfile, Reader code or gitlink is changed. The two
narrow commands are added only to the existing main capability.

Native saved connection, legacy/managed Reader, active downloads and
same-host distinct-library connection guards remain. Reader A/B, trusted
source leases, actual TLS/Cookie policy, other platforms, real LAN integration
and independent same-version dual QA remain outstanding. #148 is not included.

## Developer validation

The integrated tree passes 759 Node tests, TypeScript, ESLint (zero errors;
23 existing warnings), and a Web production build. Native standalone tests
pass 34 cache contracts, 6 tests executing the actual fixed-file writer, and
18 desktop tests; one physical LAN test is ignored. The desktop tests include
synthetic UDP goodbye during write preparation and in-flight revocation.
These are controlled DNS/IO/algorithm and host-filesystem evidence.

Full Tauri `cargo check --lib --locked --offline` stops before host-command
compilation because baseline `vendor/wry/Cargo.toml` is absent. Nothing was
initialized, downloaded or installed to conceal this. Real WebView/IPC,
Windows replacement rename, native exit/restart persistence and real Talebook
LAN timing are not verified.

Playwright MCP exercises PC 1280x900 and mobile 390x844: production Web
unsupported discovery/manual save/focus, real DOM legacy-ID focus, access-code
timeout and HTTP 503 feedback; and real Next/React UI with explicitly mocked
Tauri IPC/file bytes for discovery/save/focus, duplicate, withdrawn source,
final reject, lost reply/reload, permission and empty states. The mock covers
keyboard activation and checks zero HTTP/zero active session on save; it is
not native authority or real filesystem evidence. Screenshots, result JSON,
commands and exact final revision are supplied in the issue evidence package.

The separate bot-fix commit and `TB446_BOT_TRIAGE.md` record all ten supplied
review candidates. No old PR review threads are resolved by this work.
