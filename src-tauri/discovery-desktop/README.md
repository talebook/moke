# Native Talebook discovery

App-owned Windows/Linux backend; it browses only `_talebook._tcp.local.` and
performs no HTTP/TCP reachability or authentication request. The Tauri owner
must enforce main-window/join-route IPC access and isolate session IDs.

`Session::start() -> Result<Session, DiscoveryError>` starts the browser only on
operational physical Wi-Fi/Ethernet interfaces. Linux checks sysfs Ethernet
hardware ancestry/multicast support; Windows checks `GetIfEntry2` Ethernet or
802.11 type and the hardware-interface flag. Loopback, point-to-point,
VPN/container/bridge/tunnel adapters are excluded. An environment exposing only
virtual interfaces reports `network_unavailable`; there is no automatic fallback
to browsing every adapter.

`snapshot(&self) -> Snapshot` returns `{status, rows, error}`. Status is one of
`searching`, `network_unavailable`, `error`, `stopped`; rows are validated
`moke-discovery-core` output. TXT remains raw until core validation. Each receipt
is stamped in the socket thread, including unchanged duplicates; the core alone
maintains per-interface RR lifetime, goodbye and cache-flush state. Neither row
liveness nor TTL derives from `ServiceResolved`. Current hostname sources are
resolved by normal OS `getaddrinfo` (`ToSocketAddrs`); all returned addresses must
be private/ULA and at least one must match that source's current discovered
addresses. The hostname, HTTPS scheme and prefix are never replaced.

`resolver.rs` bounds OS calls to a process-owned two-worker/sixteen-job pool.
The two-second logical deadline includes queueing; timeout, stop or source
replacement revoke the opaque ticket and ignore late answers. OS calls cannot
be portably aborted and may outlive a browsing session until the system returns;
stop joins the discovery worker/daemon without waiting for those process-owned
calls. Retry cannot accumulate new resolver threads. More than 64 distinct
answers is rejected rather than truncated. OS-configured DNS may use TCP/NSS/
hosts/mDNS; no connection to the advertised service port or HTTP request occurs.

Success has a 30-second local validation lease, independent of RR expiry. Failed
checks remain unavailable until retry or source change. The existing page retry
restarts discovery. `retry_hostname(row_id, base_url)` is a future restricted
explicit-action seam: only a current exact UUID+canonical URL can revoke/queue
new source checks, and `Ok(())` means queued, not verified. The owner must wait
for the fresh current snapshot before a future action and handle DNS rebinding
at the real connection boundary. No arbitrary-host IPC was added.

Every snapshot/touch renews a five-second foreground lease. A missed lease,
explicit stop, Drop, or detected network/interface/address change clears the
session and stops the daemon. Both monotonic and wall-clock lease checks prevent
an OS suspend from silently reviving an old session. Network changes report
`network_unavailable` with `network_changed`; an explicit refresh starts a new
session. `stop(&mut self)` and Drop join the worker and native daemon before
returning, releasing multicast memberships, sockets and subscriptions. The owner
must also stop explicitly on page leave/application background. No request is
needed to stop an already expired session.

Observer queue overflow, upstream cache/timer resource limits, or daemon failure
invalidate the entire cache. Snapshot checks channel disconnection even before
queued older events drain. Errors do not guess permission denial from an empty
list or from untyped backend errors. Browser APIs and unsupported native
platforms must use the app's explicit unsupported path.

## Verification

Run independently of Tauri/GTK/Reader:

```sh
cargo test --manifest-path src-tauri/discovery-desktop/Cargo.toml
cargo test --manifest-path vendor/mdns-sd/Cargo.toml --lib raw_record
cargo test --manifest-path vendor/mdns-sd/Cargo.toml --lib moke_observer_tests
cargo check --manifest-path src-tauri/discovery-desktop/Cargo.toml --target x86_64-pc-windows-gnu
cargo run --manifest-path src-tauri/discovery-desktop/Cargo.toml --example browse -- 10
```

The diagnostic example runs synchronously for at most 120 seconds, prints public
discovery rows and joins its resources before exiting. Exit 2 means startup
failed, including an unavailable physical LAN. It does not publish services or
send HTTP/TCP requests.

The Linux loopback tests use actual UDP sockets, packet-info receiving-interface
metadata and the vendored decoder. They cover unchanged record receipts,
original TTL=0, raw malformed/duplicate TXT, cache-flush, bounded-cache failure,
source→core candidate conversion, a repeated unchanged TXT refresh followed by
independent TXT expiry while PTR/SRV/A remain valid, explicit stop, network
change, foreground lease expiry, full command-queue shutdown with IP checks
disabled, and exclusive UDP port rebind after join. These are native socket and
lifecycle tests, not evidence of LAN multicast reachability.

A GNU Windows cross-check verifies Rust compilation only. Windows execution,
firewall/private-network behavior, Avahi/Bonjour coexistence, physical LAN
Wi-Fi/Ethernet multicast, OS permission UI and first-discovery/goodbye/120-second
end-to-end timing still require target-device testing. The production diagnostic on this Linux host successfully opened its selected
physical `eth0` interface and reported `Searching rows=0`; no real Talebook
publisher was available, so this is startup/socket evidence only.

The fixed upstream source and exact patch rationale are in
`vendor/mdns-sd/MOKE-PATCH.md`.

An additional explicit Linux LAN fixture test sends a synthetic, clearly named
service on the selected physical RFC1918 Ethernet/Wi-Fi interface, using real
UDP5353 multicast (source port 5353, destination 224.0.0.251, IP TTL 255). All
resource record TTLs are 120, followed by a TTL=0 goodbye. It sends no HTTP/TCP
traffic and does not use VPN/container adapters:

```sh
cargo test --manifest-path src-tauri/discovery-desktop/Cargo.toml physical_lan_multicast_fixture -- --ignored --nocapture
```

This verifies same-host multicast delivery through the real physical interface
and the production Session, not communication with another device or Talebook.

Recorded once on this Linux host on 2026-11-01: the explicit physical `eth0`
fixture test passed; the first validated/clickable row appeared at 20 ms, and
the TTL=0 goodbye removed it at 1010 ms. The session then stopped and joined its
worker. These are one synthetic same-host observation, not an end-to-end
Talebook result or a timing guarantee. Windows GNU cross-compilation passed; no
Windows runtime test was performed.
