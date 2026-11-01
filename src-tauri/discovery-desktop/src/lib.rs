//! App-owned Windows/Linux Talebook discovery. No HTTP/TCP probing occurs here.
//! A session owns its browser, worker and RR cache. Stopping joins both threads.
mod interfaces;

use mdns_sd::{DaemonEvent, RawRecordBatch, RawRecordData, ServiceDaemon};
use moke_discovery_core::{Core, DiscoveryRow, Record, RecordData};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime};

pub const SERVICE_TYPE: &str = "_talebook._tcp.local.";
const LEASE: Duration = Duration::from_secs(5);
const WORKER_TICK: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct DiscoveryError {
    pub code: String,
    pub message: String,
}

impl DiscoveryError {
    pub(crate) fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.to_owned(),
            message: message.to_owned(),
        }
    }
}
impl std::fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for DiscoveryError {}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryStatus {
    Searching,
    NetworkUnavailable,
    Error,
    Stopped,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub status: DiscoveryStatus,
    pub rows: Vec<DiscoveryRow>,
    pub error: Option<DiscoveryError>,
}

struct State {
    core: Core,
    status: DiscoveryStatus,
    error: Option<DiscoveryError>,
}
struct Shared {
    state: Mutex<State>,
    last_touch: Mutex<Instant>,
    last_touch_wall: Mutex<SystemTime>,
    stop: AtomicBool,
    epoch: Instant,
    record_liveness: mdns_sd::Receiver<RawRecordBatch>,
}

/// Fixed-type, foreground-only browsing session. The owner must stop it when
/// leaving the join page or entering the background; the five-second lease also
/// closes sockets if the WebView disappears without sending its stop command.
pub struct Session {
    shared: Arc<Shared>,
    worker: Option<JoinHandle<Result<(), DiscoveryError>>>,
}

impl Session {
    pub fn start() -> Result<Self, DiscoveryError> {
        if !cfg!(any(
            windows,
            all(target_os = "linux", not(target_env = "ohos"))
        )) {
            return Err(DiscoveryError::new(
                "unsupported",
                "当前平台尚不支持自动发现",
            ));
        }
        let network = interfaces::lan_addresses()?;
        if network.is_empty() {
            return Err(DiscoveryError::new(
                "network_unavailable",
                "没有可用的 Wi-Fi 或以太网接口",
            ));
        }
        let mut ids: Vec<_> = network.iter().map(interfaces::LanAddress::id).collect();
        ids.dedup();
        // The upstream patch applies this allowlist before it joins any group.
        // Successful construction acknowledges an actual socket/group join.
        let (daemon, records, monitor) =
            ServiceDaemon::new_talebook_observer(5353, ids).map_err(|_| {
                DiscoveryError::new("backend_failure", "无法启动局域网发现，请检查网络或防火墙")
            })?;
        Self::from_daemon(network, daemon, records, monitor)
    }

    fn from_daemon(
        network: Vec<interfaces::LanAddress>,
        daemon: ServiceDaemon,
        records: mdns_sd::Receiver<RawRecordBatch>,
        monitor: mdns_sd::Receiver<DaemonEvent>,
    ) -> Result<Self, DiscoveryError> {
        let browser = match daemon.browse(SERVICE_TYPE) {
            Ok(browser) => browser,
            Err(_) => {
                let _ = daemon.shutdown_and_join();
                return Err(DiscoveryError::new("backend_failure", "无法开始搜索服务器"));
            }
        };
        if daemon.set_ip_check_interval(1).is_err() {
            let _ = daemon.shutdown_and_join();
            return Err(DiscoveryError::new("backend_failure", "无法订阅网络变化"));
        }
        let now = Instant::now();
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                core: Core::default(),
                status: DiscoveryStatus::Searching,
                error: None,
            }),
            last_touch: Mutex::new(now),
            last_touch_wall: Mutex::new(SystemTime::now()),
            stop: AtomicBool::new(false),
            epoch: now,
            record_liveness: records.clone(),
        });
        let thread_shared = shared.clone();
        // Keep ownership outside the spawn closure until spawn succeeds. On an
        // OS thread-creation failure the daemon is stopped and joined as well.
        let owner = Arc::new(Mutex::new(Some(daemon)));
        let thread_owner = owner.clone();
        let worker = thread::Builder::new()
            .name("moke-discovery".to_owned())
            .spawn(move || {
                let daemon = thread_owner.lock().unwrap().take().unwrap();
                let result = run_worker(&thread_shared, &network, &records, &monitor, &browser);
                let shutdown = daemon
                    .shutdown_and_join()
                    .map_err(|_| DiscoveryError::new("backend_failure", "发现资源未能正常释放"));
                if let Err(error) = &shutdown {
                    finish(&thread_shared, DiscoveryStatus::Error, Some(error.clone()));
                }
                result.and(shutdown)
            })
            .map_err(|_| {
                if let Some(daemon) = owner.lock().unwrap().take() {
                    let _ = daemon.shutdown_and_join();
                }
                DiscoveryError::new("backend_failure", "无法创建发现工作线程")
            })?;
        Ok(Self {
            shared,
            worker: Some(worker),
        })
    }

    /// Every foreground IPC snapshot renews the short session lease.
    pub fn snapshot(&self) -> Snapshot {
        self.touch();
        let mut state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.status == DiscoveryStatus::Searching
            && self.shared.record_liveness.is_disconnected()
        {
            state.core.clear();
            state.status = DiscoveryStatus::Error;
            state.error = Some(DiscoveryError::new(
                "backend_failure",
                "局域网发现已中断，请重新搜索",
            ));
        }
        let rows = if state.status == DiscoveryStatus::Searching {
            state
                .core
                .snapshot(elapsed_ms(self.shared.epoch, Instant::now()))
        } else {
            Vec::new()
        };
        Snapshot {
            status: state.status,
            rows,
            error: state.error.clone(),
        }
    }

    pub fn touch(&self) {
        // CLOCK_MONOTONIC may pause during OS suspend. The wall-clock lease
        // additionally prevents a resumed WebView from reviving old candidates.
        if lease_expired(&self.shared) {
            self.shared.stop.store(true, Ordering::Release);
            finish(&self.shared, DiscoveryStatus::Stopped, None);
        }
        *self
            .shared
            .last_touch_wall
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = SystemTime::now();
        *self
            .shared
            .last_touch
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Instant::now();
    }

    pub fn stop(&mut self) -> Result<(), DiscoveryError> {
        self.shared.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            worker
                .join()
                .map_err(|_| DiscoveryError::new("backend_failure", "发现工作线程异常退出"))??;
        }
        finish(&self.shared, DiscoveryStatus::Stopped, None);
        Ok(())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn lease_expired(shared: &Shared) -> bool {
    shared
        .last_touch
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .elapsed()
        >= LEASE
        || shared
            .last_touch_wall
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .elapsed()
            .map_or(true, |elapsed| elapsed >= LEASE)
}

fn elapsed_ms(epoch: Instant, now: Instant) -> u64 {
    now.saturating_duration_since(epoch)
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn finish(shared: &Shared, status: DiscoveryStatus, error: Option<DiscoveryError>) {
    let mut state = shared.state.lock().unwrap_or_else(|p| p.into_inner());
    state.core.clear();
    state.status = status;
    state.error = error;
}

fn run_worker(
    shared: &Shared,
    initial_network: &[interfaces::LanAddress],
    records: &mdns_sd::Receiver<RawRecordBatch>,
    monitor: &mdns_sd::Receiver<DaemonEvent>,
    browser: &mdns_sd::Receiver<mdns_sd::ServiceEvent>,
) -> Result<(), DiscoveryError> {
    let mut last_network_check = Instant::now();
    loop {
        if shared.stop.load(Ordering::Acquire) || lease_expired(shared) {
            finish(shared, DiscoveryStatus::Stopped, None);
            return Ok(());
        }
        // flume reports disconnection even while older queued batches remain.
        // A lost flush/goodbye invalidates the whole session immediately.
        if records.is_disconnected() {
            return backend_failure(shared);
        }
        if last_network_check.elapsed() >= Duration::from_secs(1) {
            match interfaces::lan_addresses() {
                Ok(network) if network == initial_network => {}
                _ => {
                    finish(
                        shared,
                        DiscoveryStatus::NetworkUnavailable,
                        Some(DiscoveryError::new(
                            "network_changed",
                            "网络已变化，请重新搜索服务器",
                        )),
                    );
                    return Ok(());
                }
            }
            last_network_check = Instant::now();
        }
        // These high-level events only keep the library's resolve/query
        // subscription alive. No candidate, TTL or expiry derives from them.
        while browser.try_recv().is_ok() {}
        while let Ok(event) = monitor.try_recv() {
            match event {
                DaemonEvent::Error(_) => return backend_failure(shared),
                DaemonEvent::IpAdd(_) | DaemonEvent::IpDel(_) => {
                    finish(
                        shared,
                        DiscoveryStatus::NetworkUnavailable,
                        Some(DiscoveryError::new(
                            "network_changed",
                            "网络已变化，请重新搜索服务器",
                        )),
                    );
                    return Ok(());
                }
                _ => {}
            }
        }
        match records.recv_timeout(WORKER_TICK) {
            Ok(batch) => {
                // Receive time is captured by the socket thread, not when a
                // queued callback happens to be processed by this worker.
                let received_ms = elapsed_ms(shared.epoch, batch.received_at);
                let interface = format!("{}#{}", batch.interface.name, batch.interface.index);
                let batch = batch
                    .records
                    .into_iter()
                    .map(|record| Record {
                        interface: interface.clone(),
                        name: record.name,
                        ttl: record.ttl,
                        cache_flush: record.cache_flush,
                        data: match record.data {
                            RawRecordData::Ptr(name) => RecordData::Ptr(name),
                            RawRecordData::Srv {
                                priority,
                                weight,
                                port,
                                target,
                            } => RecordData::Srv {
                                priority,
                                weight,
                                port,
                                target,
                            },
                            RawRecordData::Txt(bytes) => RecordData::Txt(bytes),
                            RawRecordData::Address(std::net::IpAddr::V4(ip)) => RecordData::A(ip),
                            RawRecordData::Address(std::net::IpAddr::V6(ip)) => {
                                RecordData::Aaaa(ip)
                            }
                        },
                    })
                    .collect();
                shared
                    .state
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .core
                    .apply_batch(batch, received_ms);
            }
            Err(mdns_sd::RecvTimeoutError::Timeout) => {}
            // Overflow, daemon failure and normal unexpected disconnect all
            // invalidate the cache; silently losing even one flush is unsafe.
            Err(mdns_sd::RecvTimeoutError::Disconnected) => return backend_failure(shared),
        }
    }
}

fn backend_failure(shared: &Shared) -> Result<(), DiscoveryError> {
    let error = DiscoveryError::new("backend_failure", "局域网发现已中断，请重新搜索");
    finish(shared, DiscoveryStatus::Error, Some(error.clone()));
    Err(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, UdpSocket};

    fn loopback_session(network_changed: bool) -> (Session, u16) {
        let interface = if_addrs::get_if_addrs()
            .unwrap()
            .into_iter()
            .find(|i| i.is_loopback() && i.ip().is_ipv4())
            .unwrap();
        let reserved = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = reserved.local_addr().unwrap().port();
        drop(reserved);
        let (daemon, records, monitor) = ServiceDaemon::new_talebook_observer(
            port,
            vec![mdns_sd::InterfaceId::from(&interface)],
        )
        .unwrap();
        let mut network = interfaces::lan_addresses().unwrap();
        if network_changed {
            network.push(interfaces::LanAddress {
                name: "missing-test-interface".to_owned(),
                index: u32::MAX,
                address: Ipv4Addr::new(192, 168, 1, 2).into(),
            });
        }
        (
            Session::from_daemon(network, daemon, records, monitor).unwrap(),
            port,
        )
    }

    fn seed_candidate(session: &Session) {
        // Valid, decoded wire records are core's input; socket wire preservation
        // and repeated receive timestamps have independent vendor UDP tests.
        let interface = "test#1".to_owned();
        let instance = "test._talebook._tcp.local.".to_owned();
        let host = "test.local.".to_owned();
        let txt = [
            "txtvers=1",
            "id=9f0c663b-8ffd-4e13-92d9-2b68572c08b1",
            "name=Test",
            "url=http://192.168.50.10:8080",
        ]
        .into_iter()
        .flat_map(|s| std::iter::once(s.len() as u8).chain(s.bytes()))
        .collect();
        let records = [
            (SERVICE_TYPE.to_owned(), RecordData::Ptr(instance.clone())),
            (
                instance.clone(),
                RecordData::Srv {
                    priority: 0,
                    weight: 0,
                    port: 8080,
                    target: host.clone(),
                },
            ),
            (instance, RecordData::Txt(txt)),
            (host, RecordData::A(Ipv4Addr::new(192, 168, 50, 10))),
        ]
        .into_iter()
        .map(|(name, data)| Record {
            name,
            data,
            interface: interface.clone(),
            ttl: 120,
            cache_flush: false,
        })
        .collect();
        session
            .shared
            .state
            .lock()
            .unwrap()
            .core
            .apply_batch(records, 0);
        assert_eq!(session.snapshot().rows.len(), 1);
    }

    fn wire_name(value: &str) -> Vec<u8> {
        let mut bytes = Vec::new();
        for part in value.trim_end_matches('.').split('.') {
            bytes.push(part.len() as u8);
            bytes.extend_from_slice(part.as_bytes());
        }
        bytes.push(0);
        bytes
    }

    fn wire_packet(records: Vec<(&str, u16, u32, Vec<u8>)>) -> Vec<u8> {
        let mut bytes = vec![0, 0, 0x84, 0, 0, 0];
        bytes.extend_from_slice(&(records.len() as u16).to_be_bytes());
        bytes.extend_from_slice(&[0; 4]);
        for (name, kind, ttl, data) in records {
            bytes.extend_from_slice(&wire_name(name));
            bytes.extend_from_slice(&kind.to_be_bytes());
            bytes.extend_from_slice(&(if kind == 12 { 1u16 } else { 0x8001u16 }).to_be_bytes());
            bytes.extend_from_slice(&ttl.to_be_bytes());
            bytes.extend_from_slice(&(data.len() as u16).to_be_bytes());
            bytes.extend_from_slice(&data);
        }
        bytes
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "publishes a synthetic fixture on a physical LAN; run explicitly"]
    fn physical_lan_multicast_fixture_discovery_goodbye_and_stop() {
        let addresses = interfaces::lan_addresses().unwrap();
        let selected = addresses
            .iter()
            .find(|a| {
                matches!(a.address,
            std::net::IpAddr::V4(ip) if ip.is_private())
            })
            .expect("physical RFC1918 LAN required");
        let std::net::IpAddr::V4(ip) = selected.address else {
            unreachable!()
        };
        let mut session = Session::start().unwrap();
        let socket = socket2::Socket::new(
            socket2::Domain::IPV4,
            socket2::Type::DGRAM,
            Some(socket2::Protocol::UDP),
        )
        .unwrap();
        socket.set_reuse_address(true).unwrap();
        socket
            .bind(&std::net::SocketAddr::new(ip.into(), 5353).into())
            .unwrap();
        socket.set_multicast_if_v4(&ip).unwrap();
        socket.set_multicast_loop_v4(true).unwrap();
        socket.set_multicast_ttl_v4(255).unwrap();
        let destination: socket2::SockAddr =
            std::net::SocketAddr::new(Ipv4Addr::new(224, 0, 0, 251).into(), 5353).into();
        let instance = format!(
            "Moke-TB446-fixture-{}._talebook._tcp.local.",
            std::process::id()
        );
        let host = format!("moke-tb446-fixture-{}.local.", std::process::id());
        let fixture_id = "00000000-0000-4000-8000-00000000446a";
        let url = format!("http://{ip}:24946");
        let properties = [
            "txtvers=1".to_owned(),
            format!("id={fixture_id}"),
            "name=Moke native multicast test fixture".to_owned(),
            format!("url={url}"),
        ];
        let txt: Vec<u8> = properties
            .iter()
            .flat_map(|s| std::iter::once(s.len() as u8).chain(s.bytes()))
            .collect();
        let mut srv = vec![0, 0, 0, 0];
        srv.extend_from_slice(&24946u16.to_be_bytes());
        srv.extend_from_slice(&wire_name(&host));
        let fixture = |ttl| {
            wire_packet(vec![
                (SERVICE_TYPE, 12, ttl, wire_name(&instance)),
                (&instance, 33, ttl, srv.clone()),
                (&instance, 16, ttl, txt.clone()),
                (&host, 1, ttl, ip.octets().to_vec()),
            ])
        };
        let start = Instant::now();
        socket.send_to(&fixture(120), &destination).unwrap();
        let first_deadline = start + Duration::from_secs(10);
        let found = loop {
            if let Some(row) = session
                .snapshot()
                .rows
                .into_iter()
                .find(|r| r.id == fixture_id)
            {
                break row;
            }
            assert!(
                Instant::now() < first_deadline,
                "synthetic multicast fixture not received"
            );
            thread::sleep(Duration::from_millis(20));
        };
        assert!(found.candidates.iter().any(|c| c.base_url == url
            && c.joinable
            && c.sources
                .iter()
                .any(|s| s.interface == format!("{}#{}", selected.name, selected.index))));
        eprintln!(
            "LAN fixture: interface={} first_row_ms={}",
            selected.name,
            start.elapsed().as_millis()
        );
        let goodbye = Instant::now();
        socket.send_to(&fixture(0), &destination).unwrap();
        while session.snapshot().rows.iter().any(|r| r.id == fixture_id) {
            assert!(
                goodbye.elapsed() < Duration::from_secs(5),
                "goodbye fixture not removed"
            );
            thread::sleep(Duration::from_millis(20));
        }
        eprintln!(
            "LAN fixture: goodbye_removed_ms={}",
            goodbye.elapsed().as_millis()
        );
        session.stop().unwrap();
        assert_eq!(session.snapshot().status, DiscoveryStatus::Stopped);
        assert!(session.snapshot().rows.is_empty());
        assert!(session.worker.is_none());
        drop(socket);
    }

    #[test]
    fn actual_udp_txt_refresh_and_independent_expiry_drive_clickable_rows() {
        let (mut session, port) = loopback_session(false);
        let instance = "wire._talebook._tcp.local.";
        let host = "wire.local.";
        let txt: Vec<u8> = [
            "txtvers=1",
            "id=9f0c663b-8ffd-4e13-92d9-2b68572c08b1",
            "name=Wire",
            "url=http://192.168.50.10:8080",
        ]
        .into_iter()
        .flat_map(|s| std::iter::once(s.len() as u8).chain(s.bytes()))
        .collect();
        let mut srv = vec![0, 0, 0, 0, 0x1f, 0x90];
        srv.extend_from_slice(&wire_name(host));
        let packet = wire_packet(vec![
            (SERVICE_TYPE, 12, 120, wire_name(instance)),
            (instance, 33, 120, srv),
            (instance, 16, 2, txt.clone()),
            (host, 1, 120, vec![192, 168, 50, 10]),
        ]);
        let sender = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        sender
            .send_to(&packet, (Ipv4Addr::LOCALHOST, port))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        while session.snapshot().rows.is_empty() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let row = session
            .snapshot()
            .rows
            .pop()
            .expect("complete wire records form a row");
        assert!(row.candidates[0].joinable);
        assert_eq!(row.candidates[0].base_url, "http://192.168.50.10:8080");
        thread::sleep(Duration::from_millis(1100));
        let refresh = wire_packet(vec![(instance, 16, 2, txt)]);
        sender
            .send_to(&refresh, (Ipv4Addr::LOCALHOST, port))
            .unwrap();
        thread::sleep(Duration::from_millis(1200));
        // Past the original TXT deadline; unchanged wire TXT receipt extended it.
        assert_eq!(session.snapshot().rows.len(), 1);
        thread::sleep(Duration::from_millis(1000));
        // Other records still have ~116 seconds. TXT alone must disable the row,
        // even though stock mdns-sd sends no ServiceRemoved for this expiry.
        assert!(session.snapshot().rows.is_empty());
        session.stop().unwrap();
    }

    #[test]
    fn explicit_stop_clears_candidates_joins_threads_and_releases_udp() {
        let (mut session, port) = loopback_session(false);
        seed_candidate(&session);
        session.stop().unwrap();
        assert_eq!(session.snapshot().status, DiscoveryStatus::Stopped);
        assert!(session.snapshot().rows.is_empty());
        assert!(session.worker.is_none());
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, port)).unwrap();
        drop(socket);
    }

    #[test]
    fn expired_foreground_lease_stops_socket_without_a_webview_stop() {
        let (mut session, port) = loopback_session(false);
        seed_candidate(&session);
        *session.shared.last_touch.lock().unwrap() =
            Instant::now() - LEASE - Duration::from_millis(1);
        session.worker.take().unwrap().join().unwrap().unwrap();
        assert_eq!(session.snapshot().status, DiscoveryStatus::Stopped);
        assert!(session.snapshot().rows.is_empty());
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, port)).unwrap();
        drop(socket);
    }

    #[test]
    fn network_change_clears_source_state_and_stops_before_refresh() {
        let (mut session, port) = loopback_session(true);
        seed_candidate(&session);
        session.worker.take().unwrap().join().unwrap().unwrap();
        let snapshot = session.snapshot();
        assert_eq!(snapshot.status, DiscoveryStatus::NetworkUnavailable);
        assert_eq!(snapshot.error.unwrap().code, "network_changed");
        assert!(snapshot.rows.is_empty());
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, port)).unwrap();
        drop(socket);
    }
}
