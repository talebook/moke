//! Pure Talebook v1 discovery. No sockets, HTTP, credentials, or application state.
//!
//! Call `apply_batch` for **every received RR**, including unchanged responses;
//! resolved-service notifications do not contain enough information to drive TTL.
//! All timestamps are milliseconds from the caller's monotonic clock. Each core
//! belongs to one browsing session; discard it when that session stops.

use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use url::{Host, Url};
use uuid::{Uuid, Variant, Version};

pub const SERVICE_TYPE: &str = "_talebook._tcp.local.";
/// v1 publishers use TTL=120. Never extend a shorter received TTL, and do not
/// let an untrusted longer TTL retain a candidate beyond the profile lifetime.
pub const MAX_TTL_SECS: u32 = 120;
const MAX_RECORDS: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum RecordData {
    Ptr(String),
    Srv {
        priority: u16,
        weight: u16,
        port: u16,
        target: String,
    },
    /// Unmodified TXT RDATA, including each string's length byte.
    Txt(Vec<u8>),
    A(Ipv4Addr),
    Aaaa(Ipv6Addr),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    /// Stable identifier of the receiving local interface, never the sender IP.
    pub interface: String,
    pub name: String,
    pub ttl: u32,
    pub cache_flush: bool,
    pub data: RecordData,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryRow {
    pub id: String,
    pub name: String,
    pub conflict: bool,
    pub candidates: Vec<DiscoveryCandidate>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryCandidate {
    pub base_url: String,
    pub name: String,
    pub joinable: bool,
    pub unavailable_reason: Option<String>,
    pub sources: Vec<DiscoverySource>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverySource {
    pub fullname: String,
    pub interface: String,
    pub addresses: Vec<String>,
    /// Preserve per-source names when an unauthenticated ID has conflicting names.
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TxtMetadata {
    pub id: String,
    pub name: String,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BaseUrl {
    pub normalized: String,
    pub port: u16,
    pub host: BaseHost,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BaseHost {
    Ip(IpAddr),
    Dns(String),
}

/// Stable reason codes; callers may translate these without exposing raw TXT.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidationError(pub &'static str);

fn fail<T>(reason: &'static str) -> Result<T, ValidationError> {
    Err(ValidationError(reason))
}

/// Parse the actual DNS length-prefixed wire format. Never turn a TXT map from
/// a convenience DNS-SD API back into bytes: that loses duplicate-key ordering.
pub fn parse_txt(raw: &[u8]) -> Result<TxtMetadata, ValidationError> {
    if raw.len() > 400 {
        return fail("txt_rdata_over_400_bytes");
    }
    let mut fields = BTreeMap::new();
    let mut pos = 0;
    let mut first = true;
    while pos < raw.len() {
        let len = raw[pos] as usize;
        pos += 1;
        if pos + len > raw.len() {
            return fail("truncated_txt");
        }
        let text = std::str::from_utf8(&raw[pos..pos + len])
            .map_err(|_| ValidationError("invalid_utf8"))?;
        pos += len;
        let (key, value) = text
            .split_once('=')
            .ok_or(ValidationError("invalid_txt_property"))?;
        if key.is_empty() || !key.bytes().all(|b| (0x21..=0x7e).contains(&b) && b != b'=') {
            return fail("invalid_txt_key");
        }
        let key = key.to_ascii_lowercase();
        if first && key != "txtvers" {
            return fail("version_not_first");
        }
        first = false;
        fields.entry(key).or_insert(value);
    }
    let required = |key: &str| {
        fields
            .get(key)
            .copied()
            .filter(|s| !s.is_empty())
            .ok_or(ValidationError("missing_required_key"))
    };
    if required("txtvers")? != "1" {
        return fail("unsupported_version");
    }
    let id = required("id")?;
    let uuid = Uuid::parse_str(id).map_err(|_| ValidationError("invalid_id"))?;
    if id.len() != 36
        || uuid.hyphenated().to_string() != id.to_ascii_lowercase()
        || uuid.get_version() != Some(Version::Random)
        || uuid.get_variant() != Variant::RFC4122
    {
        return fail("invalid_id");
    }
    let name = required("name")?;
    if name.len() > 96 || name.chars().any(char::is_control) {
        return fail("invalid_name");
    }
    let url = required("url")?;
    normalize_base_url(url)?;
    Ok(TxtMetadata {
        id: uuid.to_string(),
        name: name.to_owned(),
        url: url.to_owned(),
    })
}

/// Validate before WHATWG parsing so dot segments, empty query/fragment,
/// backslashes, and empty userinfo cannot disappear during normalization.
pub fn normalize_base_url(input: &str) -> Result<BaseUrl, ValidationError> {
    if input.is_empty()
        || input.len() > 200
        || !input.is_ascii()
        || input.bytes().any(|b| b <= 0x20 || b == 0x7f)
    {
        return fail("invalid_url");
    }
    if input.contains('\\') {
        return fail("url_backslash");
    }
    if input.contains('?') {
        return fail("url_query");
    }
    if input.contains('#') {
        return fail("url_fragment");
    }
    let (scheme, rest) = input
        .split_once("://")
        .ok_or(ValidationError("invalid_url"))?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return fail("invalid_url_scheme");
    }
    let (authority, path) = rest.split_once('/').map_or((rest, ""), |(a, p)| (a, p));
    if authority.is_empty() || authority.contains('@') {
        return fail("url_userinfo");
    }
    if authority.ends_with(':') || authority.contains('%') {
        return fail("invalid_url_host");
    }
    // At most one optional trailing slash; every actual segment is nonempty.
    let path = path.strip_suffix('/').unwrap_or(path);
    if !path.is_empty()
        && path.split('/').any(|segment| {
            segment.is_empty()
                || !segment
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
    {
        return fail("invalid_path_before_url_normalization");
    }
    // A doubled root slash must not be silently treated as the root.
    if rest.ends_with("//") {
        return fail("invalid_path_before_url_normalization");
    }
    let mut parsed = Url::parse(input).map_err(|_| ValidationError("invalid_url"))?;
    let host = match parsed.host().ok_or(ValidationError("invalid_url_host"))? {
        Host::Ipv4(ip) => {
            // The URL parser also accepts integer, hexadecimal, octal, and
            // shortened IPv4 spellings. Accept the same unambiguous decimal
            // spelling as the shared frontend validator.
            if authority.split(':').next() != Some(ip.to_string().as_str()) {
                return fail("invalid_url_host");
            }
            BaseHost::Ip(IpAddr::V4(ip))
        }
        Host::Ipv6(ip) => BaseHost::Ip(IpAddr::V6(ip)),
        Host::Domain(host) => {
            if !valid_hostname(host) {
                return fail("invalid_url_host");
            }
            BaseHost::Dns(host.to_ascii_lowercase())
        }
    };
    let port = parsed
        .port_or_known_default()
        .filter(|p| *p != 0)
        .ok_or(ValidationError("invalid_port"))?;
    parsed.set_path(if path.is_empty() { "" } else { path });
    let normalized = parsed.as_str().trim_end_matches('/').to_owned();
    Ok(BaseUrl {
        normalized,
        port,
        host,
    })
}

fn valid_hostname(host: &str) -> bool {
    let host = host.strip_suffix('.').unwrap_or(host);
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

pub fn is_lan_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => ip.is_private(),
        IpAddr::V6(ip) => ip.segments()[0] & 0xfe00 == 0xfc00,
    }
}

#[derive(Clone, Debug)]
struct Cached {
    record: Record,
    received_at: u64,
    expires_at: u64,
}

#[derive(Default)]
pub struct Core {
    cache: Vec<Cached>,
    resolutions: BTreeMap<String, Vec<IpAddr>>,
}

impl Core {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn clear(&mut self) {
        self.cache.clear();
        self.resolutions.clear();
    }

    pub fn remove_interface(&mut self, interface: &str) {
        self.cache
            .retain(|entry| entry.record.interface != interface);
    }

    /// Inject a result from the normal system resolver (DNS only). The caller
    /// must clear/revalidate it on network/session changes and before joining.
    pub fn set_hostname_resolution(&mut self, hostname: &str, addresses: Vec<IpAddr>) {
        self.resolutions
            .insert(hostname.to_ascii_lowercase(), addresses);
    }

    pub fn clear_hostname_resolutions(&mut self) {
        self.resolutions.clear();
    }

    pub fn apply_batch(&mut self, records: Vec<Record>, now_ms: u64) {
        self.expire(now_ms);
        let records: Vec<_> = records.into_iter().filter_map(canonical_record).collect();
        // RFC6762 §10.2: all members in this packet protect each other. Records
        // received within the last second are protected against other packets
        // of a split RRset too. Older conflicting data expires after one second.
        for old in &mut self.cache {
            let flushed = records.iter().any(|new| {
                new.ttl != 0
                    && new.cache_flush
                    && !matches!(new.data, RecordData::Ptr(_))
                    && same_rrset(new, &old.record)
            });
            let included = records
                .iter()
                .any(|new| new.ttl != 0 && same_rr(new, &old.record));
            if flushed && !included && now_ms.saturating_sub(old.received_at) >= 1000 {
                old.expires_at = old.expires_at.min(now_ms.saturating_add(1000));
            }
        }
        for record in records {
            if let Some(existing) = self
                .cache
                .iter_mut()
                .find(|entry| same_rr(&entry.record, &record))
            {
                if record.ttl == 0 {
                    existing.expires_at = existing.expires_at.min(now_ms.saturating_add(1000));
                } else {
                    existing.received_at = now_ms;
                    existing.expires_at = now_ms.saturating_add(u64::from(record.ttl) * 1000);
                    existing.record = record;
                }
            } else if record.ttl != 0 && self.cache.len() < MAX_RECORDS {
                let expires_at = now_ms.saturating_add(u64::from(record.ttl) * 1000);
                self.cache.push(Cached {
                    record,
                    received_at: now_ms,
                    expires_at,
                });
            }
        }
    }

    fn expire(&mut self, now_ms: u64) {
        self.cache.retain(|entry| entry.expires_at > now_ms);
    }

    pub fn snapshot(&mut self, now_ms: u64) -> Vec<DiscoveryRow> {
        self.expire(now_ms);
        let mut rows: BTreeMap<String, DiscoveryRow> = BTreeMap::new();
        let mut sources = BTreeSet::new();
        for ptr in &self.cache {
            if ptr.record.name != SERVICE_TYPE {
                continue;
            }
            let RecordData::Ptr(fullname) = &ptr.record.data else {
                continue;
            };
            sources.insert((ptr.record.interface.clone(), fullname.clone()));
        }
        for (interface, fullname) in sources {
            let rr = |name: &str| {
                self.cache
                    .iter()
                    .filter(|entry| {
                        entry.record.interface == interface && entry.record.name == name
                    })
                    .collect::<Vec<_>>()
            };
            let srvs: Vec<_> = rr(&fullname)
                .into_iter()
                .filter_map(|e| match &e.record.data {
                    RecordData::Srv {
                        priority,
                        weight,
                        port,
                        target,
                    } => Some((*priority, *weight, *port, target)),
                    _ => None,
                })
                .collect();
            let txts: Vec<_> = rr(&fullname)
                .into_iter()
                .filter_map(|e| match &e.record.data {
                    RecordData::Txt(raw) => Some(raw),
                    _ => None,
                })
                .collect();
            // Ambiguous unique RRsets are not safe to join. During replacement
            // their cache-flush grace will resolve this without retaining an
            // old TXT identity/URL as if it were a second service.
            if srvs.len() != 1 || txts.len() != 1 {
                continue;
            }
            let (priority, weight, port, target) = srvs[0];
            if priority != 0 || weight != 0 || port == 0 {
                continue;
            }
            let Ok(metadata) = parse_txt(txts[0]) else {
                continue;
            };
            let Ok(base) = normalize_base_url(&metadata.url) else {
                continue;
            };
            if base.port != port {
                continue;
            }
            let addresses: BTreeSet<_> = rr(target)
                .into_iter()
                .filter_map(|entry| match entry.record.data {
                    RecordData::A(ip) => Some(IpAddr::V4(ip)),
                    RecordData::Aaaa(ip) => Some(IpAddr::V6(ip)),
                    _ => None,
                })
                .collect();
            if addresses.is_empty()
                || addresses.len() > 8
                || !addresses.iter().copied().all(is_lan_address)
            {
                continue;
            }
            let unavailable_reason = match &base.host {
                BaseHost::Ip(ip) => {
                    if !addresses.contains(ip) {
                        continue;
                    }
                    None
                }
                BaseHost::Dns(host) => match self.resolutions.get(host) {
                    None => Some("hostname_unresolved".to_owned()),
                    Some(resolved)
                        if resolved.is_empty()
                            || !resolved.iter().copied().all(is_lan_address)
                            || !resolved.iter().any(|ip| addresses.contains(ip)) =>
                    {
                        Some("hostname_address_mismatch".to_owned())
                    }
                    Some(_) => None,
                },
            };
            let row = rows
                .entry(metadata.id.clone())
                .or_insert_with(|| DiscoveryRow {
                    id: metadata.id,
                    name: metadata.name.clone(),
                    conflict: false,
                    candidates: Vec::new(),
                });
            let source = DiscoverySource {
                fullname,
                interface,
                name: metadata.name.clone(),
                addresses: addresses.into_iter().map(|ip| ip.to_string()).collect(),
            };
            if let Some(candidate) = row
                .candidates
                .iter_mut()
                .find(|candidate| candidate.base_url == base.normalized)
            {
                candidate.joinable |= unavailable_reason.is_none();
                if candidate.joinable {
                    candidate.unavailable_reason = None;
                }
                candidate.sources.push(source);
            } else {
                row.candidates.push(DiscoveryCandidate {
                    base_url: base.normalized,
                    name: metadata.name,
                    joinable: unavailable_reason.is_none(),
                    unavailable_reason,
                    sources: vec![source],
                });
            }
        }
        for row in rows.values_mut() {
            row.candidates.sort_by(|a, b| a.base_url.cmp(&b.base_url));
            let names: BTreeSet<_> = row
                .candidates
                .iter()
                .flat_map(|c| c.sources.iter().map(|s| &s.name))
                .collect();
            row.conflict = names.len() > 1;
            if let Some(name) = names.into_iter().next() {
                row.name = name.clone();
            }
            for candidate in &mut row.candidates {
                candidate
                    .sources
                    .sort_by(|a, b| (&a.fullname, &a.interface).cmp(&(&b.fullname, &b.interface)));
                if let Some(name) = candidate.sources.iter().map(|s| &s.name).min() {
                    candidate.name = name.clone();
                }
            }
        }
        rows.into_values().collect()
    }
}

fn canonical_name(name: &str) -> Option<String> {
    if name.len() > 255 || !name.ends_with('.') || name.chars().any(char::is_control) {
        return None;
    }
    let stem = name.strip_suffix('.')?;
    if stem.is_empty()
        || stem
            .split('.')
            .any(|label| label.is_empty() || label.len() > 63)
    {
        return None;
    }
    Some(name.to_ascii_lowercase())
}

fn canonical_record(mut record: Record) -> Option<Record> {
    if record.interface.is_empty() || record.interface.len() > 256 {
        return None;
    }
    record.name = canonical_name(&record.name)?;
    record.ttl = record.ttl.min(MAX_TTL_SECS);
    match &mut record.data {
        RecordData::Ptr(target) => {
            *target = canonical_name(target)?;
            if record.name != SERVICE_TYPE || !target.ends_with(&format!(".{SERVICE_TYPE}")) {
                return None;
            }
        }
        RecordData::Srv { target, .. } => *target = canonical_name(target)?,
        // An oversized replacement must still invalidate an older valid TXT.
        // A 401-byte invalid sentinel bounds memory without admitting it to
        // parse_txt, and preserves equality for retransmission/goodbye handling.
        RecordData::Txt(raw) if raw.len() > 400 => raw.truncate(401),
        _ => (),
    }
    Some(record)
}

fn record_type(record: &Record) -> u8 {
    match record.data {
        RecordData::Ptr(_) => 12,
        RecordData::Srv { .. } => 33,
        RecordData::Txt(_) => 16,
        RecordData::A(_) => 1,
        RecordData::Aaaa(_) => 28,
    }
}
fn same_rrset(a: &Record, b: &Record) -> bool {
    a.interface == b.interface && a.name == b.name && record_type(a) == record_type(b)
}
fn same_rr(a: &Record, b: &Record) -> bool {
    same_rrset(a, b) && a.data == b.data
}
