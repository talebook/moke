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

DNS-name URLs retain the hostname, HTTPS scheme, port, and base path. They are
disabled with `hostname_unresolved` until a normal system resolver result is
explicitly supplied with `set_hostname_resolution`. Every resolved address must
be RFC1918/ULA and at least one must match that source's discovered addresses.
The adapter must clear/revalidate these results when the network changes and
before joining; absence of a resolver implementation must leave them disabled.

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
