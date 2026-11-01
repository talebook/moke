//! The discovery writer has one fixed destination and one permitted mutation.
//! It never accepts a path or changes an existing saved-server record.
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_BYTES: u64 = 4 * 1024 * 1024;
const FILE_NAME: &str = "moke-saved-servers-v2.json";
static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
pub(crate) struct RegistryError {
    pub code: String,
    pub message: String,
}

impl RegistryError {
    pub(crate) fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.to_owned(),
            message: message.to_owned(),
        }
    }
}

fn invalid() -> RegistryError {
    RegistryError::new("invalid_payload", "发现保存内容无效")
}
fn io_error() -> RegistryError {
    RegistryError::new("storage_io", "服务器列表保存状态未知，请重新载入核实")
}
fn conflict() -> RegistryError {
    RegistryError::new("storage_conflict", "服务器列表已改变，请重新载入后重试")
}

fn read_current(path: &Path) -> Result<Option<String>, RegistryError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(io_error()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_BYTES {
        return Err(io_error());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| io_error())?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| io_error())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(io_error());
    }
    String::from_utf8(bytes).map(Some).map_err(|_| io_error())
}

fn identifier(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty() && !value.chars().any(char::is_control))
}

fn validate_append(
    expected: Option<&str>,
    value: &str,
    base_url: &str,
    row_id: &str,
) -> Result<(), RegistryError> {
    if value.len() as u64 > MAX_BYTES || expected.is_some_and(|raw| raw.len() as u64 > MAX_BYTES) {
        return Err(invalid());
    }
    let mut old: Value = match expected {
        Some(raw) => serde_json::from_str(raw).map_err(|_| invalid())?,
        None => {
            serde_json::json!({"version":2,"savedServers":[],"legacySources":{"stateRaw":null,"urlRaw":null}})
        }
    };
    let new: Value = serde_json::from_str(value).map_err(|_| invalid())?;
    let old_object = old.as_object().ok_or_else(invalid)?;
    if old_object.get("version") != Some(&Value::from(2)) {
        return Err(invalid());
    }
    let entries = old_object
        .get("savedServers")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let new_entries = new
        .get("savedServers")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if new_entries.len() != entries.len() + 1 || new_entries[..entries.len()] != entries[..] {
        return Err(invalid());
    }
    let added = new_entries
        .last()
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    let allowed = [
        "id",
        "url",
        "title",
        "addedAt",
        "displayName",
        "entryRevision",
        "status",
        "legacyAliases",
        "originals",
    ];
    if added.keys().any(|key| !allowed.contains(&key.as_str()))
        || !identifier(added.get("id"))
        || !identifier(added.get("entryRevision"))
        || added.get("id").and_then(Value::as_str) == Some(row_id)
        || added.get("url").and_then(Value::as_str) != Some(base_url)
        || added.get("status").and_then(Value::as_str) != Some("ready")
        || !added.get("title").is_some_and(Value::is_string)
        || !added.get("addedAt").is_some_and(Value::is_string)
        || added
            .get("legacyAliases")
            .and_then(Value::as_array)
            .map(Vec::is_empty)
            != Some(true)
        || added
            .get("originals")
            .and_then(Value::as_array)
            .map(Vec::is_empty)
            != Some(true)
        || added.get("displayName").is_some_and(|value| {
            value.as_str().map_or(true, |name| {
                name.chars().count() > 128 || name.chars().any(char::is_control)
            })
        })
        || entries.iter().any(|entry| {
            entry.get("url").and_then(Value::as_str) == Some(base_url)
                || entry.get("id") == added.get("id")
        })
    {
        return Err(invalid());
    }
    old.as_object_mut()
        .ok_or_else(invalid)?
        .insert("savedServers".into(), Value::Array(new_entries.clone()));
    if old != new {
        return Err(invalid());
    }
    Ok(())
}

/// `recheck` drains source revocations while the caller owns discovery's state
/// lock. No await or unguarded caller code occurs between its final invocation,
/// the final byte-for-byte CAS, and the synchronous atomic rename.
pub(crate) fn commit_registry(
    app_config: &Path,
    expected: Option<&str>,
    value: &str,
    base_url: &str,
    row_id: &str,
    mut recheck: impl FnMut() -> Result<(), RegistryError>,
) -> Result<(), RegistryError> {
    let directory = app_config.join("server-registry");
    let path = directory.join(FILE_NAME);
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(io_error())
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(io_error()),
    }
    if read_current(&path)?.as_deref() != expected {
        return Err(conflict());
    }
    if expected == Some(value) {
        // An existing entry can be focused only through the same current source
        // gate. This path creates neither directories nor temporary files.
        let registry: Value = serde_json::from_str(value).map_err(|_| invalid())?;
        if registry.get("version") != Some(&Value::from(2))
            || !registry
                .get("savedServers")
                .and_then(Value::as_array)
                .is_some_and(|entries| {
                    entries.iter().any(|entry| {
                        entry.get("url").and_then(Value::as_str) == Some(base_url)
                            && entry.get("status").and_then(Value::as_str) == Some("ready")
                    })
                })
        {
            return Err(invalid());
        }
        recheck()?;
        if read_current(&path)?.as_deref() != expected {
            return Err(conflict());
        }
        recheck()?;
        return Ok(());
    }
    validate_append(expected, value, base_url, row_id)?;
    fs::create_dir_all(&directory).map_err(|_| io_error())?;
    if fs::symlink_metadata(&directory)
        .map_err(|_| io_error())?
        .file_type()
        .is_symlink()
    {
        return Err(io_error());
    }
    let temporary: PathBuf = directory.join(format!(
        "{FILE_NAME}.native-{}-{}.tmp",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| io_error())?;
    let result = (|| {
        file.write_all(value.as_bytes()).map_err(|_| io_error())?;
        file.sync_all().map_err(|_| io_error())?;
        drop(file);
        recheck()?;
        if read_current(&path)?.as_deref() != expected {
            return Err(conflict());
        }
        // Recheck after CAS IO as well: TTL or queued goodbye may have changed
        // while the old registry was being read. Rename is the persistence
        // point; source ordering follows this final gate under the state lock.
        // A later packet is handled by the next actor operation. This is not
        // an OS-wide CAS or an atomic observation of future network traffic.
        recheck()?;
        fs::rename(&temporary, &path).map_err(|_| io_error())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    const BASE: &str = "https://books.home.arpa:8080/team/books";
    const ROW: &str = "9f0c663b-8ffd-4e13-92d9-2b68572c08b1";
    fn root() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "moke-discovery-registry-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        path
    }
    fn empty() -> String {
        serde_json::json!({"version":2,"savedServers":[],"legacySources":{"stateRaw":"preserved-original","urlRaw":null}}).to_string()
    }
    fn appended(raw: &str) -> String {
        let mut registry: Value = serde_json::from_str(raw).unwrap();
        registry["savedServers"].as_array_mut().unwrap().push(serde_json::json!({"id":"stable-local-id","url":BASE,"title":"Test","addedAt":"2026-11-01","entryRevision":"revision-1","status":"ready","legacyAliases":[],"originals":[]}));
        registry.to_string()
    }
    fn seed(root: &Path, raw: &str) {
        fs::create_dir(root.join("server-registry")).unwrap();
        fs::write(root.join("server-registry").join(FILE_NAME), raw).unwrap();
    }
    #[test]
    fn actual_fixed_file_append_and_duplicate_check_only_preserve_originals() {
        let root = root();
        let before = empty();
        seed(&root, &before);
        let after = appended(&before);
        commit_registry(&root, Some(&before), &after, BASE, ROW, || Ok(())).unwrap();
        assert_eq!(
            read_current(&root.join("server-registry").join(FILE_NAME))
                .unwrap()
                .as_deref(),
            Some(after.as_str())
        );
        let mut checks = 0;
        commit_registry(&root, Some(&after), &after, BASE, ROW, || {
            checks += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(checks, 2);
        assert_eq!(
            fs::read_dir(root.join("server-registry")).unwrap().count(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalidation_after_temporary_write_leaves_authority_untouched() {
        let root = root();
        let before = empty();
        seed(&root, &before);
        let after = appended(&before);
        let failure = commit_registry(&root, Some(&before), &after, BASE, ROW, || {
            Err(RegistryError::new("candidate_unavailable", "expired"))
        })
        .unwrap_err();
        assert_eq!(failure.code, "candidate_unavailable");
        assert_eq!(failure.message, "expired");
        assert_eq!(
            read_current(&root.join("server-registry").join(FILE_NAME))
                .unwrap()
                .as_deref(),
            Some(before.as_str())
        );
        assert_eq!(
            fs::read_dir(root.join("server-registry")).unwrap().count(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn final_gate_rechecks_after_compare_read_and_rejects_conflicts() {
        let root = root();
        let before = empty();
        seed(&root, &before);
        let after = appended(&before);
        let mut calls = 0;
        let failure = commit_registry(&root, Some(&before), &after, BASE, ROW, || {
            calls += 1;
            if calls == 2 {
                Err(RegistryError::new("candidate_unavailable", "expired"))
            } else {
                Ok(())
            }
        })
        .unwrap_err();
        assert_eq!(failure.code, "candidate_unavailable");
        assert_eq!(calls, 2);
        assert_eq!(
            commit_registry(&root, Some("wrong"), &after, BASE, ROW, || Ok(()))
                .unwrap_err()
                .code,
            "storage_conflict"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn payload_cannot_rewrite_archive_existing_entry_source_or_local_identity() {
        let before = empty();
        let after = appended(&before);
        for changed in [
            after.replace("preserved-original", "lost"),
            after.replace(BASE, "https://other.home.arpa:8080/team/books"),
            after.replace("stable-local-id", ROW),
            after.replace("\"ready\"", "\"collision\""),
        ] {
            assert!(validate_append(Some(&before), &changed, BASE, ROW).is_err());
        }
        assert!(validate_append(Some(&after), &appended(&after), BASE, ROW).is_err());
    }

    #[test]
    fn registry_changed_during_preparation_is_preserved_and_not_overwritten() {
        let root = root();
        let before = empty();
        seed(&root, &before);
        let after = appended(&before);
        let concurrent = before.replace("preserved-original", "concurrent-original");
        let failure = commit_registry(&root, Some(&before), &after, BASE, ROW, || {
            fs::write(root.join("server-registry").join(FILE_NAME), &concurrent).unwrap();
            Ok(())
        })
        .unwrap_err();
        assert_eq!(failure.code, "storage_conflict");
        assert_eq!(
            read_current(&root.join("server-registry").join(FILE_NAME))
                .unwrap()
                .as_deref(),
            Some(concurrent.as_str())
        );
        assert_eq!(
            fs::read_dir(root.join("server-registry")).unwrap().count(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn fixed_registry_destination_rejects_a_directory_symlink() {
        let root = root();
        let outside = root.join("outside");
        fs::create_dir(&outside).unwrap();
        let before = empty();
        fs::write(outside.join(FILE_NAME), &before).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("server-registry")).unwrap();
        let failure = commit_registry(&root, Some(&before), &appended(&before), BASE, ROW, || {
            Ok(())
        })
        .unwrap_err();
        assert_eq!(failure.code, "storage_io");
        assert_eq!(fs::read_to_string(outside.join(FILE_NAME)).unwrap(), before);
        fs::remove_dir_all(root).unwrap();
    }
}
