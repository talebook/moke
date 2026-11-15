//! Normal OS hostname resolution, without connecting to the advertised service.
//!
//! `getaddrinfo` (used by `ToSocketAddrs`) cannot be interrupted portably. A
//! process-wide pool therefore owns at most two calls, with sixteen queued
//! jobs. Sessions never create extra resolver threads or wait for these calls
//! when stopping. Timeouts/stop revoke the result channel and ticket; a late
//! OS result cannot revive a candidate. The OS may retain those two calls until
//! its own resolver timeout. Queue wait is part of our two-second deadline.

use moke_discovery_core::{Core, HostnameFailure, ResolutionTicket};
use std::collections::{BTreeMap, BTreeSet};
use std::net::{IpAddr, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const WORKERS: usize = 2;
const QUEUE_CAPACITY: usize = 16;
const DEADLINE_MS: u64 = 2_000;
// Exceeding the limit rejects the result. Never truncate and approve a prefix
// that might hide a later public/nonmatching address.
const MAX_RESULT_ADDRESSES: usize = 64;

type LookupResult = Result<Vec<IpAddr>, HostnameFailure>;
type Lookup = dyn Fn(&str) -> LookupResult + Send + Sync;

struct Job {
    hostname: String,
    canceled: Arc<AtomicBool>,
    deadline: Instant,
    reply: mpsc::SyncSender<LookupResult>,
}

struct Pool {
    sender: mpsc::SyncSender<Job>,
    _workers: Vec<JoinHandle<()>>,
}

impl Pool {
    fn start(lookup: Arc<Lookup>) -> std::io::Result<Self> {
        let (sender, receiver) = mpsc::sync_channel::<Job>(QUEUE_CAPACITY);
        let receiver = Arc::new(Mutex::new(receiver));
        let mut workers = Vec::new();
        for index in 0..WORKERS {
            let receiver = receiver.clone();
            let lookup = lookup.clone();
            match thread::Builder::new()
                .name(format!("moke-system-dns-{index}"))
                .spawn(move || loop {
                    // Only receiving is serialized; lookups run in parallel.
                    let job = receiver.lock().unwrap_or_else(|p| p.into_inner()).recv();
                    let Ok(job) = job else { break };
                    if job.canceled.load(Ordering::Acquire) {
                        continue;
                    }
                    let result = if Instant::now() >= job.deadline {
                        Err(HostnameFailure::Timeout)
                    } else {
                        lookup(&job.hostname)
                    };
                    if !job.canceled.load(Ordering::Acquire) {
                        // Every job has its own capacity-one channel; a dropped
                        // session/expired ticket cannot block the worker.
                        let _ = job.reply.try_send(result);
                    }
                }) {
                Ok(worker) => workers.push(worker),
                Err(error) => {
                    drop(sender);
                    for worker in workers {
                        let _ = worker.join();
                    }
                    return Err(error);
                }
            }
        }
        Ok(Self {
            sender,
            _workers: workers,
        })
    }

    #[cfg(test)]
    fn shutdown(self) {
        drop(self.sender);
        for worker in self._workers {
            worker.join().unwrap();
        }
    }
}

fn normal_system_lookup(hostname: &str) -> LookupResult {
    // Port zero is only the numeric service argument to getaddrinfo. This
    // creates no socket and makes no HTTP/TCP service reachability request.
    let resolved = (hostname, 0)
        .to_socket_addrs()
        .map_err(|_| HostnameFailure::LookupFailed)?;
    let mut addresses = BTreeSet::new();
    for address in resolved {
        addresses.insert(address.ip());
        if addresses.len() > MAX_RESULT_ADDRESSES {
            return Err(HostnameFailure::LookupFailed);
        }
    }
    if addresses.is_empty() {
        return Err(HostnameFailure::Empty);
    }
    Ok(addresses.into_iter().collect())
}

fn system_pool() -> Option<Arc<Pool>> {
    // One fixed pool across *all* sessions, even if earlier OS calls stall.
    // OnceLock is process-owned and intentionally outlives any browsing page.
    static POOL: OnceLock<Option<Arc<Pool>>> = OnceLock::new();
    POOL.get_or_init(|| {
        Pool::start(Arc::new(normal_system_lookup))
            .ok()
            .map(Arc::new)
    })
    .clone()
}

struct Task {
    created_ms: u64,
    canceled: Arc<AtomicBool>,
    reply: Option<mpsc::Receiver<LookupResult>>,
    completed: bool,
}

pub(crate) struct Scheduler {
    pool: Option<Arc<Pool>>,
    tasks: BTreeMap<ResolutionTicket, Task>,
}

impl Scheduler {
    pub(crate) fn system() -> Self {
        Self {
            pool: None,
            tasks: BTreeMap::new(),
        }
    }

    #[cfg(test)]
    fn with_pool(pool: Arc<Pool>) -> Self {
        Self {
            pool: Some(pool),
            tasks: BTreeMap::new(),
        }
    }

    pub(crate) fn tick(&mut self, core: &mut Core, now_ms: u64) {
        let tickets: BTreeSet<_> = core.hostname_tickets(now_ms).into_iter().collect();
        self.tasks.retain(|ticket, task| {
            let current = tickets.contains(ticket);
            if !current {
                task.canceled.store(true, Ordering::Release);
            }
            current
        });
        for ticket in tickets {
            self.tasks.entry(ticket).or_insert_with(|| Task {
                created_ms: now_ms,
                canceled: Arc::new(AtomicBool::new(false)),
                reply: None,
                completed: false,
            });
        }
        if self.tasks.values().any(|task| !task.completed) && self.pool.is_none() {
            self.pool = system_pool();
        }
        for (ticket, task) in &mut self.tasks {
            if task.completed {
                continue;
            }
            // Deadline wins over an already queued response. The system result
            // must be consumed before its local validation deadline.
            let result = if now_ms.saturating_sub(task.created_ms) >= DEADLINE_MS {
                Some(Err(HostnameFailure::Timeout))
            } else if let Some(reply) = &task.reply {
                match reply.try_recv() {
                    Ok(result) => Some(result),
                    Err(mpsc::TryRecvError::Empty) => None,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        Some(Err(HostnameFailure::LookupFailed))
                    }
                }
            } else if let Some(pool) = &self.pool {
                let (sender, receiver) = mpsc::sync_channel(1);
                let remaining = DEADLINE_MS - now_ms.saturating_sub(task.created_ms);
                let job = Job {
                    hostname: ticket.hostname().to_owned(),
                    canceled: task.canceled.clone(),
                    deadline: Instant::now() + Duration::from_millis(remaining),
                    reply: sender,
                };
                match pool.sender.try_send(job) {
                    Ok(()) => {
                        task.reply = Some(receiver);
                        None
                    }
                    // Keep the same deadline while waiting for bounded queue
                    // capacity. This cannot create another resolver worker.
                    Err(mpsc::TrySendError::Full(_)) => None,
                    Err(mpsc::TrySendError::Disconnected(_)) => {
                        Some(Err(HostnameFailure::LookupFailed))
                    }
                }
            } else {
                Some(Err(HostnameFailure::LookupFailed))
            };
            if let Some(result) = result {
                core.set_hostname_resolution(ticket, result, now_ms);
                task.completed = true;
                task.canceled.store(true, Ordering::Release);
                task.reply = None;
            }
        }
    }
}

impl Drop for Scheduler {
    fn drop(&mut self) {
        for task in self.tasks.values() {
            task.canceled.store(true, Ordering::Release);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use moke_discovery_core::{Record, RecordData, SERVICE_TYPE};
    use std::net::Ipv4Addr;
    use std::sync::Condvar;

    const ROW_ID: &str = "9f0c663b-8ffd-4e13-92d9-2b68572c08b1";
    const BASE_URL: &str = "https://books.home.arpa:8080/team/books";

    fn seeded_core() -> Core {
        seeded_core_for_url(BASE_URL)
    }

    fn seeded_core_for_url(base_url: &str) -> Core {
        let mut core = Core::default();
        let fullname = "test._talebook._tcp.local.";
        let txt = [
            "txtvers=1".to_owned(),
            format!("id={ROW_ID}"),
            "name=Test".to_owned(),
            format!("url={base_url}"),
        ]
        .into_iter()
        .flat_map(|value| std::iter::once(value.len() as u8).chain(value.into_bytes()))
        .collect();
        core.apply_batch(
            vec![
                (SERVICE_TYPE, RecordData::Ptr(fullname.to_owned())),
                (
                    fullname,
                    RecordData::Srv {
                        priority: 0,
                        weight: 0,
                        port: 8080,
                        target: "books.local.".to_owned(),
                    },
                ),
                (fullname, RecordData::Txt(txt)),
                (
                    "books.local.",
                    RecordData::A(Ipv4Addr::new(192, 168, 50, 10)),
                ),
            ]
            .into_iter()
            .map(|(name, data)| Record {
                name: name.to_owned(),
                interface: "test#1".to_owned(),
                ttl: 120,
                cache_flush: true,
                data,
            })
            .collect(),
            0,
        );
        core
    }

    fn reason(core: &mut Core, now_ms: u64) -> Option<String> {
        core.snapshot(now_ms)[0].candidates[0]
            .unavailable_reason
            .clone()
    }

    fn wait_for_result(scheduler: &mut Scheduler, core: &mut Core, now_ms: u64) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while reason(core, now_ms).as_deref() == Some("hostname_unresolved") {
            assert!(
                Instant::now() < deadline,
                "resolver test worker did not complete"
            );
            scheduler.tick(core, now_ms);
            thread::yield_now();
        }
    }

    fn shutdown(pool: Arc<Pool>, scheduler: Scheduler) {
        drop(scheduler);
        Arc::try_unwrap(pool).ok().unwrap().shutdown();
    }

    #[test]
    fn normal_system_resolver_localhost_smoke_rejects_loopback_candidate() {
        // Exercise the production OS resolver directly, without an injected
        // Lookup, a modified hosts file, a public hostname, or a service probe.
        // This proves only local hosts/NSS/system resolver integration. The
        // synthetic private RR below is deliberately not real LAN evidence.
        let resolved = normal_system_lookup("localhost")
            .expect("the local OS resolver must resolve localhost for this smoke test");
        assert!(!resolved.is_empty());
        assert!(resolved.iter().all(IpAddr::is_loopback));
        let count = resolved.len();
        let mut core = seeded_core_for_url("http://localhost:8080/team/books");
        let ticket = core.hostname_tickets(0).remove(0);
        assert_eq!(ticket.hostname(), "localhost");
        assert!(core.set_hostname_resolution(&ticket, Ok(resolved), 0));
        assert_eq!(
            reason(&mut core, 0).as_deref(),
            Some("hostname_non_lan_address")
        );
        assert!(!core.snapshot(0)[0].candidates[0].joinable);
        eprintln!(
            "OS localhost resolver smoke: {count} loopback addresses; synthetic candidate rejected as hostname_non_lan_address; no LAN/private-DNS/server validation"
        );
    }

    #[test]
    fn scheduler_preserves_hostname_and_prefix_and_revalidates_after_lease() {
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls = count.clone();
        let pool = Arc::new(
            Pool::start(Arc::new(move |host| {
                assert_eq!(host, "books.home.arpa");
                calls.fetch_add(1, Ordering::Relaxed);
                Ok(vec!["192.168.50.10".parse().unwrap()])
            }))
            .unwrap(),
        );
        let mut scheduler = Scheduler::with_pool(pool.clone());
        let mut core = seeded_core();
        scheduler.tick(&mut core, 0);
        wait_for_result(&mut scheduler, &mut core, 0);
        assert_eq!(reason(&mut core, 0), None);
        assert_eq!(core.snapshot(0)[0].candidates[0].base_url, BASE_URL);
        for _ in 0..10 {
            scheduler.tick(&mut core, 1);
        }
        assert_eq!(count.load(Ordering::Relaxed), 1);
        scheduler.tick(&mut core, 30_000);
        wait_for_result(&mut scheduler, &mut core, 30_000);
        assert_eq!(count.load(Ordering::Relaxed), 2);
        shutdown(pool, scheduler);
    }

    #[test]
    fn lookup_failure_is_stable_until_exact_candidate_retry_then_recovers() {
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls = count.clone();
        let pool = Arc::new(
            Pool::start(Arc::new(move |_| {
                if calls.fetch_add(1, Ordering::Relaxed) == 0 {
                    Err(HostnameFailure::LookupFailed)
                } else {
                    Ok(vec!["192.168.50.10".parse().unwrap()])
                }
            }))
            .unwrap(),
        );
        let mut scheduler = Scheduler::with_pool(pool.clone());
        let mut core = seeded_core();
        scheduler.tick(&mut core, 0);
        wait_for_result(&mut scheduler, &mut core, 0);
        assert_eq!(
            reason(&mut core, 0).as_deref(),
            Some("hostname_lookup_failed")
        );
        scheduler.tick(&mut core, 5_000);
        assert_eq!(count.load(Ordering::Relaxed), 1);
        assert!(!core.retry_hostname(ROW_ID, "https://arbitrary.example", 5_000));
        assert!(core.retry_hostname(ROW_ID, BASE_URL, 5_000));
        assert_eq!(
            reason(&mut core, 5_000).as_deref(),
            Some("hostname_unresolved")
        );
        scheduler.tick(&mut core, 5_000);
        wait_for_result(&mut scheduler, &mut core, 5_000);
        assert_eq!(reason(&mut core, 5_000), None);
        assert_eq!(count.load(Ordering::Relaxed), 2);
        shutdown(pool, scheduler);
    }

    #[test]
    fn logical_timeout_and_stop_reject_late_results_without_waiting_for_os() {
        let (started, observed) = mpsc::channel();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let lookup_gate = gate.clone();
        let pool = Arc::new(
            Pool::start(Arc::new(move |_| {
                started.send(()).unwrap();
                let (lock, wake) = &*lookup_gate;
                let mut released = lock.lock().unwrap();
                while !*released {
                    released = wake.wait(released).unwrap();
                }
                Ok(vec!["192.168.50.10".parse().unwrap()])
            }))
            .unwrap(),
        );
        let mut scheduler = Scheduler::with_pool(pool.clone());
        let mut core = seeded_core();
        scheduler.tick(&mut core, 0);
        observed.recv_timeout(Duration::from_secs(2)).unwrap();
        // The fake OS call is still blocked. Cancellation/stop remain local.
        scheduler.tick(&mut core, DEADLINE_MS);
        assert_eq!(
            reason(&mut core, DEADLINE_MS).as_deref(),
            Some("hostname_timeout")
        );
        core.clear();
        drop(scheduler);
        let (lock, wake) = &*gate;
        *lock.lock().unwrap() = true;
        wake.notify_all();
        Arc::try_unwrap(pool).ok().unwrap().shutdown();
        assert!(core.snapshot(DEADLINE_MS).is_empty());
    }

    #[test]
    fn bounded_workers_and_queue_skip_canceled_jobs_and_join_for_tests() {
        let (started, observed) = mpsc::channel();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let lookup_calls = calls.clone();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let lookup_gate = gate.clone();
        let pool = Pool::start(Arc::new(move |_| {
            lookup_calls.fetch_add(1, Ordering::Relaxed);
            started.send(()).unwrap();
            let (lock, wake) = &*lookup_gate;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = wake.wait(released).unwrap();
            }
            Ok(vec!["192.168.50.10".parse().unwrap()])
        }))
        .unwrap();
        let canceled = Arc::new(AtomicBool::new(false));
        let job = || {
            let (reply, _) = mpsc::sync_channel(1);
            Job {
                hostname: "books.home.arpa".to_owned(),
                canceled: canceled.clone(),
                deadline: Instant::now() + Duration::from_secs(10),
                reply,
            }
        };
        for _ in 0..WORKERS {
            pool.sender.try_send(job()).unwrap();
            observed.recv_timeout(Duration::from_secs(2)).unwrap();
        }
        for _ in 0..QUEUE_CAPACITY {
            pool.sender.try_send(job()).unwrap();
        }
        assert!(matches!(
            pool.sender.try_send(job()),
            Err(mpsc::TrySendError::Full(_))
        ));
        assert_eq!(calls.load(Ordering::Relaxed), WORKERS);
        canceled.store(true, Ordering::Release);
        let (lock, wake) = &*gate;
        *lock.lock().unwrap() = true;
        wake.notify_all();
        pool.shutdown();
        assert_eq!(calls.load(Ordering::Relaxed), WORKERS);
    }

    #[test]
    fn session_automatically_resolves_live_candidates_and_stop_revokes_inflight_retry() {
        let (started, observed) = mpsc::channel();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let lookup_gate = gate.clone();
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let lookup_count = count.clone();
        let pool = Arc::new(
            Pool::start(Arc::new(move |hostname| {
                assert_eq!(hostname, "books.home.arpa");
                let call = lookup_count.fetch_add(1, Ordering::Relaxed);
                started.send(call).unwrap();
                // The first answer is immediate. The explicitly retried answer
                // represents a non-abortable, still-running system resolver call.
                if call > 0 {
                    let (lock, wake) = &*lookup_gate;
                    let mut released = lock.lock().unwrap();
                    while !*released {
                        released = wake.wait(released).unwrap();
                    }
                }
                Ok(vec!["192.168.50.10".parse().unwrap()])
            }))
            .unwrap(),
        );
        let interface = if_addrs::get_if_addrs()
            .unwrap()
            .into_iter()
            .find(|interface| interface.is_loopback() && interface.ip().is_ipv4())
            .unwrap();
        let reservation = std::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = reservation.local_addr().unwrap().port();
        drop(reservation);
        let (daemon, records, monitor) = mdns_sd::ServiceDaemon::new_talebook_observer(
            port,
            vec![mdns_sd::InterfaceId::from(&interface)],
        )
        .unwrap();
        let mut session = crate::Session::from_daemon_with_resolver(
            crate::interfaces::lan_addresses().unwrap(),
            daemon,
            records,
            monitor,
            Scheduler::with_pool(pool.clone()),
        )
        .unwrap();
        session.shared.state.lock().unwrap().core = seeded_core();
        assert_eq!(observed.recv_timeout(Duration::from_secs(2)).unwrap(), 0);
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if session.snapshot().rows[0].candidates[0].joinable {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Session did not apply DNS result"
            );
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(session.snapshot().rows[0].candidates[0].base_url, BASE_URL);
        assert!(session
            .retry_hostname(ROW_ID, "https://arbitrary.example")
            .is_err());
        session.retry_hostname(ROW_ID, BASE_URL).unwrap();
        assert_eq!(
            session.snapshot().rows[0].candidates[0]
                .unavailable_reason
                .as_deref(),
            Some("hostname_unresolved")
        );
        assert_eq!(observed.recv_timeout(Duration::from_secs(2)).unwrap(), 1);
        // Stop joins the discovery worker and releases multicast even while
        // the process-wide resolver remains blocked. No DNS job holds State.
        session.stop().unwrap();
        assert_eq!(session.snapshot().status, crate::DiscoveryStatus::Stopped);
        assert!(session.snapshot().rows.is_empty());
        assert!(session.retry_hostname(ROW_ID, BASE_URL).is_err());
        let socket = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, port)).unwrap();
        drop(socket);
        let (lock, wake) = &*gate;
        *lock.lock().unwrap() = true;
        wake.notify_all();
        Arc::try_unwrap(pool).ok().unwrap().shutdown();
        assert!(session.snapshot().rows.is_empty());
    }
}
