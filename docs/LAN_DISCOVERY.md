# Talebook LAN discovery (TB-446)

This is a partial implementation awaiting the saved-server integration and
native platform acceptance. Open **Welcome → 加入服务器 · 局域网发现** (`/join`).
Opening Welcome alone does not create a discovery socket.

The discovery page shows untrusted public names, UUIDs, full base URLs and
per-interface sources. Discovery never sends HTTP/TCP probes, authenticates,
saves a server or changes the active connection. The add buttons remain disabled
until TB-272 supplies the approved add/save interface. Joining must save first;
connecting must require a later click on the saved entry. The existing manual
connection page remains available, with its existing behavior.

## Modules and ownership

| Module | Responsibility |
| --- | --- |
| `src-tauri/discovery-core` | Strict raw TXT/URL validation, per-record expiry, source/URL/UUID grouping; no network or application state |
| `vendor/mdns-sd` | Fixed upstream v0.21.6 plus the documented raw-record observer, initial interface allowlist, resource limits and joined shutdown |
| `src-tauri/discovery-desktop` | Physical Wi-Fi/Ethernet selection, socket ownership, real receive timestamps, bounded normal OS DNS, network-change invalidation, foreground lease |
| `src-tauri/src/discovery.rs` | Fixed-type IPC, main-window and join-document guards, exact session token ownership |
| `src/lib/discovery` | Shared base URL expression and page-session controller; no server store/list |
| `src/components/discovery`, `src/app/join` | Discovery state and candidate display; no save/connect controller |
| Welcome and ServerProvider | One navigation link and public-route declaration only; TB-272 retains form/store/list ownership |
| `src/lib/offline-books.ts` | Complete base URL identity for classifications, mutations and native-record recovery |

The source observer reports every actual PTR/SRV/TXT/A/AAAA receipt, including
unchanged duplicates, raw TXT bytes, receiving interface, TTL and cache-flush.
Candidates require a complete record chain on the same interface. Goodbye and
cache-flush have the standard one-second grace. Positive effective TTL is capped
at the v1 publisher maximum of 120 seconds; shorter wire TTLs are never extended.
The frontend polls already validated snapshots; polling does not refresh RR TTL.

Leaving, hiding or blurring the page clears candidates and stops the session.
The backend also expires its five-second foreground lease if polling stops.
Network changes stop the old browser and clear its cache. Retry starts a new
session. Stale starts/stops are serialized, and stale snapshots are discarded.

Only the main host capability grants discovery commands. Starting or reading a
session also requires `/join`, `/join/` or `/join.html`; stop accepts another host
route only to release the exact token. Reader capabilities and Reader code are
unchanged. The IPC accepts no service type, remote address or credentials.

## Current platform evidence

| Platform | Implementation / outstanding acceptance |
| --- | --- |
| Linux | Rust observer/cache and real UDP tests pass. A synthetic same-host fixture over physical eth0 produced a validated candidate at 20ms and removed it 1010ms after goodbye. Cross-device Talebook, Avahi coexistence, native WebView and full timing acceptance still required. |
| Windows | Same Rust backend and OS hardware-interface classification; cross-compilation is distinct from Windows socket/firewall/native acceptance. |
| macOS | Explicitly unsupported in this implementation. Implement persistent Bonjour QueryRecord subscriptions for every necessary RR, raw TXT and per-interface Add/Remove; supply Apple SDK, signed app and device evidence. |
| iOS/iPadOS | Explicitly unsupported. In addition to the Apple adapter, confirm entitlement/signing for the whole persistent query group; provide device permission evidence. |
| Android | Explicitly unsupported. Fix an app-owned raw-RR observation layer and confirm target SDK/network permissions and MulticastLock lifecycle on API26+; public NSD attribute maps/lost events alone are insufficient. |
| OpenHarmony | Explicitly unsupported. Fix an app-owned raw-RR/TTL/interface observer and ArkTS/native bridge against the actual SDK/device; high-level MDNS lost/TCP checks are insufficient. |
| Web | Explicitly unsupported; manual address entry remains available. Browser tests cover UI, not LAN sockets or OS permission. |

DNS-name URLs retain their hostname, HTTPS scheme and prefix. Only current,
strictly validated source records may request normal OS resolution. All results
must be RFC1918/ULA and at least one must match that source's current addresses.
Empty, failed, timed-out, non-LAN or mismatching answers remain unavailable with
separate messages; **重新查找** starts a new session to retry. A successful check
has a 30-second local lease, independent of RR TTL, after which it is rechecked.
Any necessary RR/source change or expiry revokes its opaque lookup ticket; old
responses cannot re-enable a removed, replaced or retried source.

OS `getaddrinfo` is not portably abortable. A process-owned pool bounds it to two
workers and sixteen queued jobs; the two-second logical deadline includes queue
time. Stop cancels tickets/results and joins the discovery worker/daemon without
waiting for OS calls. Those at most two OS calls can remain until the system
resolver returns; retry never spawns replacement threads. More than 64 distinct
answers is rejected, never truncated and approved. The OS may use DNS TCP, hosts,
NSS or mDNS as configured; this is DNS resolution, not a connection to the
advertised Talebook port. No HTTP or credential operation is performed.

`Session::retry_hostname(row_id, base_url)` is a future explicit-action seam:
it matches a current UUID + canonical URL and revokes/queues a fresh check. Its
success means queued, not verified. It is not exposed as an arbitrary-host IPC;
save/connect integration must await the fresh current result and address DNS
rebinding at the actual connection boundary. No buttons are enabled here.
Literal candidates accept only RFC1918 IPv4 or IPv6 ULA;
link-local-only and public-numbered LANs use the manual path.

## Integration and trust gaps

TB-272 must provide a fixed, valid saved-server interface before enabling the
buttons. Do not connect candidates to `setServer`. The shared base URL preserves
`/team/books`; the old welcome/access/store and online-reader path still need a
coordinated integration. Root records cannot be guessed to belong to `/a` or `/b`.
The source-isolation changes here do not establish complete prefix support.
The three shared parser exports and the manual/public/IDNA/legacy migration
contract are in [LIBRARY_BASE_URL.md](LIBRARY_BASE_URL.md). Shared syntax parsing
does not apply discovery's ASCII/200-byte/private-address policy to manual
addresses. Invalid migrated records must be retained for correction by the
TB-272 list implementation, which has not been integrated by this change.

Existing native HTTP and Range bridges still accept invalid certificates and
hostnames. This change does not modify that policy or claim strict TLS identity.
Joining must separately verify redirect downgrade/cross-origin policy, native
cookie scope, cancellation, authentication, save failure and later list-click
connection. A discovery ID never transfers trust or credentials to another URL.

First real two-ended testing must use Linux native/host networking and the actual
external Talebook listener. Default Docker bridge, port mapping, Docker Desktop,
macvlan/ipvlan, IPv6 and multi-interface deployment evidence remain outstanding;
mapping UDP5353 alone does not establish support. Observe first clickable ≤10s,
goodbye removal ≤5s and removal ≤125s from the last actual RR refresh. These are
unverified foreground-LAN observation targets, not OS/UDP guarantees.

## Local checks

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
cargo test --manifest-path src-tauri/discovery-core/Cargo.toml
cargo test --manifest-path src-tauri/discovery-desktop/Cargo.toml
cargo test --manifest-path src-tauri/discovery-desktop/Cargo.toml physical_lan_multicast_fixture -- --ignored --nocapture
cargo test --manifest-path vendor/mdns-sd/Cargo.toml --lib raw_
cargo check --manifest-path src-tauri/Cargo.toml
```

The shared TB-444 JSON fixture is committed under discovery-core tests. Pure
contract tests, mock IPC/React/Playwright checks, real loopback UDP and a signed
native application on an actual LAN are different evidence levels. No part of
this document marks TB-446 or the six-platform acceptance complete, or starts QA.
