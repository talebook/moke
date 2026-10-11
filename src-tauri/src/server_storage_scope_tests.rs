use glob::{MatchOptions, Pattern};
use std::path::Path;

#[test]
fn native_server_registry_scopes_cover_hidden_directory_and_atomic_files() {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
    // Exercise both Unix and Windows dotfile options, including mkdir/exists
    // on the directory itself and open/stat/rename on its files.
    for require_literal_leading_dot in [true, false] {
        let options = MatchOptions {
            require_literal_separator: true,
            require_literal_leading_dot,
            ..Default::default()
        };
        for identifier in [
            "fs:allow-exists",
            "fs:allow-mkdir",
            "fs:allow-open",
            "fs:allow-stat",
            "fs:allow-write",
            "fs:allow-remove",
            "fs:allow-rename",
            "fs:allow-fstat",
        ] {
            let permission = capability["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|value| value["identifier"] == identifier)
                .unwrap();
            let patterns: Vec<_> = permission["allow"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| {
                    Pattern::new(
                        &entry["path"]
                            .as_str()
                            .unwrap()
                            .replace("$APPDATA", "/appdata"),
                    )
                    .unwrap()
                })
                .collect();
            let allows = |path: &str| {
                patterns
                    .iter()
                    .any(|pattern| pattern.matches_path_with(Path::new(path), options))
            };
            if identifier != "fs:allow-fstat" {
                assert!(allows("/appdata/books/.servers"), "{identifier} directory");
            }
            for file in [
                "moke-server-storage.json",
                "moke-server-storage.json.uuid.tmp",
                "moke-server-storage-backup-uuid.json",
            ] {
                assert!(
                    allows(&format!("/appdata/books/.servers/{file}")),
                    "{identifier} {file}"
                );
            }
            assert!(
                !allows("/appdata/settings.json"),
                "{identifier} outside books"
            );
            assert!(!allows("/appdata"), "{identifier} bare app directory");
        }
    }
}
