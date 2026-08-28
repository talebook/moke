mod cover_fetch;
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

// Keep build-script profile routing covered by the normal `cargo test --lib`
// command used in CI without compiling it into production application code.
#[cfg(test)]
#[path = "../build_config.rs"]
mod build_config;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::FsExt;

static MOKE_DOWNLOADS_INDEX_LOCK: Mutex<()> = Mutex::new(());

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
    #[serde(default)]
    relative_path: Option<String>,
    #[serde(default)]
    storage_root: Option<String>,
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

/// Performs a full-document navigation inside the current Android/OpenHarmony
/// WebView. Browser navigation is unreliable when crossing between the bundled
/// Moke and Readest Next apps on these runtimes. The command accepts only
/// same-origin absolute paths and is not compiled for desktop or iOS.
#[cfg(any(target_env = "ohos", target_os = "android"))]
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

fn moke_downloads_index_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("moke-downloads.json"))
}

fn moke_download_directory_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("download-directory.json"))
}

fn read_download_directory(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let path = moke_download_directory_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let value: Option<String> =
        serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    Ok(value.map(PathBuf::from))
}

fn write_download_directory(app: &AppHandle, directory: Option<&Path>) -> Result<(), String> {
    let path = moke_download_directory_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let value = directory.map(|path| path.to_string_lossy().into_owned());
    fs::write(
        path,
        serde_json::to_vec(&value).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

/// `std::fs::canonicalize` adds a verbatim prefix on Windows. Keep that form
/// internally for comparisons, but never leak it into the settings UI or the
/// frontend store, where users expect an ordinary drive/UNC path.
fn download_directory_for_frontend(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(stripped) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{}", stripped);
    }
    value
        .strip_prefix(r"\\?\")
        .unwrap_or(value.as_ref())
        .to_string()
}

fn safe_relative_path(value: &str) -> Option<&Path> {
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return None;
    }
    Some(path)
}

fn downloaded_book_path(app: &AppHandle, book: &MokeDownloadedBook) -> Result<PathBuf, String> {
    if let Some(relative) = book.relative_path.as_deref().and_then(safe_relative_path) {
        if let Some(root) = &book.storage_root {
            let stripped = relative.strip_prefix("books").unwrap_or(relative);
            return Ok(PathBuf::from(root).join(stripped));
        }
        return Ok(app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join(relative));
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("books")
        .join(&book.file_name))
}

fn should_prune_missing_download(book: &MokeDownloadedBook) -> bool {
    book.storage_root.is_none()
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
    // 先写同目录临时文件，再以备份方式替换。Windows 的 fs::rename 不会覆盖
    // 已存在目标，直接 tmp -> path 会导致第二次更新起全部失败。
    let tmp_path = path.with_extension("json.tmp");
    let backup_path = path.with_extension("json.bak");
    fs::write(
        &tmp_path,
        serde_json::to_vec(books).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    if backup_path.exists() {
        if path.exists() {
            fs::remove_file(&backup_path).map_err(|error| error.to_string())?;
        } else {
            // 上一次替换若在 current -> backup 后中断，先恢复旧索引再继续。
            fs::rename(&backup_path, &path).map_err(|error| error.to_string())?;
        }
    }
    let had_previous = path.exists();
    if had_previous {
        fs::rename(&path, &backup_path).map_err(|error| error.to_string())?;
    }

    if let Err(error) = fs::rename(&tmp_path, &path) {
        if had_previous {
            let _ = fs::rename(&backup_path, &path);
        }
        return Err(error.to_string());
    }

    if had_previous {
        let _ = fs::remove_file(backup_path);
    }
    Ok(())
}

#[tauri::command]
fn moke_record_downloaded_book(app: AppHandle, book: MokeDownloadedBook) -> Result<(), String> {
    let _guard = MOKE_DOWNLOADS_INDEX_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    if let Some(root) = &book.storage_root {
        let approved = read_download_directory(&app)?
            .and_then(|path| path.canonicalize().ok())
            .ok_or_else(|| "custom download directory is not approved".to_string())?;
        let requested = PathBuf::from(root)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if requested != approved
            || book
                .relative_path
                .as_deref()
                .and_then(safe_relative_path)
                .is_none()
        {
            return Err("custom download path is outside the approved directory".into());
        }
    }
    let mut books = read_moke_downloads(&app)?;
    books.retain(|existing| existing.id != book.id);
    books.push(book);
    write_moke_downloads(&app, &books)
}

#[tauri::command]
fn moke_remove_downloaded_book(app: AppHandle, id: String) -> Result<(), String> {
    let _guard = MOKE_DOWNLOADS_INDEX_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let mut books = read_moke_downloads(&app)?;
    books.retain(|book| book.id != id);
    write_moke_downloads(&app, &books)
}

#[tauri::command]
async fn moke_select_download_directory(app: AppHandle) -> Result<Option<String>, String> {
    // Tauri's folder picker is desktop-only. Keep it out of every mobile
    // target at compile time: Android/iOS expose `FileDialogBuilder`, but do
    // not implement `blocking_pick_folder`.
    #[cfg(any(target_env = "ohos", mobile))]
    {
        let _ = app;
        Err("custom download directory is not supported on this platform".into())
    }

    #[cfg(not(any(target_env = "ohos", mobile)))]
    {
        use tauri_plugin_dialog::DialogExt;

        // Keep directory authorization in one native command: the path can only
        // come from this system picker and is never accepted from frontend IPC.
        let Some(selected) = app
            .dialog()
            .file()
            .set_title("选择下载目录")
            .blocking_pick_folder()
        else {
            return Ok(None);
        };
        let directory = selected
            .into_path()
            .map_err(|error| error.to_string())?
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !directory.is_dir() {
            return Err("download directory must be an existing directory".into());
        }

        app.fs_scope()
            .allow_directory(&directory, true)
            .map_err(|error| error.to_string())?;
        app.state::<tauri::scope::Scopes>()
            .allow_directory(&directory, true)
            .map_err(|error| error.to_string())?;
        write_download_directory(&app, Some(&directory))?;
        Ok(Some(download_directory_for_frontend(&directory)))
    }
}

#[tauri::command]
fn moke_reset_download_directory(app: AppHandle) -> Result<(), String> {
    write_download_directory(&app, None)
}

#[tauri::command]
fn moke_get_download_directory(app: AppHandle) -> Result<Option<String>, String> {
    Ok(read_download_directory(&app)?.map(|path| download_directory_for_frontend(&path)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadStorageStats {
    available_bytes: u64,
}

#[derive(Clone, Copy)]
enum MountPathStyle {
    Native,
    Windows,
}

const SYSTEM_MOUNT_PATH_STYLE: MountPathStyle = if cfg!(windows) {
    MountPathStyle::Windows
} else {
    MountPathStyle::Native
};

/// A Windows drive path normalized independently of the host platform so the
/// matching behavior can also be covered by tests on Unix CI. `canonicalize`
/// may add a verbatim prefix while sysinfo reports ordinary drive mount paths.
struct WindowsDrivePath {
    drive: u8,
    components: Vec<String>,
}

impl WindowsDrivePath {
    fn parse(path: &Path) -> Option<Self> {
        let normalized = path.to_string_lossy().replace('/', "\\");
        let normalized = normalized
            .strip_prefix(r"\\?\")
            .unwrap_or(normalized.as_str());
        let bytes = normalized.as_bytes();
        if bytes.len() < 3
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || bytes[2] != b'\\'
        {
            return None;
        }

        let mut components = Vec::new();
        for component in normalized[3..].split('\\').filter(|part| !part.is_empty()) {
            if matches!(component, "." | "..") {
                return None;
            }
            components.push(component.to_lowercase());
        }
        Some(Self {
            drive: bytes[0].to_ascii_lowercase(),
            components,
        })
    }

    fn starts_with(&self, mount: &Self) -> bool {
        self.drive == mount.drive && self.components.starts_with(&mount.components)
    }

    fn specificity(&self) -> usize {
        3 + self
            .components
            .iter()
            .map(|component| component.len() + 1)
            .sum::<usize>()
    }
}

fn target_is_on_mount(target: &Path, mount: &Path, style: MountPathStyle) -> bool {
    match style {
        MountPathStyle::Native => target.starts_with(mount),
        MountPathStyle::Windows => {
            match (
                WindowsDrivePath::parse(target),
                WindowsDrivePath::parse(mount),
            ) {
                (Some(target), Some(mount)) => target.starts_with(&mount),
                _ => target.starts_with(mount),
            }
        }
    }
}

fn mount_specificity(mount: &Path, style: MountPathStyle) -> usize {
    match style {
        MountPathStyle::Native => mount.as_os_str().len(),
        MountPathStyle::Windows => WindowsDrivePath::parse(mount)
            .map(|path| path.specificity())
            .unwrap_or_else(|| mount.as_os_str().len()),
    }
}

#[tauri::command]
fn moke_download_storage_stats(
    app: AppHandle,
    directory: Option<String>,
) -> Result<DownloadStorageStats, String> {
    let configured = read_download_directory(&app)?;
    let target = match (directory, configured) {
        (Some(requested), Some(configured))
            if PathBuf::from(&requested).canonicalize().ok().as_ref() == Some(&configured) =>
        {
            configured
        }
        (Some(_), _) => return Err("download directory is not approved".into()),
        (None, Some(configured)) => configured,
        (None, None) => app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?,
    };
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let available_bytes = disks
        .list()
        .iter()
        .filter(|disk| target_is_on_mount(&target, disk.mount_point(), SYSTEM_MOUNT_PATH_STYLE))
        .max_by_key(|disk| mount_specificity(disk.mount_point(), SYSTEM_MOUNT_PATH_STYLE))
        .map(|disk| disk.available_space())
        .ok_or_else(|| "disk information unavailable".to_string())?;
    Ok(DownloadStorageStats { available_bytes })
}

/// Lists local Moke downloads for the embedded Readest home page. Files that
/// predate the metadata index are still exposed with a filename-derived title.
#[tauri::command]
fn moke_list_downloaded_books(app: AppHandle) -> Result<Vec<MokeDownloadedBookResponse>, String> {
    let _guard = MOKE_DOWNLOADS_INDEX_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let books_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("books");
    let indexed = read_moke_downloads(&app)?;
    let mut retained = Vec::with_capacity(indexed.len());
    let mut result = Vec::with_capacity(indexed.len());
    let mut pruned_default_record = false;
    for book in indexed {
        match downloaded_book_path(&app, &book) {
            Ok(path) if path.is_file() => {
                result.push(MokeDownloadedBookResponse {
                    file_path: path.to_string_lossy().into_owned(),
                    book: book.clone(),
                });
                retained.push(book);
            }
            // A removable/network drive can be temporarily unavailable. Hide
            // the book for this listing, but preserve its durable index entry.
            _ if !should_prune_missing_download(&book) => retained.push(book),
            _ => pruned_default_record = true,
        }
    }
    if pruned_default_record {
        write_moke_downloads(&app, &retained)?;
    }

    if books_dir.is_dir() {
        for entry in fs::read_dir(&books_dir).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if file_name.starts_with('.')
                || !path.is_file()
                || result.iter().any(|book| book.book.file_name == file_name)
            {
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
                    relative_path: None,
                    storage_root: None,
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

fn moke_invoke_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static
{
    tauri::generate_handler![
        moke_runtime_platform,
        cover_fetch::moke_fetch_public_cover,
        #[cfg(any(target_env = "ohos", target_os = "android"))]
        moke_navigate,
        moke_record_downloaded_book,
        moke_remove_downloaded_book,
        moke_select_download_directory,
        moke_reset_download_directory,
        moke_get_download_directory,
        moke_download_storage_stats,
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
            // Restore only the directory that was explicitly selected and persisted earlier.
            if let Ok(Some(directory)) = read_download_directory(_app.handle()) {
                let _ = _app.fs_scope().allow_directory(&directory, true);
                let _ = _app
                    .state::<tauri::scope::Scopes>()
                    .allow_directory(&directory, true);
            }

            #[cfg(debug_assertions)]
            _app.add_capability(reader_dev_remote_capability()?)?;

            // 初始化阅读器相关的进程内状态（如 LocalSend 与 Discord Rich Presence）。
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
mod download_storage_tests {
    use super::{
        download_directory_for_frontend, mount_specificity, should_prune_missing_download,
        target_is_on_mount, MokeDownloadedBook, MountPathStyle,
    };
    use std::path::Path;

    fn selected_mount<'a>(
        target: &str,
        mounts: &'a [&'a str],
        style: MountPathStyle,
    ) -> Option<&'a str> {
        mounts
            .iter()
            .copied()
            .filter(|mount| target_is_on_mount(Path::new(target), Path::new(mount), style))
            .max_by_key(|mount| mount_specificity(Path::new(mount), style))
    }

    #[test]
    fn windows_mount_matching_normalizes_verbatim_paths_drive_and_case() {
        let style = MountPathStyle::Windows;
        assert!(target_is_on_mount(
            Path::new(r"\\?\c:\Users\Moke\Downloads"),
            Path::new(r"C:\"),
            style,
        ));
        assert!(target_is_on_mount(
            Path::new(r"C:\Users\Moke\Downloads"),
            Path::new(r"\\?\c:\users"),
            style,
        ));
        assert!(!target_is_on_mount(
            Path::new(r"\\?\C:\Users\Moke\Downloads"),
            Path::new(r"D:\"),
            style,
        ));
        assert!(!target_is_on_mount(
            Path::new(r"C:\Users\Moke\Downloads"),
            Path::new(r"C:\User"),
            style,
        ));
    }

    #[test]
    fn windows_mount_selection_prefers_the_deepest_component_prefix() {
        let mounts = [r"C:\", r"C:\Users", r"c:\users\moke", r"C:\Users\Mo"];
        assert_eq!(
            selected_mount(
                r"\\?\C:\Users\Moke\Downloads",
                &mounts,
                MountPathStyle::Windows,
            ),
            Some(r"c:\users\moke"),
        );
    }

    #[test]
    fn frontend_directory_strips_windows_verbatim_prefixes() {
        assert_eq!(
            download_directory_for_frontend(Path::new(r"\\?\C:\Users\Administrator\Downloads")),
            r"C:\Users\Administrator\Downloads",
        );
        assert_eq!(
            download_directory_for_frontend(Path::new(r"\\?\UNC\server\books")),
            r"\\server\books",
        );
    }

    #[test]
    fn missing_custom_downloads_are_not_pruned_from_the_index() {
        let mut book = MokeDownloadedBook {
            id: "book".into(),
            server_url: "https://books.test".into(),
            book_id: "1".into(),
            title: "Book".into(),
            file_name: "book.epub".into(),
            relative_path: Some("books/server/1/epub/book.epub".into()),
            storage_root: Some(r"D:\Books".into()),
            mime_type: "application/epub+zip".into(),
            updated_at: 1,
        };
        assert!(!should_prune_missing_download(&book));
        book.storage_root = None;
        assert!(should_prune_missing_download(&book));
    }

    #[cfg(unix)]
    #[test]
    fn unix_mount_selection_keeps_native_longest_prefix_behavior() {
        let mounts = ["/", "/srv", "/srv/books", "/srv/book"];
        assert_eq!(
            selected_mount(
                "/srv/books/library/title.epub",
                &mounts,
                MountPathStyle::Native,
            ),
            Some("/srv/books"),
        );
    }
}

#[cfg(test)]
mod fs_scope_tests {
    use glob::{MatchOptions, Pattern};
    use serde_json::Value;
    use std::path::{Path, PathBuf};

    // Mirrors the pinned Tauri `fs::Scope::new` options
    // (`vendor/tauri/crates/tauri/src/scope/fs.rs`). `glob` derives Default,
    // so matching is case-insensitive; Tauri overrides only separator and
    // platform dotfile handling here.
    fn tauri_match_options() -> MatchOptions {
        MatchOptions {
            require_literal_separator: true,
            require_literal_leading_dot: cfg!(unix),
            ..Default::default()
        }
    }

    // The asset handler percent-decodes the request path and validates it with
    // SafePathBuf before consulting fs::Scope. Lock that serve-time boundary so
    // the static glob test below is not mistaken for the traversal defense.
    #[test]
    fn asset_protocol_rejects_parent_traversal_before_scope_matching() {
        let decoded_request_path = PathBuf::from("/appdata/Readest/../../../etc/hosts");
        assert!(tauri::path::SafePathBuf::new(decoded_request_path).is_err());
    }

    // TB-85 F4 / TB-89 security regression: an unanchored pattern such as
    // `**/Readest/**/*` lets the asset protocol serve any absolute path that
    // happens to contain a `Readest` directory. Keep every static entry bound
    // to a known application/system base directory. Readest's managed files
    // live below `$APPDATA/Readest` and are already covered by `$APPDATA/**/*`.
    // For external books, Readest's `allow_paths_in_scopes` and
    // `open_reader_window` explicitly grant the selected file to both fs and
    // asset scopes after checking the picker/fs authorization.
    #[test]
    fn asset_protocol_allow_entries_are_anchored_to_known_roots() {
        let opts = tauri_match_options();
        let config_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let text = std::fs::read_to_string(&config_path)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", config_path.display()));
        let config: Value = serde_json::from_str(&text).unwrap();
        let allow = config["app"]["security"]["assetProtocol"]["scope"]["allow"]
            .as_array()
            .expect("asset protocol allow scope must be an array");
        let known_roots = [
            ("$RESOURCE", "/resource"),
            ("$APPDATA", "/appdata"),
            ("$APPCACHE", "/appcache"),
            ("$TEMP", "/temp"),
        ];

        let patterns: Vec<_> = allow
            .iter()
            .map(|entry| {
                let path = entry
                    .as_str()
                    .expect("asset protocol allow entries must be strings");
                assert!(
                    !path
                        .split(|c| c == '/' || c == '\\')
                        .any(|part| part == ".."),
                    "{} asset allow path {path} contains parent traversal",
                    config_path.display()
                );
                let resolved = known_roots
                    .iter()
                    .find_map(|(variable, root)| {
                        path.strip_prefix(*variable).and_then(|suffix| {
                            suffix.starts_with('/').then(|| format!("{root}{suffix}"))
                        })
                    })
                    .unwrap_or_else(|| {
                        panic!(
                            "{} asset allow path {path} is not anchored to a known root",
                            config_path.display()
                        )
                    });
                let pattern = Pattern::new(&resolved).unwrap_or_else(|e| {
                    panic!(
                        "bad asset glob {resolved} in {} ({path}): {e}",
                        config_path.display()
                    )
                });
                (path, pattern)
            })
            .collect();

        for outside in [
            "/home/u/Documents/Readest/x.pdf",
            "C:/Users/u/Downloads/Readest/a.docx",
        ] {
            for (configured, pattern) in &patterns {
                assert!(
                    !pattern.matches_path_with(Path::new(outside), opts),
                    "{} asset allow path {configured} exposes unrelated file {outside}",
                    config_path.display()
                );
            }
        }

        // `nativeAppService.getURL()` sends this representative managed book
        // path through `convertFileSrc`; removing the unanchored fallback must
        // not break assets stored in Readest's real AppData subtree.
        let managed_book = Path::new("/appdata/Readest/Books/hash/book.epub");
        assert!(
            patterns
                .iter()
                .any(|(_, pattern)| pattern.matches_path_with(managed_book, opts)),
            "managed Readest AppData files must remain in the asset scope"
        );
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

    // Bare app-directory roots stay out of scope except for the reader's two
    // metadata and mkdir roots. NativeAppService checks these roots with
    // `exists` and creates them before writing root-level settings/cache files.
    // The mkdir-only grant must not broaden remove/rename/write access. Parse
    // the committed files and exercise the same matching `is_allowed` performs.
    #[test]
    fn capability_fs_allow_entries_grant_only_required_bare_roots() {
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
                let Some(id) = perm["identifier"].as_str() else {
                    continue;
                };
                if !id.starts_with("fs:") && !id.starts_with("opener:") {
                    continue;
                }
                let Some(allow) = perm["allow"].as_array() else {
                    continue;
                };
                for entry in allow {
                    let Some(path) = entry["path"].as_str() else {
                        continue;
                    };
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
                    let is_reader_capability = file.ends_with("capabilities/reader.json")
                        || file.ends_with("capabilities/reader-mobile.json");
                    let is_required_reader_root = is_reader_capability
                        && matches!(id, "fs:read-dirs" | "fs:allow-mkdir")
                        && matches!(path, "$APPCONFIG" | "$APPCACHE");
                    let p = Pattern::new(&resolved).unwrap_or_else(|e| {
                        panic!("bad glob {resolved} in {} ({id}): {e}", file.display())
                    });
                    assert!(
                        is_required_reader_root || !p.matches_path_with(Path::new(bare_root), opts),
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
