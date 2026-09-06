//! Moke 拓展系统 — 模块入口。
//!
//! 负责注册 Tauri commands、管理全局状态和启动 API 服务器。

mod api_server;
mod discovery;
mod events;
mod lifecycle;
mod permissions;
mod security;
mod storage;
mod trust;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU16;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use tauri::AppHandle;
use tauri::Emitter;
use tauri::Listener;
use tauri::Manager;

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

/// 拓展系统的运行时状态。
pub struct ExtensionRuntime {
    /// 已启用的拓展：name → EnabledExtension
    pub enabled: Arc<Mutex<HashMap<String, EnabledExtension>>>,
    /// 下一个可分配给拓展的端口
    pub next_port: Arc<AtomicU16>,
    /// 拓展根目录
    pub extensions_dir: PathBuf,
    /// API Server REST 端口（启动后设置）
    pub api_port: u16,
    /// WebSocket 端口（启动后设置）
    pub ws_port: u16,
    /// WebSocket 广播发送端，供 ext_reader_event 等向外广播事件
    pub ws_broadcast: Sender<events::WsBroadcast>,
    /// 阻塞等待命令回执的注册表。外部请求按拓展和目标窗口隔离，阅读器
    /// 回执使用每次调用独有的 correlation_id，并校验上报窗口来源。
    pub pending_commands: Arc<Mutex<api_server::PendingCommands>>,
    /// 端口分配的起始值（wrap 时回到这里）
    pub port_range_start: u16,
}

/// 单个已启用拓展的运行时信息。
pub struct EnabledExtension {
    /// 认证 token（拓展调用 API 时携带）
    pub token: String,
    /// 分配给该拓展的本地端口（用于拓展自己的后端）
    pub port: u16,
    /// 拓展后端进程句柄（None 表示纯前端拓展）
    pub backend: Mutex<Option<std::process::Child>>,
    /// 启用时经用户确认的权限快照。运行期间不再信任可变的 manifest。
    pub permissions: Vec<String>,
}

// ---------------------------------------------------------------------------
// 前端可见的数据结构
// ---------------------------------------------------------------------------

/// 返回给前端管理界面的拓展摘要。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ExtensionInfo {
    pub name: String,
    pub version: String,
    pub display_name: String,
    pub description: String,
    pub author: String,
    pub enabled: bool,
    /// 拓展后端监听的端口（仅 enabled 时有效）
    pub port: u16,
    pub permissions: Vec<String>,
    pub sidebar: Option<SidebarInfo>,
    pub has_backend: bool,
    pub has_ui: bool,
    pub trust: trust::TrustEvaluation,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SidebarInfo {
    pub label: String,
    pub icon: String,
    pub order: i32,
}

/// Host-side Moke downloaded book entry exposed to the embedded reader.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MokeOfflineBookInfo {
    pub path: String,
    pub file_name: String,
    pub title: String,
    pub updated_at: u64,
}

// ---------------------------------------------------------------------------
// Manifest 内部表示（反序列化用）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub api_version: String,
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub publisher: Option<PublisherConfig>,
    #[serde(default)]
    pub entry: Option<EntryConfig>,
    #[serde(default)]
    pub sidebar: Option<SidebarConfig>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub lucide_icons: Vec<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherConfig {
    pub id: String,
    pub name: String,
    pub source: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntryConfig {
    #[serde(default)]
    pub ui_port: u16,
    #[serde(default)]
    pub backend: Option<BackendConfig>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackendConfig {
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SidebarConfig {
    pub label: String,
    pub icon: String,
    #[serde(default)]
    pub order: i32,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ExtensionApproval {
    package_digest: String,
}

fn start_extension_backend(
    state: &ExtensionRuntime,
    name: &str,
    manifest: &Manifest,
    token: &str,
) -> Result<(u16, Option<std::process::Child>), String> {
    let Some(entry) = &manifest.entry else {
        return Ok((0, None));
    };

    // 有 UI 入口但没有后端：分配一个端口供前端 iframe 使用
    let port_needed = entry.ui_port > 0 || entry.backend.is_some();
    if !port_needed {
        return Ok((0, None));
    }

    let Some(backend) = &entry.backend else {
        return Ok((lifecycle::allocate_port(&state.next_port, state.port_range_start), None));
    };

    let ext_dir = state.extensions_dir.join(name);
    let port = lifecycle::allocate_port(&state.next_port, state.port_range_start);
    lifecycle::start_backend(&ext_dir, backend, port, token, state.api_port, state.ws_port)
        .map(|child| (port, Some(child)))
        .map_err(|e| format!("无法启动拓展「{name}」后端: {e}"))
}

fn stop_extension_backend(ext: EnabledExtension) {
    if let Ok(mut backend) = ext.backend.lock() {
        if let Some(ref mut child) = *backend {
            let _ = child.kill();
            for _ in 0..20 {
                if child.try_wait().ok().flatten().is_some() { break; }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

/// 列出所有已安装的拓展。
#[tauri::command]
fn ext_list_extensions(state: tauri::State<'_, ExtensionRuntime>) -> Vec<ExtensionInfo> {
    // Package hashing can be slow for large extensions. Snapshot only the
    // fields needed by the UI so API token checks are not blocked on disk IO.
    let enabled: HashMap<String, u16> = state
        .enabled
        .lock()
        .unwrap()
        .iter()
        .map(|(name, extension)| (name.clone(), extension.port))
        .collect();
    let discoveries = discovery::discover_extensions(&state.extensions_dir);

    discoveries
        .into_iter()
        .map(|d| {
            let trust = trust::evaluate_installed(&state.extensions_dir, &d.dir, &d.manifest);
            let is_enabled = enabled.contains_key(&d.manifest.name);
            let has_backend = d
                .manifest
                .entry
                .as_ref()
                .and_then(|e| e.backend.as_ref())
                .is_some();
            // has_ui: 有 entry 就有 UI
            // - ui_port > 0: 拓展自己 serve 前端
            // - 声明了 backend: backend 可以 serve 前端（ui_port 可能为 0，表示自动分配）
            let has_ui = d.manifest.entry.as_ref().is_some_and(|e| e.ui_port > 0 || e.backend.is_some());

            let port = enabled.get(&d.manifest.name).copied().unwrap_or(0);

            ExtensionInfo {
                name: d.manifest.name,
                version: d.manifest.version,
                display_name: d.manifest.display_name,
                description: d.manifest.description,
                author: d.manifest.author,
                enabled: is_enabled,
                port,
                permissions: d.manifest.permissions,
                sidebar: d.manifest.sidebar.map(|s| SidebarInfo {
                    label: s.label,
                    icon: s.icon,
                    order: s.order,
                }),
                has_backend,
                has_ui,
                trust,
            }
        })
        .collect()
}

/// 启用一个拓展。
#[tauri::command]
fn ext_enable_extension(
    state: tauri::State<'_, ExtensionRuntime>,
    name: String,
    approval: Option<ExtensionApproval>,
) -> Result<(), String> {
    lifecycle::validate_extension_name(&name)?;

    {
        let enabled = state.enabled.lock().unwrap();
        if enabled.contains_key(&name) {
            return Err("拓展已启用".into());
        }
    }

    let manifest_path = state.extensions_dir.join(&name).join("manifest.json");
    if !manifest_path.exists() {
        return Err(format!("未找到拓展「{name}」的 manifest.json"));
    }

    let manifest = discovery::read_and_validate_manifest(&manifest_path)?;

    if manifest.name != name {
        return Err(format!(
            "manifest.json 中声明的名称「{}」与目录名「{name}」不一致",
            manifest.name
        ));
    }

    let ext_dir = state.extensions_dir.join(&name);
    trust::authorize_activation(
        &state.extensions_dir,
        &ext_dir,
        &manifest,
        approval.as_ref().map(|value| value.package_digest.as_str()),
    )?;

    let token = lifecycle::generate_token();
    let (port, backend_child) = start_extension_backend(&state, &name, &manifest, &token)?;

    {
        let mut enabled = state.enabled.lock().unwrap();
        enabled.insert(
            name.clone(),
            EnabledExtension {
                token: token.clone(),
                port,
                backend: Mutex::new(backend_child),
                permissions: manifest.permissions.clone(),
            },
        );
    }

    lifecycle::save_runtime_state(&state.extensions_dir, &state.enabled)?;

    log::info!("拓展「{name}」已启用，端口 {port}");
    Ok(())
}

/// 禁用一个拓展。
#[tauri::command]
fn ext_disable_extension(
    state: tauri::State<'_, ExtensionRuntime>,
    name: String,
) -> Result<(), String> {
    lifecycle::validate_extension_name(&name)?;

    // 先取出拓展信息，释放锁，再杀进程和持久化（防死锁）
    let ext = {
        let mut enabled = state.enabled.lock().unwrap();
        enabled
            .remove(&name)
            .ok_or_else(|| format!("拓展「{name}」未启用"))?
    };

    stop_extension_backend(ext);

    // 持久化（此时重新获取 enabled 锁，不会死锁因为不在锁内）
    lifecycle::save_runtime_state(&state.extensions_dir, &state.enabled)?;

    log::info!("拓展「{name}」已禁用");
    Ok(())
}

/// 卸载一个拓展。
///
/// 流程：先禁用拓展，再由宿主直接删除目录。卸载时绝不执行拓展目录内
/// 的 `uninstall.exe`，否则未受信任的安装内容可借卸载路径执行任意代码。
#[tauri::command]
fn ext_uninstall_extension(
    state: tauri::State<'_, ExtensionRuntime>,
    name: String,
) -> Result<(), String> {
    lifecycle::validate_extension_name(&name)?;

    // 1. 先禁用（杀进程 + 持久化）
    let ext = {
        let mut enabled = state.enabled.lock().unwrap();
        enabled.remove(&name)
    };

    if let Some(ext) = ext {
        stop_extension_backend(ext);
    }

    lifecycle::save_runtime_state(&state.extensions_dir, &state.enabled)?;
    log::info!("拓展「{name}」已禁用，开始卸载...");

    let ext_dir = state.extensions_dir.join(&name);
    if !ext_dir.exists() {
        return Err(format!("拓展目录不存在: {}", ext_dir.display()));
    }

    if ext_dir.exists() {
        std::fs::remove_dir_all(&ext_dir)
            .map_err(|e| format!("无法删除拓展目录「{}」: {e}", ext_dir.display()))?;
    }

    log::info!("拓展「{name}」已由宿主卸载");
    Ok(())
}

/// 返回 API Server 的 REST 端口。
#[tauri::command]
fn ext_get_api_port(state: tauri::State<'_, ExtensionRuntime>) -> u16 {
    state.api_port
}

/// 返回拓展根目录的路径。
#[tauri::command]
fn ext_get_extensions_dir(state: tauri::State<'_, ExtensionRuntime>) -> String {
    state.extensions_dir.to_string_lossy().to_string()
}

/// 诊断命令：返回当前拓展系统和阅读器的运行状态。
/// 前端调试面板可调用此命令排查问题。
#[tauri::command]
fn ext_diagnostics(
    state: tauri::State<'_, ExtensionRuntime>,
    app: AppHandle,
) -> serde_json::Value {
    let enabled: Vec<String> = state.enabled.lock().unwrap().keys().cloned().collect();
    let all_windows: Vec<String> = app.webview_windows().keys().cloned().collect();
    let reader_windows: Vec<String> = all_windows
        .iter()
        .filter(|l| api_server::is_reader_window_label(l))
        .cloned()
        .collect();

    serde_json::json!({
        "api_port": state.api_port,
        "ws_port": state.ws_port,
        "extensions_dir": state.extensions_dir.to_string_lossy(),
        "enabled_extensions": enabled,
        "all_windows": all_windows,
        "reader_windows": reader_windows,
    })
}

/// 阅读器前端调用：上报事件到拓展系统。
///
/// 事件同时通过 Tauri event 和 WS broadcast 发送给已订阅的拓展。
#[tauri::command]
fn ext_reader_event(
    state: tauri::State<'_, ExtensionRuntime>,
    app: AppHandle,
    source_window: tauri::WebviewWindow,
    event: String,
    mut data: serde_json::Value,
) -> Result<(), String> {
    // 同步命令回执使用宿主生成的 correlation_id。只有发出命令的目标窗口
    // 才能满足等待方；投递和广播前恢复拓展原始 request_id。
    if event == "command:result" {
        if let Some(correlation_id) = data
            .get("request_id")
            .and_then(|value| value.as_str())
            .map(str::to_string)
        {
            let receipt_match = state.pending_commands.lock().unwrap().deliver(
                &correlation_id,
                source_window.label(),
                data.clone(),
            );
            match receipt_match {
                api_server::ReceiptMatch::Active { request_id } => {
                    data["request_id"] = serde_json::Value::String(request_id);
                }
                api_server::ReceiptMatch::Late { request_id } => {
                    data["request_id"] = serde_json::Value::String(request_id);
                    data["late"] = serde_json::Value::Bool(true);
                }
                api_server::ReceiptMatch::SourceMismatch { target_window } => {
                    log::warn!(
                        "[ext] 忽略来自窗口「{}」的命令回执：目标窗口为「{}」",
                        source_window.label(),
                        target_window
                    );
                    return Ok(());
                }
                api_server::ReceiptMatch::Unknown
                    if api_server::is_internal_request_id(&correlation_id) =>
                {
                    log::warn!("[ext] 忽略未知的内部命令关联 ID");
                    if let Some(object) = data.as_object_mut() {
                        object.remove("request_id");
                    }
                }
                api_server::ReceiptMatch::Unknown => {}
            }
        }
    }

    // 通过 WS 广播给已连接的后端拓展（Tauri emit 和 WS broadcast 统一使用 reader: 前缀）
    let full_event = format!("reader:{}", event);
    let data_str = serde_json::to_string(&data).unwrap_or_default();
    if let Err(e) = state.ws_broadcast.send(events::WsBroadcast {
        event: full_event.clone(),
        data: data_str.clone(),
    }) {
        log::error!("[ext] WS 广播事件 {full_event} 失败: {e}");
    } else {
        log::debug!("[ext] 事件已发送: {full_event} data={data_str}");
    }

    // 同时通过 Tauri event 发送给前端监听器
    app.emit(&full_event, &data)
        .map_err(|e| format!("发送事件失败: {e}"))?;

    Ok(())
}

/// Return books downloaded by Moke into AppData/books.
///
/// Moke stores offline downloads under AppData/books, while the embedded
/// reader cannot read the host window IndexedDB directly. The host scans
/// that directory and returns path/file metadata for the reader list.
#[tauri::command]
fn ext_moke_list_offline_books(app: AppHandle) -> Result<Vec<MokeOfflineBookInfo>, String> {
    const BOOK_EXTENSIONS: [&str; 9] = [
        "epub", "mobi", "azw", "azw3", "fb2", "zip", "cbz", "pdf", "txt",
    ];

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    let books_dir = app_data_dir.join("books");
    if !books_dir.exists() {
        return Ok(Vec::new());
    }

    let entries = std::fs::read_dir(&books_dir)
        .map_err(|e| format!("failed to read Moke books dir: {e}"))?;
    let mut books = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        if file_name.starts_with('.') {
            continue;
        }

        let extension = path
            .extension()
            .map(|ext| ext.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if !BOOK_EXTENSIONS.contains(&extension.as_str()) {
            continue;
        }

        let title = path
            .file_stem()
            .map(|stem| stem.to_string_lossy().trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| file_name.clone());
        let updated_at = std::fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);

        books.push(MokeOfflineBookInfo {
            path: path.to_string_lossy().into_owned(),
            file_name,
            title,
            updated_at,
        });
    }

    books.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(books)
}

// ---------------------------------------------------------------------------
// 公开入口：初始化拓展系统
// ---------------------------------------------------------------------------

/// 常量
// Host transports use OS-assigned ports so a stale fixed endpoint is never a
// cross-session capability. Extension backends receive the actual values only
// through their sanitized process environment.
const API_SERVER_PORT: u16 = 0;
const WS_SERVER_PORT: u16 = 0;
const EXTENSION_PORT_START: u16 = 19557;

/// 创建 `ExtensionRuntime` 并注入到 Tauri app state。
/// 同时启动 API Server（REST + WebSocket）。
///
/// 启动顺序很重要：先启动 server 占用端口，再恢复拓展分配端口，避免冲突。
pub fn init(app: &AppHandle) {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .expect("无法获取 app data 目录");

    let extensions_dir = app_data_dir.join("extensions");

    if let Err(e) = std::fs::create_dir_all(&extensions_dir) {
        log::error!("无法创建拓展目录「{}」: {e}", extensions_dir.display());
    } else if let Err(e) = lifecycle::secure_extensions_directory(&extensions_dir) {
        log::warn!("{e}");
    }

    let enabled = Arc::new(Mutex::new(HashMap::new()));

    // 1. 先启动 WebSocket 服务器（先占端口），保留 sender 用于事件广播
    let (ws_port, ws_sender) = events::start(enabled.clone(), WS_SERVER_PORT);

    // 命令回执等待注册表：api_server 与 ext_reader_event 共享同一份 Arc
    let pending_commands = Arc::new(Mutex::new(api_server::PendingCommands::default()));

    // 2. 再启动 REST API Server（如果 WS 回退了端口，REST 继续往后试）
    let api_ctx = Arc::new(api_server::ServerContext {
        enabled: enabled.clone(),
        extensions_dir: extensions_dir.clone(),
        app_handle: app.clone(),
        pending_commands: pending_commands.clone(),
    });
    let api_port = api_server::start(api_ctx, API_SERVER_PORT);

    // 3. 拓展 UI/backend 端口仍使用兼容范围；随机宿主端口由操作系统
    // 独占，不会与随后启动的拓展后端重复绑定。
    let port_range_start = EXTENSION_PORT_START;

    // 4. 最后恢复上次的启用状态
    let next_port = Arc::new(AtomicU16::new(port_range_start));
    {
        let runtime_state = extensions_dir.clone();
        let enabled_clone = enabled.clone();
        let restored_ports = lifecycle::restore_runtime_state_inner(&runtime_state, &enabled_clone, api_port, ws_port);
        if let Some(max_port) = restored_ports.into_iter().max() {
            lifecycle::reserve_after_port(&next_port, max_port);
        }
        // Rewrite legacy runtime.json files immediately so persisted plaintext
        // tokens are removed even if the user never toggles an extension.
        if let Err(error) = lifecycle::save_runtime_state(&runtime_state, &enabled_clone) {
            log::warn!("迁移拓展运行时状态失败: {error}");
        }
    }

    {
        let enabled_for_exit = enabled.clone();
        app.listen("tauri://close-requested", move |_| {
            let exts: Vec<EnabledExtension> = {
                let mut enabled = enabled_for_exit.lock().unwrap();
                enabled.drain().map(|(_, ext)| ext).collect()
            };
            for ext in exts {
                stop_extension_backend(ext);
            }
        });
    }

    let runtime = ExtensionRuntime {
        enabled,
        next_port: next_port.clone(),
        extensions_dir: extensions_dir.clone(),
        api_port,
        ws_port,
        ws_broadcast: ws_sender,
        pending_commands,
        port_range_start,
    };

    app.manage(runtime);
    log::info!(
        "拓展系统已初始化，API: {}，WS: {}，拓展目录: {}",
        api_port,
        ws_port,
        extensions_dir.display()
    );
}

/// 返回所有 Tauri commands 的 handler。
pub fn invoke_handler(
) -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        ext_list_extensions,
        ext_enable_extension,
        ext_disable_extension,
        ext_uninstall_extension,
        ext_get_api_port,
        ext_get_extensions_dir,
        ext_reader_event,
        ext_moke_list_offline_books,
        ext_diagnostics,
    ]
}
