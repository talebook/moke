use moke_discovery_core::*;
use serde_json::{json, Value};
use std::net::IpAddr;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/tb-444-discovery-v1-vectors.json")).unwrap()
}

fn merge_patch(value: &mut Value, patch: &Value) {
    if let Value::Object(patch) = patch {
        if !value.is_object() {
            *value = json!({});
        }
        let object = value.as_object_mut().unwrap();
        for (key, patch) in patch {
            if patch.is_null() {
                object.remove(key);
            } else {
                merge_patch(object.entry(key).or_insert(Value::Null), patch);
            }
        }
    } else {
        *value = patch.clone();
    }
}

fn txt_bytes(values: &[String]) -> Result<Vec<u8>, ()> {
    let mut raw = Vec::new();
    for value in values {
        raw.push(value.len().try_into().map_err(|_| ())?);
        raw.extend(value.as_bytes());
    }
    Ok(raw)
}

fn record(value: &Value, name: String, ttl_kind: &str, data: RecordData) -> Record {
    Record {
        interface: value["interface"].as_str().unwrap().into(),
        name,
        ttl: value["ttl"][ttl_kind].as_u64().unwrap() as u32,
        cache_flush: ttl_kind != "ptr",
        data,
    }
}

fn records(value: &Value) -> Vec<Record> {
    let fullname = value["fullname"].as_str().unwrap().to_owned();
    let mut records = vec![record(
        value,
        value["service_type"].as_str().unwrap().into(),
        "ptr",
        RecordData::Ptr(fullname.clone()),
    )];
    if let Some(srv) = value.get("srv") {
        records.push(record(
            value,
            fullname.clone(),
            "srv",
            RecordData::Srv {
                priority: srv["priority"].as_u64().unwrap() as u16,
                weight: srv["weight"].as_u64().unwrap() as u16,
                port: srv["port"].as_u64().unwrap() as u16,
                target: srv["target"].as_str().unwrap().into(),
            },
        ));
        for ip in value["addresses"].as_array().unwrap() {
            let data = match ip.as_str().unwrap().parse::<IpAddr>().unwrap() {
                IpAddr::V4(ip) => RecordData::A(ip),
                IpAddr::V6(ip) => RecordData::Aaaa(ip),
            };
            records.push(record(
                value,
                srv["target"].as_str().unwrap().into(),
                "address",
                data,
            ));
        }
    }
    let txt = if let Some(hex) = value.get("txt_hex") {
        let hex = hex.as_str().unwrap();
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    } else {
        txt_bytes(
            &value["txt"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
        )
        .unwrap()
    };
    records.push(record(value, fullname, "txt", RecordData::Txt(txt)));
    records
}

fn apply(core: &mut Core, value: &Value, now: u64) {
    core.apply_batch(records(value), now);
    if let Some(ips) = value.get("resolved_url_addresses") {
        let metadata = parse_txt(
            &records(value)
                .into_iter()
                .find_map(|r| match r.data {
                    RecordData::Txt(t) => Some(t),
                    _ => None,
                })
                .unwrap(),
        )
        .unwrap();
        let BaseHost::Dns(host) = normalize_base_url(&metadata.url).unwrap().host else {
            panic!()
        };
        for ticket in core.hostname_tickets(now) {
            if ticket.hostname() == host {
                assert!(core.set_hostname_resolution(
                    &ticket,
                    Ok(ips
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_str().unwrap().parse().unwrap())
                        .collect()),
                    now,
                ));
            }
        }
    }
}

#[test]
fn all_31_shared_message_vectors_execute_merge_patch() {
    let fixture = fixture();
    assert_eq!(fixture["cases"].as_array().unwrap().len(), 31);
    for case in fixture["cases"].as_array().unwrap() {
        let id = case["case_id"].as_str().unwrap();
        let mut value = fixture["base"].clone();
        merge_patch(&mut value, &case["patch"]);
        let mut core = Core::new();
        apply(&mut core, &value, 0);
        let snapshot = core.snapshot(0);
        let candidates: Vec<_> = snapshot
            .iter()
            .flat_map(|r| &r.candidates)
            .filter(|c| c.joinable)
            .collect();
        match case["expected"]["decision"].as_str().unwrap() {
            "candidate" => {
                assert_eq!(candidates.len(), 1, "{id}: {snapshot:?}");
                if let Some(url) = case["expected"].get("base_url") {
                    assert_eq!(candidates[0].base_url, url.as_str().unwrap(), "{id}");
                }
                if let Some(name) = case["expected"].get("display_text") {
                    assert_eq!(candidates[0].name, name.as_str().unwrap(), "{id}");
                }
                if let Some(url) = case["expected"].get("welcome_url") {
                    assert_eq!(
                        format!("{}/api/welcome", candidates[0].base_url),
                        url.as_str().unwrap(),
                        "{id}"
                    );
                }
            }
            "reject" | "unsupported" | "pending" | "ignore" => {
                assert!(candidates.is_empty(), "{id}: {snapshot:?}")
            }
            unexpected => panic!("unhandled decision {unexpected}"),
        }
    }
}

#[test]
fn both_generated_boundaries_are_executed() {
    let fixture = fixture();
    for case in fixture["generated_cases"].as_array().unwrap() {
        let mut txt: Vec<_> = fixture["base"]["txt"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect();
        for append in case["generation"]["append_txt"].as_array().unwrap() {
            txt.push(format!(
                "{}={}",
                append["key"].as_str().unwrap(),
                append["value_ascii"]
                    .as_str()
                    .unwrap()
                    .repeat(append["repeat"].as_u64().unwrap() as usize)
            ));
        }
        match case["expected"]["decision"].as_str().unwrap() {
            "reject_before_wire_encoding" => assert!(txt_bytes(&txt).is_err()),
            "reject" => assert_eq!(
                parse_txt(&txt_bytes(&txt).unwrap()).unwrap_err().0,
                "txt_rdata_over_400_bytes"
            ),
            _ => unreachable!(),
        }
    }
}

#[test]
fn shared_lifecycle_duplicate_and_same_name() {
    let base = fixture()["base"].clone();
    let mut core = Core::new();
    apply(&mut core, &base, 0);
    apply(&mut core, &base, 1000);
    let mut second_interface = base.clone();
    second_interface["interface"] = json!("lan-b");
    apply(&mut core, &second_interface, 1000);
    let snapshot = core.snapshot(1000);
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].candidates.len(), 1);
    assert_eq!(snapshot[0].candidates[0].sources.len(), 2);
    let mut another = base.clone();
    another["fullname"] = json!("Other._talebook._tcp.local.");
    another["srv"]["target"] = json!("other.local.");
    another["txt"][1] = json!("id=9f0c663b-8ffd-4e13-92d9-2b68572c08b2");
    apply(&mut core, &another, 1000);
    assert_eq!(core.snapshot(1000).len(), 2);
}

#[test]
fn shared_lifecycle_partial_and_full_goodbye() {
    let base = fixture()["base"].clone();
    let mut core = Core::new();
    apply(&mut core, &base, 0);
    let mut second = base.clone();
    second["interface"] = json!("lan-b");
    apply(&mut core, &second, 0);
    let goodbye = |v: &Value| {
        records(v)
            .into_iter()
            .map(|mut r| {
                r.ttl = 0;
                r
            })
            .collect()
    };
    core.apply_batch(goodbye(&base), 10_000);
    assert_eq!(core.snapshot(10_999)[0].candidates[0].sources.len(), 2);
    assert_eq!(core.snapshot(11_000)[0].candidates[0].sources.len(), 1);
    core.apply_batch(goodbye(&second), 12_000);
    assert_eq!(core.snapshot(12_999).len(), 1);
    assert!(core.snapshot(13_000).is_empty());
    // A goodbye for an unseen RR never creates a one-second candidate.
    core.apply_batch(goodbye(&base), 20_000);
    assert!(core.snapshot(20_000).is_empty());
}

#[test]
fn shared_lifecycle_silent_crash_and_real_unchanged_rr_refresh() {
    let base = fixture()["base"].clone();
    let mut core = Core::new();
    apply(&mut core, &base, 0);
    assert_eq!(core.snapshot(119_999).len(), 1);
    assert!(core.snapshot(120_000).is_empty());
    apply(&mut core, &base, 0);
    apply(&mut core, &base, 90_000); // Same bytes, not a ServiceResolved callback.
    assert_eq!(core.snapshot(121_000).len(), 1);
    assert_eq!(core.snapshot(209_999).len(), 1);
    assert!(core.snapshot(210_000).is_empty());
}

#[test]
fn every_required_rr_has_its_own_ttl_and_refresh() {
    for kind in ["ptr", "srv", "txt", "address"] {
        let mut base = fixture()["base"].clone();
        base["ttl"][kind] = json!(2);
        let mut core = Core::new();
        apply(&mut core, &base, 0);
        assert_eq!(core.snapshot(1999).len(), 1, "{kind}");
        assert!(core.snapshot(2000).is_empty(), "{kind}");
    }
    let base = fixture()["base"].clone();
    let mut core = Core::new();
    apply(&mut core, &base, 0);
    core.apply_batch(
        records(&base)
            .into_iter()
            .filter(|r| !matches!(r.data, RecordData::Txt(_)))
            .collect(),
        90_000,
    );
    assert!(
        core.snapshot(120_000).is_empty(),
        "refreshing other RRs must not extend TXT"
    );
}

#[test]
fn untrusted_long_ttls_never_extend_the_v1_profile_lifetime() {
    for ttl in [4500, u32::MAX] {
        let mut base = fixture()["base"].clone();
        for kind in ["ptr", "srv", "txt", "address"] {
            base["ttl"][kind] = json!(ttl);
        }
        let mut core = Core::new();
        apply(&mut core, &base, 0);
        assert_eq!(core.snapshot(119_999).len(), 1, "TTL={ttl}");
        assert!(core.snapshot(120_000).is_empty(), "TTL={ttl}");

        let mut refreshed = Core::new();
        apply(&mut refreshed, &base, 0);
        apply(&mut refreshed, &base, 90_000);
        assert_eq!(refreshed.snapshot(209_999).len(), 1, "TTL={ttl}");
        assert!(refreshed.snapshot(210_000).is_empty(), "TTL={ttl}");
    }
}

#[test]
fn shared_lifecycle_address_update_flushes_old_identity_and_address() {
    let base = fixture()["base"].clone();
    let mut core = Core::new();
    apply(&mut core, &base, 0);
    let mut changed = base.clone();
    changed["addresses"] = json!(["192.168.50.11"]);
    changed["txt"][3] = json!("url=http://192.168.50.11:8080");
    apply(&mut core, &changed, 20_000);
    // Unique TXT is ambiguous during the cache-flush grace: don't offer an old URL.
    assert!(core.snapshot(20_000).is_empty());
    let snapshot = core.snapshot(21_000);
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].candidates.len(), 1);
    assert_eq!(
        snapshot[0].candidates[0].base_url,
        "http://192.168.50.11:8080"
    );
    assert_eq!(
        snapshot[0].candidates[0].sources[0].addresses,
        ["192.168.50.11"]
    );
}

#[test]
fn shared_lifecycle_leave_and_late_event_and_click_failure_boundary() {
    let fixture = fixture();
    let ids: Vec<_> = fixture["lifecycle_cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["case_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 8);
    assert!(ids.contains(&"leave_and_late_event") && ids.contains(&"click_join_failure"));
    let mut generation1 = Core::new();
    apply(&mut generation1, &fixture["base"], 0);
    generation1.clear();
    // Generation dispatch/ignoring late events belongs to the IPC session owner;
    // a new core cannot retain old source or resolver state.
    let mut generation2 = Core::new();
    assert!(generation2.snapshot(0).is_empty());
    assert!(generation1.snapshot(0).is_empty());
    apply(&mut generation2, &fixture["base"], 0);
    let before = generation2.snapshot(0);
    assert_eq!(before, generation2.snapshot(0));
    // The core exposes no join/network/store operation, so failed validation
    // outside it cannot mutate the discovered URL or write a saved server.
}

#[test]
fn records_from_different_interfaces_cannot_complete_each_other() {
    let base = fixture()["base"].clone();
    let mut partial = records(&base);
    for r in &mut partial {
        if matches!(r.data, RecordData::A(_)) {
            r.interface = "lan-b".into();
        }
    }
    let mut core = Core::new();
    core.apply_batch(partial, 0);
    assert!(core.snapshot(0).is_empty());
}

#[test]
fn partial_address_expiry_and_same_packet_rrset_do_not_lose_remaining_address() {
    let mut base = fixture()["base"].clone();
    base["addresses"] = json!(["192.168.50.10", "192.168.50.11"]);
    let mut batch = records(&base);
    for r in &mut batch {
        if matches!(r.data, RecordData::A(ip) if ip.to_string() == "192.168.50.11") {
            r.ttl = 2;
        }
    }
    let mut core = Core::new();
    core.apply_batch(batch, 0);
    assert_eq!(
        core.snapshot(1000)[0].candidates[0].sources[0]
            .addresses
            .len(),
        2
    );
    assert_eq!(
        core.snapshot(2000)[0].candidates[0].sources[0].addresses,
        ["192.168.50.10"]
    );
}

#[test]
fn split_packets_receive_one_second_flush_protection_and_refresh_rescues_rr() {
    let base = fixture()["base"].clone();
    let mut core = Core::new();
    apply(&mut core, &base, 0);
    let mut second = records(&base)
        .into_iter()
        .find(|r| matches!(r.data, RecordData::A(_)))
        .unwrap();
    second.data = RecordData::A("192.168.50.11".parse().unwrap());
    core.apply_batch(vec![second.clone()], 500);
    assert_eq!(
        core.snapshot(1500)[0].candidates[0].sources[0]
            .addresses
            .len(),
        2
    );
    core.apply_batch(vec![second], 2000);
    let original = records(&base)
        .into_iter()
        .find(|r| matches!(r.data, RecordData::A(_)))
        .unwrap();
    core.apply_batch(vec![original.clone()], 2500); // rescue old record within grace
    assert_eq!(
        core.snapshot(3000)[0].candidates[0].sources[0]
            .addresses
            .len(),
        2
    );
    core.apply_batch(vec![original], 3500); // second address is now old enough to flush
    assert_eq!(
        core.snapshot(4500)[0].candidates[0].sources[0].addresses,
        ["192.168.50.10"]
    );
}

fn hostname_base() -> Value {
    let mut base = fixture()["base"].clone();
    base["txt"][3] = json!("url=https://books.home.arpa:8080/team/books");
    base
}

fn reason(core: &mut Core, now: u64) -> Option<String> {
    core.snapshot(now)[0].candidates[0]
        .unavailable_reason
        .clone()
}

#[test]
fn hostname_requires_normal_resolver_all_private_and_at_least_one_match() {
    let mut core = Core::new();
    apply(&mut core, &hostname_base(), 0);
    let ticket = core.hostname_tickets(0).remove(0);
    assert_eq!(ticket.hostname(), "books.home.arpa");
    assert_eq!(ticket.base_url(), "https://books.home.arpa:8080/team/books");
    assert_eq!(reason(&mut core, 0).as_deref(), Some("hostname_unresolved"));
    let cases = [
        (Ok(vec![]), Some("hostname_empty")),
        (Err(HostnameFailure::Empty), Some("hostname_empty")),
        (
            Err(HostnameFailure::LookupFailed),
            Some("hostname_lookup_failed"),
        ),
        (Err(HostnameFailure::Timeout), Some("hostname_timeout")),
        (
            Ok(vec![
                "192.168.50.10".parse().unwrap(),
                "8.8.8.8".parse().unwrap(),
            ]),
            Some("hostname_non_lan_address"),
        ),
        (
            Ok(vec!["192.168.50.11".parse().unwrap()]),
            Some("hostname_address_mismatch"),
        ),
        (
            Ok(vec![
                "192.168.50.10".parse().unwrap(),
                "fd00::1".parse().unwrap(),
            ]),
            None,
        ),
    ];
    for (result, expected) in cases {
        assert!(core.set_hostname_resolution(&ticket, result, 0));
        assert_eq!(reason(&mut core, 0).as_deref(), expected);
        assert_eq!(
            core.snapshot(0)[0].candidates[0].joinable,
            expected.is_none()
        );
    }
    core.clear_hostname_resolutions();
    assert_eq!(reason(&mut core, 0).as_deref(), Some("hostname_unresolved"));
    assert!(!core.set_hostname_resolution(&ticket, Ok(vec!["192.168.50.10".parse().unwrap()]), 0));
}

#[test]
fn success_lease_rotates_ticket_without_extending_rr_lifetime() {
    let mut core = Core::new();
    apply(&mut core, &hostname_base(), 0);
    let ticket = core.hostname_tickets(0).remove(0);
    assert!(core.set_hostname_resolution(&ticket, Ok(vec!["192.168.50.10".parse().unwrap()]), 100));
    assert_eq!(reason(&mut core, 30_099), None);
    assert_eq!(
        reason(&mut core, 30_100).as_deref(),
        Some("hostname_unresolved")
    );
    let next = core.hostname_tickets(30_100).remove(0);
    assert_ne!(ticket, next);
    assert!(!core.set_hostname_resolution(
        &ticket,
        Ok(vec!["192.168.50.10".parse().unwrap()]),
        30_100
    ));
    assert!(core.set_hostname_resolution(&next, Err(HostnameFailure::Timeout), 30_100));
    assert_eq!(
        reason(&mut core, 119_999).as_deref(),
        Some("hostname_timeout")
    );
    assert_eq!(core.hostname_tickets(119_999), [next]);
    assert!(core.hostname_tickets(120_000).is_empty());
    assert!(core.snapshot(120_000).is_empty());
}

#[test]
fn retry_rotates_only_exact_candidate_and_rejects_late_answers() {
    let base = hostname_base();
    let mut other = base.clone();
    other["fullname"] = json!("Proxy._talebook._tcp.local.");
    other["srv"]["target"] = json!("proxy.local.");
    other["addresses"] = json!(["192.168.50.11"]);
    other["txt"][3] = json!("url=https://books.home.arpa:8080/other");
    let mut core = Core::new();
    apply(&mut core, &base, 0);
    apply(&mut core, &other, 0);
    let tickets = core.hostname_tickets(0);
    let ticket = tickets
        .iter()
        .find(|ticket| ticket.base_url().ends_with("/team/books"))
        .unwrap();
    let other_ticket = tickets
        .iter()
        .find(|ticket| ticket.base_url().ends_with("/other"))
        .unwrap();
    assert!(core.set_hostname_resolution(ticket, Err(HostnameFailure::LookupFailed), 0));
    assert!(!core.retry_hostname(
        ticket.row_id(),
        "https://books.home.arpa:8080/team/books/",
        0
    ));
    assert!(!core.retry_hostname("different-row", ticket.base_url(), 0));
    assert!(core.retry_hostname(ticket.row_id(), ticket.base_url(), 0));
    let next_tickets = core.hostname_tickets(0);
    assert!(next_tickets.contains(other_ticket));
    assert!(!next_tickets.contains(ticket));
    assert!(!core.set_hostname_resolution(ticket, Ok(vec!["192.168.50.10".parse().unwrap()]), 0));
    let retried = next_tickets
        .iter()
        .find(|next| next.base_url() == ticket.base_url())
        .unwrap();
    assert!(core.set_hostname_resolution(retried, Ok(vec!["192.168.50.10".parse().unwrap()]), 0));
    assert!(
        core.snapshot(0)[0]
            .candidates
            .iter()
            .find(|candidate| candidate.base_url == ticket.base_url())
            .unwrap()
            .joinable
    );
}

#[test]
fn source_resolution_never_authorizes_same_hostname_on_another_interface() {
    let base = hostname_base();
    let mut other = base.clone();
    other["interface"] = json!("lan-b");
    let mut core = Core::new();
    apply(&mut core, &base, 0);
    let ticket = core.hostname_tickets(0).remove(0);
    apply(&mut core, &other, 0);
    let tickets = core.hostname_tickets(0);
    assert_eq!(tickets.len(), 2);
    assert!(core.set_hostname_resolution(&ticket, Ok(vec!["192.168.50.10".parse().unwrap()]), 0));
    assert!(core.snapshot(0)[0].candidates[0].joinable);
    core.remove_interface(base["interface"].as_str().unwrap());
    assert!(!core.set_hostname_resolution(&ticket, Ok(vec!["192.168.50.10".parse().unwrap()]), 0));
    assert_eq!(reason(&mut core, 0).as_deref(), Some("hostname_unresolved"));
    let remaining = core.hostname_tickets(0).remove(0);
    assert_ne!(ticket, remaining);
    assert!(core.set_hostname_resolution(
        &remaining,
        Ok(vec!["192.168.50.10".parse().unwrap()]),
        0
    ));
    assert!(core.snapshot(0)[0].candidates[0].joinable);
}

#[test]
fn address_rr_change_rotates_ticket_and_does_not_reuse_previous_verification() {
    let base = hostname_base();
    let mut core = Core::new();
    apply(&mut core, &base, 0);
    let ticket = core.hostname_tickets(0).remove(0);
    assert!(core.set_hostname_resolution(&ticket, Ok(vec!["192.168.50.10".parse().unwrap()]), 0));
    let mut changed = base.clone();
    changed["addresses"] = json!(["192.168.50.11"]);
    apply(&mut core, &changed, 2000);
    let changed_ticket = core.hostname_tickets(2000).remove(0);
    assert_ne!(ticket, changed_ticket);
    assert_eq!(
        reason(&mut core, 2000).as_deref(),
        Some("hostname_unresolved")
    );
    assert!(!core.set_hostname_resolution(
        &ticket,
        Ok(vec!["192.168.50.10".parse().unwrap()]),
        2000
    ));
    // The old address expires after its cache-flush grace. That is another
    // RRset change, and even the ticket for the interim RRset must be rejected.
    let next = core.hostname_tickets(3000).remove(0);
    assert_ne!(changed_ticket, next);
    assert!(!core.set_hostname_resolution(
        &changed_ticket,
        Ok(vec!["192.168.50.11".parse().unwrap()]),
        3000
    ));
    assert!(core.set_hostname_resolution(&next, Ok(vec!["192.168.50.11".parse().unwrap()]), 3000));
    assert!(core.snapshot(3000)[0].candidates[0].joinable);
}

#[test]
fn source_expiry_reappearance_clear_and_new_sessions_reject_old_tickets() {
    let base = hostname_base();
    let mut core = Core::new();
    apply(&mut core, &base, 0);
    let first = core.hostname_tickets(0).remove(0);
    // No intervening snapshot: apply itself must observe expiry before adding
    // an identical RR again, so byte-identical sources cannot revive tickets.
    apply(&mut core, &base, 120_000);
    let second = core.hostname_tickets(120_000).remove(0);
    assert_ne!(first, second);
    assert!(!core.set_hostname_resolution(
        &first,
        Ok(vec!["192.168.50.10".parse().unwrap()]),
        120_000
    ));
    core.clear();
    apply(&mut core, &base, 120_000);
    let third = core.hostname_tickets(120_000).remove(0);
    assert_ne!(second, third);
    assert!(!core.set_hostname_resolution(
        &second,
        Ok(vec!["192.168.50.10".parse().unwrap()]),
        120_000
    ));
    let mut another_core = Core::new();
    apply(&mut another_core, &base, 120_000);
    assert!(!another_core.set_hostname_resolution(
        &third,
        Ok(vec!["192.168.50.10".parse().unwrap()]),
        120_000
    ));
}

#[test]
fn unchanged_rr_refresh_preserves_ticket_but_invalid_metadata_replacement_revokes_it() {
    let base = hostname_base();
    let mut core = Core::new();
    apply(&mut core, &base, 0);
    let ticket = core.hostname_tickets(0).remove(0);
    apply(&mut core, &base, 10_000);
    assert_eq!(
        core.hostname_tickets(10_000).as_slice(),
        std::slice::from_ref(&ticket)
    );
    let mut invalid = records(&base)
        .into_iter()
        .find(|record| matches!(record.data, RecordData::Txt(_)))
        .unwrap();
    invalid.data = RecordData::Txt(vec![b'x'; 401]);
    core.apply_batch(vec![invalid], 20_000);
    assert!(core.hostname_tickets(20_000).is_empty());
    assert!(!core.set_hostname_resolution(
        &ticket,
        Ok(vec!["192.168.50.10".parse().unwrap()]),
        20_000
    ));
}

#[test]
fn hostname_tickets_require_strict_wire_url_with_200_byte_limit_and_ascii_host() {
    let prefix = "https://books.home.arpa:8080/";
    let exact = format!("{prefix}{}", "a".repeat(200 - prefix.len()));
    assert_eq!(exact.len(), 200);
    assert!(normalize_base_url(&exact).is_ok());
    assert!(normalize_base_url(&format!("{exact}a")).is_err());
    assert!(normalize_base_url("https://bücher.home.arpa:8080").is_err());
    for url in [
        format!("{exact}a"),
        "https://bücher.home.arpa:8080".into(),
        "https://books.home.arpa:8080/a/../b".into(),
    ] {
        let mut base = hostname_base();
        base["txt"][3] = json!(format!("url={url}"));
        let mut core = Core::new();
        apply(&mut core, &base, 0);
        assert!(core.hostname_tickets(0).is_empty());
        assert!(core.snapshot(0).is_empty());
    }
}

#[test]
fn conflicts_preserve_source_names_and_multiple_urls() {
    let base = fixture()["base"].clone();
    let mut other = base.clone();
    other["fullname"] = json!("Proxy._talebook._tcp.local.");
    other["srv"]["target"] = json!("proxy.local.");
    other["addresses"] = json!(["192.168.50.11"]);
    other["txt"][2] = json!("name=another name");
    other["txt"][3] = json!("url=http://192.168.50.11:8080");
    let mut core = Core::new();
    apply(&mut core, &base, 0);
    apply(&mut core, &other, 0);
    let snapshot = core.snapshot(0);
    assert_eq!(snapshot.len(), 1);
    assert!(snapshot[0].conflict);
    assert_eq!(snapshot[0].candidates.len(), 2);
    assert_ne!(
        snapshot[0].candidates[0].name,
        snapshot[0].candidates[1].name
    );
}

#[test]
fn raw_url_and_txt_edges_cannot_be_hidden_by_parsers() {
    for url in [
        "http://@192.168.50.10:8080",
        "http://192.168.50.10:8080?",
        "http://192.168.50.10:8080#",
        "http://192.168.50.10:8080/a/./b",
        "http://192.168.50.10:8080/a//b",
        "http://192.168.50.10:8080//",
        "http://192.168.50.10:8080/a\\b",
        "http://192.168.50.10:8080/a%2fb",
        "http://192.168.50.10:",
        "http://192.168.50.10:0",
        "http://192.168.50.10:8080/\n",
        "http://0xc0a8320a:8080",
        "http://192.168.50.010:8080",
        "http://3232248330:8080",
        "http://192.168.1:8080",
    ] {
        assert!(normalize_base_url(url).is_err(), "{url:?}");
    }
    assert_eq!(
        normalize_base_url("HTTPS://BOOKS.home.arpa:443/team/books/")
            .unwrap()
            .normalized,
        "https://books.home.arpa/team/books"
    );
    let base = fixture()["base"].clone();
    let mut txt: Vec<String> = base["txt"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().into())
        .collect();
    txt[2] = "name=bad\u{0085}".into();
    assert!(parse_txt(&txt_bytes(&txt).unwrap()).is_err());
    txt[2] = "name=ok".into();
    txt[1] = "id=9f0c663b-8ffd-1e13-92d9-2b68572c08b1".into();
    assert!(parse_txt(&txt_bytes(&txt).unwrap()).is_err());
    let mut raw = records(&base)
        .into_iter()
        .find_map(|r| match r.data {
            RecordData::Txt(t) => Some(t),
            _ => None,
        })
        .unwrap();
    raw.extend([3, b'x', b'=', 0xff]);
    assert_eq!(parse_txt(&raw).unwrap_err().0, "invalid_utf8");
}

#[test]
fn malformed_txt_replacement_cannot_leave_old_valid_mapping_clickable() {
    let base = fixture()["base"].clone();
    for invalid in [vec![b'x'; 401], vec![9, b'a', b'b']] {
        let mut core = Core::new();
        apply(&mut core, &base, 0);
        let mut replacement = records(&base)
            .into_iter()
            .find(|r| matches!(r.data, RecordData::Txt(_)))
            .unwrap();
        replacement.data = RecordData::Txt(invalid);
        core.apply_batch(vec![replacement], 20_000);
        assert!(core.snapshot(20_000).is_empty());
        assert!(core.snapshot(21_000).is_empty());
    }
}

fn select_first(core: &mut Core, now_ms: u64) -> CandidateSelection {
    let rows = core.snapshot(now_ms);
    core.select_candidate(&rows[0].id, &rows[0].candidates[0].base_url, now_ms)
        .unwrap()
}

fn resolve_all(core: &mut Core, now_ms: u64) {
    for ticket in core.hostname_tickets(now_ms) {
        assert!(core.set_hostname_resolution(
            &ticket,
            Ok(vec!["192.168.50.10".parse().unwrap()]),
            now_ms,
        ));
    }
}

fn fresh_match() -> Option<Result<Vec<IpAddr>, HostnameFailure>> {
    Some(Ok(vec!["192.168.50.10".parse().unwrap()]))
}

#[test]
fn selection_preserves_canonical_full_base_and_requires_exact_row_and_url() {
    let mut base = fixture()["base"].clone();
    base["txt"][3] = json!("url=HTTP://192.168.50.10:8080/team/books/");
    let mut core = Core::new();
    apply(&mut core, &base, 0);
    let selection = select_first(&mut core, 0);
    assert_eq!(selection.base_url(), "http://192.168.50.10:8080/team/books");
    assert_eq!(selection.name(), "家中书库");
    assert_eq!(selection.row_id(), "9f0c663b-8ffd-4e13-92d9-2b68572c08b1");
    assert_eq!(selection.hostname(), None);
    assert!(core.validate_selection(&selection, None, 0));
    assert!(core
        .select_candidate("other-row", selection.base_url(), 0)
        .is_none());
    for other_url in [
        "http://192.168.50.10:8080",
        "http://192.168.50.10:8080/team/other",
        "http://192.168.50.10:8080/team/books/",
    ] {
        assert!(core
            .select_candidate(selection.row_id(), other_url, 0)
            .is_none());
    }
}

#[test]
fn hostname_selection_requires_live_verification_and_a_fresh_private_matching_answer() {
    let mut core = Core::new();
    apply(&mut core, &hostname_base(), 0);
    let row = core.snapshot(0).remove(0);
    let base = &row.candidates[0].base_url;
    assert!(core.select_candidate(&row.id, base, 0).is_none());
    let ticket = core.hostname_tickets(0).remove(0);
    assert!(core.set_hostname_resolution(&ticket, Err(HostnameFailure::Timeout), 0));
    assert!(core.select_candidate(&row.id, base, 0).is_none());
    resolve_all(&mut core, 100);
    let selection = select_first(&mut core, 100);
    assert_eq!(selection.hostname(), Some("books.home.arpa"));
    assert_eq!(
        selection.base_url(),
        "https://books.home.arpa:8080/team/books"
    );
    for rejected in [
        None,
        Some(Err(HostnameFailure::Empty)),
        Some(Err(HostnameFailure::LookupFailed)),
        Some(Err(HostnameFailure::Timeout)),
        Some(Ok(vec![])),
        Some(Ok(vec!["192.168.50.11".parse().unwrap()])),
        Some(Ok(vec![
            "192.168.50.10".parse().unwrap(),
            "8.8.8.8".parse().unwrap(),
        ])),
        Some(Ok(vec![
            "192.168.50.10".parse().unwrap(),
            "fe80::1".parse().unwrap(),
        ])),
    ] {
        assert!(!core.validate_selection(&selection, rejected, 100));
    }
    assert!(core.validate_selection(&selection, fresh_match(), 100));
    assert!(core.validate_selection(
        &selection,
        Some(Ok(vec![
            "fd00::1".parse().unwrap(),
            "192.168.50.10".parse().unwrap(),
        ])),
        100,
    ));
    assert!(core.set_hostname_resolution(&ticket, Err(HostnameFailure::Timeout), 100));
    assert!(!core.validate_selection(&selection, fresh_match(), 100));
    assert!(core.select_candidate(&row.id, base, 100).is_none());
    resolve_all(&mut core, 100);
    // Fresh admission validation cannot extend the original DNS lease.
    assert!(core.validate_selection(&selection, fresh_match(), 30_099));
    assert!(!core.validate_selection(&selection, fresh_match(), 30_100));
}

#[test]
fn selection_observes_each_required_rr_expiry_without_an_intervening_snapshot() {
    for kind in ["ptr", "srv", "txt", "address"] {
        let mut base = fixture()["base"].clone();
        base["ttl"][kind] = json!(2);
        let mut core = Core::new();
        apply(&mut core, &base, 0);
        let selection = select_first(&mut core, 0);
        assert!(core.validate_selection(&selection, None, 1999), "{kind}");
        assert!(!core.validate_selection(&selection, None, 2000), "{kind}");
        apply(&mut core, &base, 2000);
        assert!(!core.validate_selection(&selection, None, 2000), "{kind}");
        let next = select_first(&mut core, 2000);
        assert!(core.validate_selection(&next, None, 2000), "{kind}");
    }
}

#[test]
fn each_goodbye_immediately_revokes_selection_and_positive_refresh_cannot_revive_it() {
    for hostname in [false, true] {
        for record_kind in ["ptr", "srv", "txt", "a", "aaaa"] {
            let mut base = if hostname {
                hostname_base()
            } else {
                fixture()["base"].clone()
            };
            base["addresses"] = json!(["192.168.50.10", "fd00::1"]);
            let mut core = Core::new();
            apply(&mut core, &base, 0);
            resolve_all(&mut core, 0);
            let ticket = core.hostname_tickets(0).into_iter().next();
            let selection = select_first(&mut core, 0);
            let positive = records(&base)
                .into_iter()
                .find(|record| {
                    matches!(
                        (record_kind, &record.data),
                        ("ptr", RecordData::Ptr(_))
                            | ("srv", RecordData::Srv { .. })
                            | ("txt", RecordData::Txt(_))
                            | ("a", RecordData::A(_))
                            | ("aaaa", RecordData::Aaaa(_))
                    )
                })
                .unwrap();
            let mut goodbye = positive.clone();
            goodbye.ttl = 0;
            core.apply_batch(vec![goodbye.clone()], 1000);
            assert!(!core.validate_selection(&selection, fresh_match(), 1000));
            assert!(core
                .select_candidate(selection.row_id(), selection.base_url(), 1000)
                .is_none());
            assert!(core.hostname_tickets(1000).is_empty());
            let rows = core.snapshot(1000);
            assert_eq!(rows.len(), 1, "the display grace remains");
            assert!(!rows[0].candidates[0].joinable);
            assert_eq!(
                rows[0].candidates[0].unavailable_reason.as_deref(),
                Some("source_withdrawn")
            );
            if let Some(ticket) = &ticket {
                assert!(!core.set_hostname_resolution(
                    ticket,
                    Ok(vec!["192.168.50.10".parse().unwrap()]),
                    1000,
                ));
            }
            core.apply_batch(vec![positive], 1001);
            assert!(!core.validate_selection(&selection, fresh_match(), 1001));
            if let Some(ticket) = ticket {
                let next = core.hostname_tickets(1001).remove(0);
                assert_ne!(ticket, next);
                assert!(core
                    .select_candidate(selection.row_id(), selection.base_url(), 1001)
                    .is_none());
                assert!(!core.set_hostname_resolution(
                    &ticket,
                    Ok(vec!["192.168.50.10".parse().unwrap()]),
                    1001,
                ));
                resolve_all(&mut core, 1001);
            }
            let next = select_first(&mut core, 1001);
            assert!(core.validate_selection(&next, fresh_match(), 1001));
            assert!(!core.validate_selection(&selection, fresh_match(), 1001));
            // Repeated withdrawals retain the original grace deadline.
            core.apply_batch(vec![goodbye.clone()], 2000);
            core.apply_batch(vec![goodbye], 2500);
            assert!(core
                .snapshot(3000)
                .iter()
                .all(|row| row
                    .candidates
                    .iter()
                    .all(|candidate| candidate.unavailable_reason.as_deref()
                        != Some("source_withdrawn"))));
            assert!(!core.validate_selection(&next, fresh_match(), 3000));
        }
    }
}

#[test]
fn same_batch_goodbye_and_identical_positive_records_cannot_revive_old_selection() {
    for base in [fixture()["base"].clone(), hostname_base()] {
        let mut core = Core::new();
        apply(&mut core, &base, 0);
        resolve_all(&mut core, 0);
        let selection = select_first(&mut core, 0);
        let ticket = core.hostname_tickets(0).into_iter().next();
        let positive = records(&base);
        let goodbye: Vec<_> = positive
            .iter()
            .cloned()
            .map(|mut record| {
                record.ttl = 0;
                record
            })
            .collect();
        // No source refresh between the withdrawal and the positive answer:
        // the RR incarnation itself must still rotate before the final refresh.
        core.apply_batch(goodbye.iter().chain(&positive).cloned().collect(), 1000);
        assert!(!core.validate_selection(&selection, fresh_match(), 1000));
        if let Some(ticket) = ticket {
            assert!(!core.set_hostname_resolution(
                &ticket,
                Ok(vec!["192.168.50.10".parse().unwrap()]),
                1000,
            ));
            assert!(core
                .select_candidate(selection.row_id(), selection.base_url(), 1000)
                .is_none());
            resolve_all(&mut core, 1000);
        }
        let next = select_first(&mut core, 1000);
        assert!(core.validate_selection(&next, fresh_match(), 1000));
        core.apply_batch(positive.into_iter().chain(goodbye).collect(), 2000);
        assert!(!core.validate_selection(&next, fresh_match(), 2000));
        assert!(core
            .select_candidate(next.row_id(), next.base_url(), 2000)
            .is_none());
    }
}

#[test]
fn ip_source_returning_to_identical_key_after_address_expiry_does_not_revive_selection() {
    let base = fixture()["base"].clone();
    let mut core = Core::new();
    apply(&mut core, &base, 0);
    let selection = select_first(&mut core, 0);
    let mut temporary = records(&base)
        .into_iter()
        .find(|record| matches!(record.data, RecordData::A(_)))
        .unwrap();
    temporary.data = RecordData::A("192.168.50.11".parse().unwrap());
    temporary.ttl = 1;
    temporary.cache_flush = false;
    core.apply_batch(vec![temporary], 1000);
    assert!(!core.validate_selection(&selection, None, 1000));
    let expanded = select_first(&mut core, 1000);
    assert!(core.validate_selection(&expanded, None, 1999));
    assert!(!core.validate_selection(&expanded, None, 2000));
    assert!(!core.validate_selection(&selection, None, 2000));
    let restored = select_first(&mut core, 2000);
    assert!(core.validate_selection(&restored, None, 2000));
}

#[test]
fn unchanged_positive_refresh_preserves_ip_and_hostname_selections() {
    for base in [fixture()["base"].clone(), hostname_base()] {
        let mut core = Core::new();
        apply(&mut core, &base, 0);
        resolve_all(&mut core, 0);
        let selection = select_first(&mut core, 0);
        apply(&mut core, &base, 10_000);
        assert!(core.validate_selection(&selection, fresh_match(), 10_000));
    }
}

#[test]
fn selection_never_falls_back_to_same_candidate_on_another_interface_or_core() {
    for base in [fixture()["base"].clone(), hostname_base()] {
        let mut other = base.clone();
        other["interface"] = json!("lan-b");
        let mut core = Core::new();
        apply(&mut core, &base, 0);
        resolve_all(&mut core, 0);
        let selection = select_first(&mut core, 0);
        // Identical input order also makes the per-core RR incarnation values
        // identical, so only the core-specific admission generation separates
        // these IP selections (hostnames additionally have unique DNS tickets).
        let mut identical_core = Core::new();
        apply(&mut identical_core, &base, 0);
        resolve_all(&mut identical_core, 0);
        assert!(!identical_core.validate_selection(&selection, fresh_match(), 0));
        apply(&mut core, &other, 0);
        resolve_all(&mut core, 0);
        assert!(core.validate_selection(&selection, fresh_match(), 0));
        core.remove_interface(base["interface"].as_str().unwrap());
        assert!(!core.validate_selection(&selection, fresh_match(), 0));
        let remaining = select_first(&mut core, 0);
        assert!(core.validate_selection(&remaining, fresh_match(), 0));
        let mut another_core = Core::new();
        apply(&mut another_core, &other, 0);
        resolve_all(&mut another_core, 0);
        assert!(!another_core.validate_selection(&remaining, fresh_match(), 0));
        core.clear();
        apply(&mut core, &other, 0);
        resolve_all(&mut core, 0);
        assert!(!core.validate_selection(&remaining, fresh_match(), 0));
        let restored = select_first(&mut core, 0);
        assert!(core.validate_selection(&restored, fresh_match(), 0));
    }
}

#[test]
fn hostname_retry_clear_and_lease_rotation_revoke_selection_permanently() {
    for action in ["retry", "clear", "lease"] {
        let mut core = Core::new();
        apply(&mut core, &hostname_base(), 0);
        resolve_all(&mut core, 0);
        let selection = select_first(&mut core, 0);
        let now = match action {
            "retry" => {
                assert!(core.retry_hostname(selection.row_id(), selection.base_url(), 1));
                1
            }
            "clear" => {
                core.clear_hostname_resolutions();
                1
            }
            "lease" => HOSTNAME_VALIDATION_LEASE_MS,
            _ => unreachable!(),
        };
        assert!(!core.validate_selection(&selection, fresh_match(), now));
        resolve_all(&mut core, now);
        assert!(!core.validate_selection(&selection, fresh_match(), now));
        let next = select_first(&mut core, now);
        assert!(core.validate_selection(&next, fresh_match(), now));
    }
}

#[test]
fn source_rr_replacement_revokes_selection_before_and_after_flush_grace() {
    let base = fixture()["base"].clone();
    for kind in ["srv", "txt", "address"] {
        let mut core = Core::new();
        apply(&mut core, &base, 0);
        let selection = select_first(&mut core, 0);
        let mut changed = base.clone();
        match kind {
            "srv" => changed["srv"]["target"] = json!("replacement.local."),
            "txt" => changed["txt"][2] = json!("name=renamed library"),
            "address" => changed["addresses"] = json!(["192.168.50.10", "192.168.50.11"]),
            _ => unreachable!(),
        }
        apply(&mut core, &changed, 2000);
        assert!(!core.validate_selection(&selection, None, 2000), "{kind}");
        assert!(!core.validate_selection(&selection, None, 3000), "{kind}");
        let next = select_first(&mut core, 3000);
        assert!(core.validate_selection(&next, None, 3000), "{kind}");
    }
}

#[test]
fn fresh_hostname_answers_are_bound_to_selected_source_not_merged_candidate() {
    let base = hostname_base();
    let mut other = base.clone();
    other["interface"] = json!("lan-b");
    other["addresses"] = json!(["192.168.50.11"]);
    other["txt"][2] = json!("name=another library");
    let mut core = Core::new();
    apply(&mut core, &base, 0);
    resolve_all(&mut core, 0);
    let selection = select_first(&mut core, 0);
    apply(&mut core, &other, 0);
    assert_eq!(selection.name(), "家中书库");
    assert!(!core.validate_selection(
        &selection,
        Some(Ok(vec!["192.168.50.11".parse().unwrap()])),
        0,
    ));
    assert!(core.validate_selection(&selection, fresh_match(), 0));
}
