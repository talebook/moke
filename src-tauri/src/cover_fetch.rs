//! Credential-free, SSRF-resistant downloader for explicitly allowed public
//! book covers. Library-origin covers keep using the shared plugin HTTP cookie
//! jar; this command is only for cross-origin resources and never accepts
//! caller-provided headers or credentials.

use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::time::{Duration, Instant};
use tauri_plugin_http::reqwest::{
    header::{ACCEPT, ACCEPT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, LOCATION},
    redirect::Policy,
    Client, Url,
};

const MAX_COVER_BYTES: usize = 5 * 1024 * 1024;
const MAX_REDIRECTS: usize = 3;
const TOTAL_TIMEOUT: Duration = Duration::from_secs(12);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);

fn ipv4_is_non_public(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224
}

fn ipv6_is_non_public(ip: Ipv6Addr) -> bool {
    if let Some(ipv4) = ip.to_ipv4_mapped() {
        return ipv4_is_non_public(ipv4);
    }

    let segments = ip.segments();
    ip.is_unspecified()
        || ip.is_loopback()
        || segments[..6].iter().all(|segment| *segment == 0) // deprecated IPv4-compatible ::/96
        || (segments[0] & 0xfe00) == 0xfc00 // unique-local fc00::/7
        || (segments[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
        || (segments[0] & 0xff00) == 0xff00 // multicast
        || (segments[0] == 0x0064 && segments[1] == 0xff9b) // NAT64
        || (segments[0] == 0x0100 && segments[1] == 0) // discard-only
        || (segments[0] == 0x2001 && (segments[1] < 0x0200 || segments[1] == 0x0db8)) // special/documentation
        || segments[0] == 0x2002 // 6to4 embeds an IPv4 destination
        || (segments[0] & 0xfff0) == 0x3ff0 // documentation 3fff::/20
        || segments[0] == 0x5f00 // segment-routing SIDs, not a public endpoint
}

fn address_is_non_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ipv4_is_non_public(ip),
        IpAddr::V6(ip) => ipv6_is_non_public(ip),
    }
}

fn normalized_host(url: &Url) -> Result<String, String> {
    Ok(url
        .host_str()
        .ok_or_else(|| "image.url.invalid".to_string())?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase())
}

fn validate_url(url: &Url) -> Result<(), String> {
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("image.url.invalid".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("image.url.credentials".into());
    }
    let normalized = normalized_host(url)?;
    if normalized == "localhost"
        || normalized.ends_with(".localhost")
        || normalized.ends_with(".local")
        || normalized == "metadata.google.internal"
        || normalized.ends_with(".metadata.google.internal")
    {
        return Err("image.url.private".into());
    }
    if let Ok(ip) = normalized.parse::<IpAddr>() {
        if address_is_non_public(ip) {
            return Err("image.url.private".into());
        }
    }
    Ok(())
}

async fn resolve_public_addrs(url: &Url, timeout: Duration) -> Result<Vec<SocketAddr>, String> {
    let host = normalized_host(url)?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "image.url.invalid".to_string())?;
    let host_for_lookup = host.clone();
    let lookup = tauri::async_runtime::spawn_blocking(move || {
        (host_for_lookup.as_str(), port)
            .to_socket_addrs()
            .map(|iter| iter.collect::<Vec<_>>())
    });
    let addresses = tokio::time::timeout(timeout, lookup)
        .await
        .map_err(|_| "image.dns.timeout".to_string())?
        .map_err(|_| "image.dns.failed".to_string())?
        .map_err(|_| "image.dns.failed".to_string())?;

    let mut unique = HashSet::new();
    let addresses: Vec<_> = addresses
        .into_iter()
        .filter(|address| unique.insert(*address))
        .collect();
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| address_is_non_public(address.ip()))
    {
        return Err("image.url.private".into());
    }
    Ok(addresses)
}

fn allowed_content_type(value: &str) -> bool {
    matches!(
        value
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "image/gif" | "image/jpeg" | "image/jpg" | "image/png" | "image/webp"
    )
}

fn build_pinned_client(
    url: &Url,
    addresses: &[SocketAddr],
    remaining: Duration,
) -> Result<Client, String> {
    let host = normalized_host(url)?;
    Client::builder()
        .redirect(Policy::none())
        .referer(false)
        // Environment proxies would bypass the pinned DNS destination and
        // make the private-address decision unverifiable.
        .no_proxy()
        .resolve_to_addrs(&host, addresses)
        .connect_timeout(CONNECT_TIMEOUT.min(remaining))
        .timeout(remaining)
        .build()
        .map_err(|_| "image.client.failed".to_string())
}

async fn fetch_public_cover_bytes(image_url: String) -> Result<Vec<u8>, String> {
    let mut url = Url::parse(&image_url).map_err(|_| "image.url.invalid".to_string())?;
    let started = Instant::now();
    let mut redirects = 0;

    loop {
        validate_url(&url)?;
        let remaining = TOTAL_TIMEOUT
            .checked_sub(started.elapsed())
            .ok_or_else(|| "image.timeout".to_string())?;
        let addresses = resolve_public_addrs(&url, CONNECT_TIMEOUT.min(remaining)).await?;
        let remaining = TOTAL_TIMEOUT
            .checked_sub(started.elapsed())
            .ok_or_else(|| "image.timeout".to_string())?;
        let client = build_pinned_client(&url, &addresses, remaining)?;
        let mut response = client
            .get(url.clone())
            .header(ACCEPT, "image/webp,image/png,image/jpeg,image/gif;q=0.8")
            .header(ACCEPT_ENCODING, "identity")
            .send()
            .await
            .map_err(|_| "image.request.failed".to_string())?;

        if response.status().is_redirection() {
            if redirects >= MAX_REDIRECTS {
                return Err("image.redirect.exceeded".into());
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "image.redirect.invalid".to_string())?;
            url = url
                .join(location)
                .map_err(|_| "image.redirect.invalid".to_string())?;
            redirects += 1;
            continue;
        }

        if !response.status().is_success() {
            return Err(format!("image.http.{}", response.status().as_u16()));
        }
        if let Some(content_type) = response.headers().get(CONTENT_TYPE) {
            let content_type = content_type
                .to_str()
                .map_err(|_| "image.content_type.invalid".to_string())?;
            if !allowed_content_type(content_type) {
                return Err("image.content_type.invalid".into());
            }
        }
        if let Some(content_length) = response.headers().get(CONTENT_LENGTH) {
            if content_length
                .to_str()
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .is_some_and(|length| length > MAX_COVER_BYTES as u64)
            {
                return Err("image.size.exceeded".into());
            }
        }

        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "image.body.failed".to_string())?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_COVER_BYTES {
                return Err("image.size.exceeded".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Err("image.body.missing".into());
        }
        return Ok(bytes);
    }
}

#[tauri::command]
pub(crate) async fn moke_fetch_public_cover(
    image_url: String,
) -> Result<tauri::ipc::Response, String> {
    fetch_public_cover_bytes(image_url)
        .await
        .map(tauri::ipc::Response::new)
}

#[cfg(test)]
mod tests {
    use super::{address_is_non_public, allowed_content_type, validate_url};
    use std::net::IpAddr;
    use tauri_plugin_http::reqwest::Url;

    #[test]
    fn rejects_private_special_and_metadata_addresses() {
        for value in [
            "127.0.0.1",
            "10.0.0.1",
            "100.64.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.1.1",
            "198.18.0.1",
            "::1",
            "::8.8.8.8",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "64:ff9b::a00:1",
            "2001:db8::1",
            "3fff::1",
            "5f00::1",
        ] {
            let ip: IpAddr = value.parse().unwrap();
            assert!(address_is_non_public(ip), "{value} must be rejected");
        }
        for value in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            let ip: IpAddr = value.parse().unwrap();
            assert!(!address_is_non_public(ip), "{value} should be public");
        }
    }

    #[test]
    fn url_policy_rejects_non_http_credentials_and_local_names() {
        for value in [
            "file:///etc/passwd",
            "https://user:pass@example.com/cover.jpg",
            "http://localhost/cover.jpg",
            "http://metadata.google.internal/computeMetadata/v1/",
            "http://[::1]/cover.jpg",
            "http://2130706433/cover.jpg",
            "http://0x7f000001/cover.jpg",
        ] {
            let url = Url::parse(value).unwrap();
            assert!(validate_url(&url).is_err(), "{value} must be rejected");
        }
        assert!(validate_url(&Url::parse("https://cdn.example/cover.jpg").unwrap()).is_ok());
    }

    #[test]
    fn only_raster_cover_content_types_are_accepted() {
        assert!(allowed_content_type("image/jpeg; charset=binary"));
        assert!(allowed_content_type("image/webp"));
        assert!(!allowed_content_type("image/svg+xml"));
        assert!(!allowed_content_type("text/html"));
    }
}
