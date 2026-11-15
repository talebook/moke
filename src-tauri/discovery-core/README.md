Pure Talebook DNS-SD v1 core. Run independently of Tauri and Reader:

```sh
cargo test --manifest-path src-tauri/discovery-core/Cargo.toml
```

The browsing adapter supplies every raw received PTR/SRV/TXT/A/AAAA RR to
`Core::apply_batch`, preserving packet batches, TXT byte order, TTL, cache-flush,
and receiving interface. The clock is monotonic milliseconds. Repeated unchanged
records refresh their own TTL; a resolved-service callback is insufficient.
`snapshot` expires records and derives camelCase serializable rows from complete
record chains on the same interface. TTL=0 and cache-flush use the RFC 6762
one-second grace; recently received records and other members in the same packet
are protected. Ambiguous unique TXT/SRV sets are unavailable during replacement.
An oversized TXT retains only a bounded invalid sentinel, so it can invalidate
an older record without becoming a candidate.

The v1 profile requires publishers to send TTL=120. The cache conservatively
uses `min(received TTL, 120 seconds)` for each positive record: a shorter real
TTL still expires sooner, while an untrusted long TTL cannot keep a candidate
clickable past 120 seconds from that record's last actual refresh. TTL=0 keeps
the separate goodbye grace above.

Rows group by UUID, candidates by normalized base URL, and sources by service
fullname/interface. Conflicting names remain in per-source metadata and set the
row's `conflict` flag. No function chooses or saves a server, performs HTTP/TCP,
or grants trust to a discovered UUID.

DNS-name URLs retain the hostname, HTTPS scheme, port, and base path. Only current
strictly valid sources produce opaque `ResolutionTicket`s via `hostname_tickets`.
The normal OS resolver adapter supplies `set_hostname_resolution(ticket, result,
now_ms)`. Every address must be RFC1918/ULA and at least one must match that
source's discovered addresses. Errors/empty/timeouts stay disabled; results
belong to one source/record incarnation, not a hostname-wide cache. RR changes,
expiry, interface removal, clear and explicit retry invalidate old tickets.
Success has a 30-second local validation lease, not a DNS TTL and never an RR
extension. Unchanged RR refresh does not unnecessarily restart the DNS check.
`retry_hostname(row_id, canonical_base_url, now_ms)` revokes an existing exact
candidate's checks; success only means queued, not validated. The desktop adapter
performs the system calls; this crate remains pure. Future joining must await
fresh verification and handle connection-time DNS rebinding separately.

Create one core per browsing session. The IPC adapter owns generation checks,
foreground/background and network lifecycle; stop it and discard the core on
exit, refresh, background, or network change. Never feed late events into a new
session. Join cancellation, credential handling, and saved-server mutation are
tested in the frontend because this crate exposes none of those operations.

The committed shared TB-444 fixture is executed using RFC7396 merge-patch for
all 31 message cases and both generated boundary cases. Record-level lifecycle
tests cover refresh, per-record expiry, goodbye, interface isolation, RRset
replacement, partial address expiry, and conflict grouping. These are offline
contract tests, not evidence of multicast or platform permission validation.
