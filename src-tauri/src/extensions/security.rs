//! Shared loopback transport security checks for the extension HTTP and WS servers.
//!
//! Binding to `127.0.0.1` is not by itself a browser security boundary: a DNS
//! rebinding page can still address the listener. Both transports therefore
//! require the literal loopback authority and only recognize browser origins
//! belonging to a currently enabled extension UI.

use super::EnabledExtension;
use std::collections::HashMap;

pub(crate) const LOOPBACK_HOST: &str = "127.0.0.1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ValidatedOrigin {
    /// Native extension backends do not send an Origin header. They still have
    /// to authenticate with their session token at the application layer.
    Backend,
    /// Browser requests are accepted only from an enabled extension's exact
    /// loopback UI origin. The extension name is used to prevent one extension
    /// origin from exercising another extension's token.
    Extension { value: String, name: String },
}

pub(crate) fn expected_authority(port: u16) -> String {
    format!("{LOOPBACK_HOST}:{port}")
}

pub(crate) fn validate_host(host: Option<&str>, port: u16) -> bool {
    host.is_some_and(|value| value.trim() == expected_authority(port))
}

pub(crate) fn extension_origin(port: u16) -> Option<String> {
    (port > 0).then(|| format!("http://{}", expected_authority(port)))
}

pub(crate) fn validate_origin(
    origin: Option<&str>,
    enabled: &HashMap<String, EnabledExtension>,
) -> Result<ValidatedOrigin, &'static str> {
    let Some(origin) = origin else {
        return Ok(ValidatedOrigin::Backend);
    };

    // Be deliberately strict: browser-generated origins use this exact form.
    // In particular, `localhost`, DNS names resolving to loopback, `null`, user
    // info, paths, and trailing slashes are not equivalent authorities.
    let mut matched_name: Option<String> = None;
    for (name, extension) in enabled {
        if extension_origin(extension.port).as_deref() == Some(origin) {
            // Duplicate runtime ports must fail closed rather than make the
            // browser identity depend on HashMap iteration order.
            if matched_name.is_some() {
                return Err("拓展来源端口不唯一");
            }
            matched_name = Some(name.clone());
        }
    }

    matched_name
        .map(|name| ValidatedOrigin::Extension {
            value: origin.to_string(),
            name,
        })
        .ok_or("不允许的 Origin")
}

/// Compare bearer-style session credentials without an early byte mismatch.
pub(crate) fn token_matches(expected: &str, supplied: &str) -> bool {
    let expected = expected.as_bytes();
    let supplied = supplied.as_bytes();
    let mut difference = expected.len() ^ supplied.len();
    let max_len = expected.len().max(supplied.len());

    for index in 0..max_len {
        let left = expected.get(index).copied().unwrap_or(0);
        let right = supplied.get(index).copied().unwrap_or(0);
        difference |= usize::from(left ^ right);
    }

    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn enabled_extensions() -> HashMap<String, EnabledExtension> {
        HashMap::from([
            (
                "reader-tools".into(),
                EnabledExtension {
                    permissions: vec![],
                    token: "session-a".into(),
                    port: 24001,
                    backend: Mutex::new(None),
                },
            ),
            (
                "headless".into(),
                EnabledExtension {
                    permissions: vec![],
                    token: "session-b".into(),
                    port: 0,
                    backend: Mutex::new(None),
                },
            ),
        ])
    }

    #[test]
    fn host_must_be_the_literal_listener_authority() {
        assert!(validate_host(Some("127.0.0.1:19555"), 19555));
        assert!(!validate_host(Some("localhost:19555"), 19555));
        assert!(!validate_host(Some("books.example:19555"), 19555));
        assert!(!validate_host(Some("127.0.0.1:19556"), 19555));
        assert!(!validate_host(None, 19555));
    }

    #[test]
    fn origin_is_absent_for_backends_or_exact_for_extension_ui() {
        let enabled = enabled_extensions();
        assert_eq!(
            validate_origin(None, &enabled),
            Ok(ValidatedOrigin::Backend)
        );
        assert_eq!(
            validate_origin(Some("http://127.0.0.1:24001"), &enabled),
            Ok(ValidatedOrigin::Extension {
                value: "http://127.0.0.1:24001".into(),
                name: "reader-tools".into(),
            })
        );

        for malicious in [
            "null",
            "http://localhost:24001",
            "http://evil.example:24001",
            "http://127.0.0.1:24002",
            "http://127.0.0.1:24001/",
            "https://127.0.0.1:24001",
        ] {
            assert!(
                validate_origin(Some(malicious), &enabled).is_err(),
                "{malicious}"
            );
        }
    }

    #[test]
    fn duplicate_origin_ports_fail_closed() {
        let mut enabled = enabled_extensions();
        enabled.insert(
            "duplicate".into(),
            EnabledExtension {
                permissions: vec![],
                token: "session-c".into(),
                port: 24001,
                backend: Mutex::new(None),
            },
        );
        assert!(validate_origin(Some("http://127.0.0.1:24001"), &enabled).is_err());
    }

    #[test]
    fn token_comparison_handles_equal_different_and_length_mismatch() {
        assert!(token_matches("moke_ext_abc", "moke_ext_abc"));
        assert!(!token_matches("moke_ext_abc", "moke_ext_abd"));
        assert!(!token_matches("moke_ext_abc", "moke_ext_abc0"));
        assert!(!token_matches("", "x"));
    }
}
