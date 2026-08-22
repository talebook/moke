/// Moke 桌面客户端入口。
///
/// 阅读器（readest）的 Rust 后端通过 `readestlib` 以库形式编译进本应用：
/// - 基础插件（fs/http/os/shell/opener）由 moke 自己注册，供两端复用；
/// - 其余阅读器专用插件由 `readestlib::register_reader_plugins` 统一注册；
/// - 阅读器前端以"裸命令名"调用的所有后端命令（含 `open_reader`）由
///   `readestlib::reader_invoke_handler()` 一次性挂到应用级 handler。
///
/// `open_reader` 现在在进程内新开阅读器窗口（不再 spawn 外部 exe），因此整个
/// 应用最终只产出一个二进制。前端调用方式 `invoke('open_reader', { filePath })`
/// 保持不变。更换阅读器只需替换 `readestlib` 依赖与 `/readest` 前端产物。
///
/// 拓展系统：通过 `extensions` 模块管理拓展的发现、生命周期、存储。
/// 拓展以独立进程方式运行，通过本地 HTTP + WebSocket 与主程序通信。

mod extensions;

use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{AppHandle, Manager};

/// Metadata for a book downloaded by Moke.  The reader uses this small host
/// API instead of reaching into Moke's IndexedDB, which is private to the
/// main WebView.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MokeDownloadedBook {
    id: String,
    server_url: String,
    book_id: String,
    title: String,
    file_name: String,
    mime_type: String,
    updated_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MokeDownloadedBookResponse {
    #[serde(flatten)]
    book: MokeDownloadedBook,
    file_path: String,
}

/// `tauri-plugin-os` reports OpenHarmony as Linux because the Rust target uses
/// `target_os = "linux"`. Expose the target environment explicitly so the
/// frontend can select the single-WebView reader flow on OHOS.
#[tauri::command]
fn moke_runtime_platform() -> &'static str {
    #[cfg(target_env = "ohos")]
    return "ohos";

    #[cfg(not(target_env = "ohos"))]
    std::env::consts::OS
}

/// Performs a full-document navigation inside the current OpenHarmony WebView.
/// ArkWeb cannot reliably execute Next.js App Router's RSC navigation over
/// the custom `tauri://` scheme, and Moke/Readest are separate Next apps.
/// Other platforms use normal browser navigation and do not register this
/// privileged command.
#[cfg(target_env = "ohos")]
#[tauri::command]
fn moke_navigate(webview: tauri::Webview, path: String) -> Result<(), String> {
    if !path.starts_with('/') || path.starts_with("//") {
        return Err("navigation path must stay inside the application".into());
    }

    let target = webview
        .url()
        .map_err(|error| error.to_string())?
        .join(&path)
        .map_err(|error| error.to_string())?;
    webview.navigate(target).map_err(|error| error.to_string())
}

fn moke_downloads_index_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|error| error.to_string())?.join("moke-downloads.json"))
}

fn read_moke_downloads(app: &AppHandle) -> Result<Vec<MokeDownloadedBook>, String> {
    let path = moke_downloads_index_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

fn write_moke_downloads(app: &AppHandle, books: &[MokeDownloadedBook]) -> Result<(), String> {
    let path = moke_downloads_index_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    // 原子写入：先写同目录临时文件再 rename，避免写入中途崩溃/断电留下截断损坏的索引。
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, serde_json::to_vec(books).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    fs::rename(&tmp_path, &path).map_err(|error| error.to_string())
}

#[tauri::command]
fn moke_record_downloaded_book(app: AppHandle, book: MokeDownloadedBook) -> Result<(), String> {
    let mut books = read_moke_downloads(&app)?;
    books.retain(|existing| existing.id != book.id);
    books.push(book);
    write_moke_downloads(&app, &books)
}

#[tauri::command]
fn moke_remove_downloaded_book(app: AppHandle, id: String) -> Result<(), String> {
    let mut books = read_moke_downloads(&app)?;
    books.retain(|book| book.id != id);
    write_moke_downloads(&app, &books)
}

/// Lists local Moke downloads for the embedded Readest home page. Files that
/// predate the metadata index are still exposed with a filename-derived title.
#[tauri::command]
fn moke_list_downloaded_books(app: AppHandle) -> Result<Vec<MokeDownloadedBookResponse>, String> {
    let books_dir = app.path().app_data_dir().map_err(|error| error.to_string())?.join("books");
    let mut indexed = read_moke_downloads(&app)?;
    indexed.retain(|book| books_dir.join(&book.file_name).is_file());
    write_moke_downloads(&app, &indexed)?;

    let mut result: Vec<_> = indexed
        .into_iter()
        .map(|book| MokeDownloadedBookResponse {
            file_path: books_dir.join(&book.file_name).to_string_lossy().into_owned(),
            book,
        })
        .collect();

    if books_dir.is_dir() {
        for entry in fs::read_dir(&books_dir).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if !path.is_file() || result.iter().any(|book| book.book.file_name == file_name) {
                continue;
            }
            let title = path
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or(&file_name)
                .to_string();
            let updated_at = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or_default();
            result.push(MokeDownloadedBookResponse {
                book: MokeDownloadedBook {
                    id: format!("legacy:{file_name}"),
                    server_url: String::new(),
                    book_id: String::new(),
                    title,
                    file_name,
                    mime_type: String::new(),
                    updated_at,
                },
                file_path: path.to_string_lossy().into_owned(),
            });
        }
    }

    result.sort_by(|left, right| right.book.updated_at.cmp(&left.book.updated_at));
    Ok(result)
}

fn moke_invoke_handler(
) -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        moke_runtime_platform,
        #[cfg(target_env = "ohos")]
        moke_navigate,
        moke_record_downloaded_book,
        moke_remove_downloaded_book,
        moke_list_downloaded_books,
    ]
}

/// Development reader pages can be served directly by the Readest server on
/// port 3001. Clone the audited local reader capability at runtime instead of
/// compiling that remote origin into release builds.
#[cfg(debug_assertions)]
fn reader_dev_remote_capability() -> Result<String, serde_json::Error> {
    let mut capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/reader.json"))?;
    capability["identifier"] = "reader-dev-remote".into();
    capability["description"] = "Development-only remote Readest capability".into();
    capability["local"] = false.into();
    capability["remote"] = serde_json::json!({
        "urls": ["http://localhost:3001/**"]
    });
    serde_json::to_string(&capability)
}

/// KDE Plasma Wayland: WebKitGTK's DMA-BUF renderer fails to repaint the
/// window until it is resized (see talebook/moke#7). Fall back to the
/// shared-memory renderer, which repaints correctly; harmless on X11
/// sessions and non-KDE Wayland compositors. Must run before GTK/WebKit
/// initialization, so it lives at the very top of `run()`.
#[cfg(all(target_os = "linux", not(target_env = "ohos")))]
fn apply_linux_wayland_workarounds() {
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(all(target_os = "linux", not(target_env = "ohos")))]
    apply_linux_wayland_workarounds();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init());

    let builder = builder
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_oauth::init())
        .plugin(tauri_plugin_device_info::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("tracing", log::LevelFilter::Warn)
                .build(),
        )
        // Patched copy (readest's patches/tauri-plugin-deep-link) compiles on
        // OpenHarmony too; with no OS deep-link integration there,
        // `get_current` answers null and the frontend's cold-start deep-link
        // read doesn't reject IPC.
        .plugin(tauri_plugin_deep_link::init());

    #[cfg(not(target_env = "ohos"))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init());

    // 注册阅读器（readest）后端额外依赖的插件（dialog / turso / native-tts 等）。
    let builder = readestlib::register_reader_plugins(builder);
    // Android reader files are served via Readest's `rangefile` URI scheme.
    // The embedded host must register it too; otherwise mobile WebViews cannot
    // read EPUB/PDF byte ranges and the reader remains blank.
    let builder = readestlib::register_reader_protocols(builder);

    // 合并拓展系统的 Tauri commands 与 readest 的命令 handler。
    // 拓展命令以 "ext_" 为前缀，readest 命令不包含此前缀，
    // 通过命令名分派到对应的 handler，避免 Invoke 被移动两次。
    builder
        .invoke_handler({
            let reader_handler = readestlib::reader_invoke_handler();
            #[cfg(not(target_env = "ohos"))]
            let ext_handler = extensions::invoke_handler();
            let moke_handler = moke_invoke_handler();
            move |invoke| {
                let cmd = invoke.message.command().to_string();
                #[cfg(not(target_env = "ohos"))]
                if cmd.starts_with("ext_") {
                    ext_handler(invoke)
                } else if cmd.starts_with("moke_") {
                    moke_handler(invoke)
                } else {
                    reader_handler(invoke)
                }
                #[cfg(target_env = "ohos")]
                if cmd.starts_with("moke_") {
                    moke_handler(invoke)
                } else {
                    reader_handler(invoke)
                }
            }
        })
        .setup(|_app| {
            #[cfg(debug_assertions)]
            _app.add_capability(reader_dev_remote_capability()?)?;

            // 初始化阅读器相关的进程内状态（如 Discord Rich Presence 客户端）。
            // readestlib 只在桌面目标暴露 manage_reader_state（OHOS 上被 cfg 排除）。
            #[cfg(not(target_env = "ohos"))]
            readestlib::manage_reader_state(_app.handle());

            // 初始化拓展系统（REST+WS 服务器，仅桌面端；OHOS 上曾导致主线程阻塞）。
            #[cfg(not(target_env = "ohos"))]
            extensions::init(_app.handle());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod fs_scope_tests {
    use glob::{MatchOptions, Pattern};
    use serde_json::Value;
    use std::path::Path;

    // Mirrors the exact MatchOptions tauri's `fs::Scope::is_allowed` uses
    // (tauri/src/scope/fs.rs): require_literal_separator: true so `/dir/*`
    // doesn't match files inside subdirectories.
    fn tauri_match_options() -> MatchOptions {
        MatchOptions {
            require_literal_separator: true,
            require_literal_leading_dot: false,
            case_sensitive: true,
        }
    }

    // HOU-30 security regression: "removing bare roots" only holds if
    // `$APPDATA/**` does NOT match the bare `$APPDATA` directory itself.
    // `remove(appDataDir(), {recursive:true})` / `rename` / `mkdir(appDataDir())`
    // must all be rejected by the merged fs scope. This asserts the real glob
    // matching behavior (same crate version + MatchOptions Tauri uses), so the
    // hardening can't silently regress if the glob pattern form changes.
    #[test]
    fn double_star_does_not_match_bare_root() {
        let opts = tauri_match_options();
        let p = Pattern::new("/home/u/AppData/**").unwrap();
        assert!(!p.matches_path_with(Path::new("/home/u/AppData"), opts));
        assert!(p.matches_path_with(Path::new("/home/u/AppData/books"), opts));
        assert!(p.matches_path_with(Path::new("/home/u/AppData/settings.json"), opts));
        assert!(!p.matches_path_with(Path::new("/home/u/AppDataX/evil"), opts));
    }

    // Every `$VAR/**` entry in the committed capability files must keep the
    // bare `$VAR` root out of scope. Parse the real production/dev files and
    // exercise the same matching `is_allowed` performs.
    #[test]
    fn capability_fs_allow_entries_keep_bare_roots_out_of_scope() {
        let opts = tauri_match_options();
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let files = [
            manifest_dir.join("capabilities/default.json"),
            manifest_dir.join("capabilities/reader.json"),
            manifest_dir.join("capabilities/reader-mobile.json"),
            manifest_dir.join("capabilities/ohos.json"),
            manifest_dir.join("capabilities-dev/ohos.json"),
        ];
        for file in &files {
            let text = std::fs::read_to_string(file)
                .unwrap_or_else(|e| panic!("cannot read {}: {e}", file.display()));
            let cap: Value = serde_json::from_str(&text).unwrap();
            let perms = cap["permissions"].as_array().unwrap();
            for perm in perms {
                let Some(id) = perm["identifier"].as_str() else { continue };
                if !id.starts_with("fs:") && !id.starts_with("opener:") {
                    continue;
                }
                let Some(allow) = perm["allow"].as_array() else { continue };
                for entry in allow {
                    let Some(path) = entry["path"].as_str() else { continue };
                    // Replace the $VAR with a concrete root to exercise glob
                    // matching the way the resolved scope would.
                    let resolved = path
                        .replace("$APPDATA", "/appdata")
                        .replace("$APPCONFIG", "/appconfig")
                        .replace("$APPCACHE", "/appcache")
                        .replace("$APPLOG", "/applog")
                        .replace("$TEMP", "/temp");
                    let bare_root = match path.split('/').next() {
                        Some("$APPDATA") => "/appdata",
                        Some("$APPCONFIG") => "/appconfig",
                        Some("$APPCACHE") => "/appcache",
                        Some("$APPLOG") => "/applog",
                        Some("$TEMP") => "/temp",
                        _ => continue,
                    };
                    let p = Pattern::new(&resolved).unwrap_or_else(|e| {
                        panic!("bad glob {resolved} in {} ({id}): {e}", file.display())
                    });
                    assert!(
                        !p.matches_path_with(Path::new(bare_root), opts),
                        "{} {id} allow path {path} matches bare root {bare_root}",
                        file.display()
                    );
                }
            }
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn reader_remote_origin_is_added_only_as_a_debug_capability() {
        let dev: Value =
            serde_json::from_str(&super::reader_dev_remote_capability().unwrap()).unwrap();
        let reader: Value =
            serde_json::from_str(include_str!("../capabilities/reader.json")).unwrap();

        assert_eq!(dev["identifier"], "reader-dev-remote");
        assert_eq!(dev["local"], false);
        assert_eq!(dev["remote"]["urls"][0], "http://localhost:3001/**");
        assert_eq!(dev["windows"], reader["windows"]);
        assert_eq!(dev["permissions"], reader["permissions"]);
    }
}
