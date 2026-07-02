//! Moke 拓展系统 — 模块入口。
//!
//! 负责注册 Tauri commands、管理全局状态和启动 API 服务器。

mod api_server;
mod discovery;
mod events;
mod lifecycle;
mod permissions;
mod storage;

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
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SidebarInfo {
    pub label: String,
    pub icon: String,
    pub order: i32,
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
    let enabled = state.enabled.lock().unwrap();
    let discoveries = discovery::discover_extensions(&state.extensions_dir);

    discoveries
        .into_iter()
        .map(|d| {
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

            let port = enabled.get(&d.manifest.name).map(|e| e.port).unwrap_or(0);

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
            }
        })
        .collect()
}

/// 启用一个拓展。
#[tauri::command]
fn ext_enable_extension(
    state: tauri::State<'_, ExtensionRuntime>,
    name: String,
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
/// 流程：
/// 1. 先禁用拓展（关闭后端进程、持久化状态）
/// 2. 尝试运行拓展自带的 uninstall.exe（NSIS 卸载程序，清理注册表等）
/// 3. uninstall.exe 不存在或失败时，回退到直接删除目录
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

    // 2. 尝试运行 uninstall.exe（NSIS 生成的规范卸载程序）
    let ext_dir = state.extensions_dir.join(&name);
    if !ext_dir.exists() {
        return Err(format!("拓展目录不存在: {}", ext_dir.display()));
    }

    let uninstaller = ext_dir.join("uninstall.exe");
    if uninstaller.exists() {
        match run_uninstaller(&uninstaller) {
            Ok(true) => {
                log::info!("拓展「{name}」已通过 uninstall.exe 卸载");
                return Ok(());
            }
            Ok(false) => {
                log::warn!("uninstall.exe 已执行但目录仍存在，回退到强制删除");
            }
            Err(e) => {
                log::warn!("uninstall.exe 运行失败: {e}，回退到强制删除");
            }
        }
    } else {
        log::info!("拓展「{name}」未提供 uninstall.exe，使用强制删除");
    }

    // 3. 回退：强制删除
    if ext_dir.exists() {
        std::fs::remove_dir_all(&ext_dir)
            .map_err(|e| format!("无法删除拓展目录「{}」: {e}", ext_dir.display()))?;
    }

    log::info!("拓展「{name}」已卸载（强制删除）");
    Ok(())
}

/// 运行拓展自带的卸载程序。返回 Ok(true) 表示卸载后目录已消失，
/// Ok(false) 表示程序执行了但目录仍在，Err 表示启动失败。
fn run_uninstaller(uninstaller: &std::path::Path) -> Result<bool, String> {
    let mut cmd = std::process::Command::new(uninstaller);
    // 静默卸载参数（NSIS: /S = silent）
    cmd.arg("/S").arg("_?=").arg(
        uninstaller
            .parent()
            .unwrap_or(std::path::Path::new(".")),
    );

    // Windows: 隐藏窗口
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let start = std::time::Instant::now();
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 uninstall.exe: {e}"))?;

    // 等待最多 30 秒
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                log::info!(
                    "uninstall.exe 退出, 状态: {status}, 耗时: {:?}",
                    start.elapsed()
                );
                // 检查目录是否已删除
                let parent = uninstaller.parent().unwrap_or(std::path::Path::new("."));
                return Ok(!parent.exists());
            }
            Ok(None) => {
                if start.elapsed() > std::time::Duration::from_secs(30) {
                    let _ = child.kill();
                    return Err("uninstall.exe 超时（30 秒）".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("检查 uninstall.exe 状态失败: {e}"));
            }
        }
    }
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
        .filter(|l| l.starts_with("reader-"))
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
    event: String,
    data: serde_json::Value,
) -> Result<(), String> {
    // 通过 WS 广播给已连接的后端拓展（Tauri emit 和 WS broadcast 统一使用 reader: 前缀）
    let full_event = format!("reader:{}", event);
    let data_str = serde_json::to_string(&data).unwrap_or_default();
    let _ = state.ws_broadcast.send(events::WsBroadcast {
        event: full_event.clone(),
        data: data_str,
    });

    // 同时通过 Tauri event 发送给前端监听器
    app.emit(&full_event, &data)
        .map_err(|e| format!("发送事件失败: {e}"))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// 公开入口：初始化拓展系统
// ---------------------------------------------------------------------------

/// 常量
const API_SERVER_PORT: u16 = 19555;
const WS_SERVER_PORT: u16 = 19556;

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
    }

    let enabled = Arc::new(Mutex::new(HashMap::new()));

    // 1. 先启动 WebSocket 服务器（先占端口），保留 sender 用于事件广播
    let (ws_port, ws_sender) = events::start(enabled.clone(), WS_SERVER_PORT);

    // 2. 再启动 REST API Server（如果 WS 回退了端口，REST 继续往后试）
    let api_ctx = Arc::new(api_server::ServerContext {
        enabled: enabled.clone(),
        extensions_dir: extensions_dir.clone(),
        app_handle: app.clone(),
    });
    let api_port = api_server::start(api_ctx, API_SERVER_PORT);

    // 3. 拓展端口从 server 之后开始，避免冲突
    let port_range_start = u16::max(api_port, ws_port) + 1;

    // 4. 最后恢复上次的启用状态
    let next_port = Arc::new(AtomicU16::new(port_range_start));
    {
        let runtime_state = extensions_dir.clone();
        let enabled_clone = enabled.clone();
        let restored_ports = lifecycle::restore_runtime_state_inner(&runtime_state, &enabled_clone, api_port, ws_port);
        if let Some(max_port) = restored_ports.into_iter().max() {
            lifecycle::reserve_after_port(&next_port, max_port);
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
        ext_diagnostics,
    ]
}
