# Moke Talebook RR observer patch

Upstream: <https://github.com/keepsimple1/mdns-sd>, tag `v0.21.6`, commit
`1a5cdb6ebb7299ee74dda75099461a2921b6e740`. The complete upstream source and
MIT/Apache-2.0 license files are retained. This is a source vendor, not a git
submodule or floating registry dependency. Moke's desktop crate uses this path
with upstream default features disabled and the logging feature enabled.

The patch is deliberately separate from `ServiceResolved`:

- `src/raw_record.rs` and `src/lib.rs` expose a fixed Talebook observer containing
  every actual received PTR/SRV/TXT/A/AAAA RR batch, socket receive `Instant`,
  local interface name/index, original wire TTL (including zero), cache-flush
  bit, and exact TXT RDATA bytes before map conversion. Repeated unchanged RRs
  are emitted again. Invalid TXT string framing/UTF-8 remains visible to Moke's
  validation core. Non-IN class, CNAME, unrelated service PTR/SRV/TXT and PTR
  aliases outside `._talebook._tcp.local.` are rejected.
- `src/dns_parser.rs` records these values while decoding a successfully parsed
  response, before upstream changes goodbye TTL=0 to TTL=1. Query known-answer
  sections and synthetic cache replays are not emitted. Unsupported or malformed
  DNS RDATA is ignored according to upstream's record parser; TXT itself remains
  raw. The socket parser still enforces the upstream 9000-byte packet limit.
- `src/service_daemon.rs` adds `new_talebook_observer(port, interfaces)`. Its
  interface allowlist is installed before any multicast group join and retained
  for later interface checks. Startup acknowledges socket/group initialization
  and poll registration. The app alone selects physical operational Wi-Fi and
  Ethernet; the port/interface parameters exist here for native socket testing,
  and are never exposed through app IPC. Only the fixed Talebook type is browsed
  by the app, and derived instance queries have a fixed suffix guard.
- The observer channel is bounded to 256 batches. Overflow drops its sender and
  stops the daemon instead of losing a refresh/flush silently. Callers must
  treat `Receiver::is_disconnected()` as immediate invalidation even while old
  batches remain queued. Moke does so in its worker and in every IPC snapshot.
- In observer mode, upstream's own query cache is also bounded. It counts live
  RR values plus retained map keys (`dns_cache.rs`) with a conservative combined
  limit of 1024, and at most 8192 pending timers before the next packet is
  admitted. Exceeding either limit disconnects the observer and stops the
  daemon. The app clears all candidates and reports a backend error. Addresses
  may arrive before SRV and are passively retained within these bounds; an A
  record by itself cannot produce a candidate or a new query.
- `shutdown_and_join()` uses an independent atomic stop flag and mio waker, so a
  full command queue cannot lose an Exit request. Socket/signal/command draining
  has finite work budgets. Joining returns only after the owner thread has
  dropped sockets. The ordinary upstream asynchronous APIs are retained.

Tests added here exercise original TTL=0, raw duplicate/malformed TXT, flush,
wrong RR class/CNAME/unrelated alias rejection, repeated real UDP receipts on a
loopback interface, observer interface metadata, resource-limit disconnect,
full command queue shutdown with periodic IP checks disabled, and exclusive UDP
port rebind after join. Loopback tests establish native socket/observer/lifecycle
behavior, not LAN multicast reachability or a platform-wide acceptance result.
