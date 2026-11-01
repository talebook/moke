//! Moke-only observation of actual response records. See MOKE-PATCH.md.
use crate::dns_parser::{DnsAddress, DnsPointer, DnsRecordBox, DnsSrv, DnsTxt};
use crate::{InterfaceId, RRType};
use std::net::IpAddr;
use std::time::Instant;

/// Decoded RDATA; TXT remains the exact wire bytes, including malformed strings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RawRecordData {
    Ptr(String),
    Srv {
        priority: u16,
        weight: u16,
        port: u16,
        target: String,
    },
    Txt(Vec<u8>),
    Address(IpAddr),
}

/// An actual RR receipt, never a synthetic cache replay or high-level resolution.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawRecord {
    pub name: String,
    /// Original TTL: a goodbye is zero, before upstream's one-second normalization.
    pub ttl: u32,
    pub cache_flush: bool,
    pub data: RawRecordData,
}

/// One successfully decoded DNS response, with its local receiving interface.
#[derive(Clone, Debug)]
pub struct RawRecordBatch {
    pub received_at: Instant,
    pub interface: InterfaceId,
    pub records: Vec<RawRecord>,
}

pub(crate) fn observe(record: &DnsRecordBox, ttl: u32) -> Option<RawRecord> {
    if record.get_class() != crate::dns_parser::CLASS_IN {
        return None;
    }
    let name = record.get_name();
    let lower = name.to_ascii_lowercase();
    const SERVICE: &str = "_talebook._tcp.local.";
    let data = if let Some(ptr) = record.any().downcast_ref::<DnsPointer>() {
        if record.get_type() != RRType::PTR
            || lower != SERVICE
            || !ptr
                .alias()
                .to_ascii_lowercase()
                .ends_with(&format!(".{SERVICE}"))
        {
            return None;
        }
        RawRecordData::Ptr(ptr.alias().to_owned())
    } else if let Some(srv) = record.any().downcast_ref::<DnsSrv>() {
        if !lower.ends_with(&format!(".{SERVICE}")) {
            return None;
        }
        RawRecordData::Srv {
            priority: srv.priority,
            weight: srv.weight,
            port: srv.port(),
            target: srv.host().to_owned(),
        }
    } else if let Some(txt) = record.any().downcast_ref::<DnsTxt>() {
        if !lower.ends_with(&format!(".{SERVICE}")) {
            return None;
        }
        RawRecordData::Txt(txt.text().to_vec())
    } else if let Some(addr) = record.any().downcast_ref::<DnsAddress>() {
        // Host records may arrive in separate responses. The app core retains
        // a bounded passive address cache; candidates still require a complete
        // Talebook PTR/SRV/TXT chain on this same interface.
        RawRecordData::Address(addr.address().to_ip_addr())
    } else {
        return None;
    };
    Some(RawRecord {
        name: name.to_owned(),
        ttl,
        cache_flush: record.get_cache_flush(),
        data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dns_parser::DnsIncoming;
    use crate::{ServiceDaemon, TryRecvError};
    use std::net::UdpSocket;
    use std::time::Duration;

    const INSTANCE: &str = "socket-test._talebook._tcp.local.";
    const HOST: &str = "socket-test.local.";

    fn name(value: &str) -> Vec<u8> {
        let mut output = Vec::new();
        for label in value.trim_end_matches('.').split('.') {
            output.push(label.len() as u8);
            output.extend_from_slice(label.as_bytes());
        }
        output.push(0);
        output
    }

    fn packet(records: Vec<(&str, u16, u16, u32, Vec<u8>)>) -> Vec<u8> {
        let mut packet = vec![0, 0, 0x84, 0, 0, 0];
        packet.extend_from_slice(&(records.len() as u16).to_be_bytes());
        packet.extend_from_slice(&[0; 4]);
        for (owner, kind, class, ttl, data) in records {
            packet.extend_from_slice(&name(owner));
            packet.extend_from_slice(&kind.to_be_bytes());
            packet.extend_from_slice(&class.to_be_bytes());
            packet.extend_from_slice(&ttl.to_be_bytes());
            packet.extend_from_slice(&(data.len() as u16).to_be_bytes());
            packet.extend_from_slice(&data);
        }
        packet
    }

    fn announcement(ttl: u32, txt: Vec<u8>) -> Vec<u8> {
        let mut srv = vec![0, 0, 0, 0, 0x1f, 0x90];
        srv.extend_from_slice(&name(HOST));
        packet(vec![
            ("_talebook._tcp.local.", 12, 1, ttl, name(INSTANCE)),
            (INSTANCE, 33, 0x8001, ttl, srv),
            (INSTANCE, 16, 0x8001, ttl, txt),
            (HOST, 1, 0x8001, ttl, vec![192, 168, 50, 10]),
        ])
    }

    #[test]
    fn original_goodbye_txt_order_and_flush_survive_wire_parser() {
        let txt = vec![3, b'A', b'=', b'1', 3, b'a', b'=', b'2', 12, 255];
        let incoming =
            DnsIncoming::new(announcement(0, txt.clone()), InterfaceId::default()).unwrap();
        let observed = incoming.observed_records();
        assert_eq!(observed.len(), 4);
        assert!(observed.iter().all(|r| r.ttl == 0));
        assert!(!observed[0].cache_flush);
        assert!(observed[2].cache_flush);
        assert_eq!(observed[2].data, RawRecordData::Txt(txt));
    }

    #[test]
    fn cname_wrong_class_and_other_service_are_never_observed() {
        let wire = packet(vec![
            ("_talebook._tcp.local.", 5, 1, 120, name(INSTANCE)), // CNAME
            ("_talebook._tcp.local.", 12, 3, 120, name(INSTANCE)), // CHAOS
            (
                "_talebook._tcp.local.",
                12,
                1,
                120,
                name("evil._ssh._tcp.local."),
            ),
            (
                "_ssh._tcp.local.",
                12,
                1,
                120,
                name("evil._ssh._tcp.local."),
            ),
            (HOST, 1, 255, 120, vec![192, 168, 1, 2]), // ANY class
        ]);
        let incoming = DnsIncoming::new(wire, InterfaceId::default()).unwrap();
        assert!(incoming.observed_records().is_empty());
    }

    fn socket_browser() -> (
        ServiceDaemon,
        crate::Receiver<RawRecordBatch>,
        u16,
        InterfaceId,
    ) {
        let interface = if_addrs::get_if_addrs()
            .unwrap()
            .into_iter()
            .find(|i| i.is_loopback() && i.ip().is_ipv4())
            .expect("IPv4 loopback required");
        let id = InterfaceId::from(&interface);
        let reserved = UdpSocket::bind("127.0.0.1:0").unwrap();
        let port = reserved.local_addr().unwrap().port();
        drop(reserved);
        let (daemon, records, _) =
            ServiceDaemon::new_talebook_observer(port, vec![id.clone()]).unwrap();
        let _browser = daemon.browse("_talebook._tcp.local.").unwrap();
        (daemon, records, port, id)
    }

    #[test]
    fn actual_udp_repeats_preserve_receipt_interface_and_shutdown_releases_socket() {
        let (daemon, records, port, id) = socket_browser();
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        let packet = announcement(120, vec![1, b'x']);
        sender
            .send_to(&packet, (std::net::Ipv4Addr::LOCALHOST, port))
            .unwrap();
        let first = records.recv_timeout(Duration::from_secs(2)).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        sender
            .send_to(&packet, (std::net::Ipv4Addr::LOCALHOST, port))
            .unwrap();
        let refreshed = records.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(first.interface, id);
        assert_eq!(refreshed.interface, id);
        assert_eq!(first.records, refreshed.records);
        assert!(refreshed.received_at > first.received_at);
        sender
            .send_to(
                &announcement(0, vec![9, 255]),
                (std::net::Ipv4Addr::LOCALHOST, port),
            )
            .unwrap();
        let goodbye = records.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(goodbye.records.iter().all(|record| record.ttl == 0));
        assert_eq!(goodbye.records[2].data, RawRecordData::Txt(vec![9, 255]));
        daemon.shutdown_and_join().unwrap();
        assert!(matches!(
            records.try_recv(),
            Err(TryRecvError::Disconnected)
        ));
        // A non-reuse socket can bind only after every daemon clone/socket closes.
        let rebound = UdpSocket::bind((std::net::Ipv4Addr::UNSPECIFIED, port)).unwrap();
        drop(rebound);
    }

    #[test]
    fn actual_udp_cache_resource_limit_disconnects_instead_of_retaining_stale_state() {
        let (daemon, records, port, _) = socket_browser();
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        for group in 0..7 {
            let owners: Vec<_> = (0..100)
                .map(|i| format!("noise-{group}-{i}.local."))
                .collect();
            let wire = packet(
                owners
                    .iter()
                    .map(|owner| (owner.as_str(), 1, 1, 120, vec![192, 168, 1, 2]))
                    .collect(),
            );
            sender
                .send_to(&wire, (std::net::Ipv4Addr::LOCALHOST, port))
                .unwrap();
            // Consume the event immediately: this tests the upstream cache cap,
            // rather than accidentally exercising the observer queue cap.
            if records.recv_timeout(Duration::from_secs(2)).is_err() {
                break;
            }
        }
        while records.recv_timeout(Duration::from_secs(2)).is_ok() {}
        assert!(matches!(
            records.try_recv(),
            Err(TryRecvError::Disconnected)
        ));
        daemon.shutdown_and_join().unwrap();
    }
}
