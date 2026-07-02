//! 拓展生命周期管理：启用/禁用/卸载、后端进程启停、状态持久化。

use super::{EnabledExtension, BackendConfig, Manifest};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/// 持久化运行时状态的文件名（位于 extensions_dir 下）。
const RUNTIME_STATE_FILE: &str = "runtime.json";

/// 端口范围
const PORT_MIN: u16 = 19557;
const PORT_MAX: u16 = 19657;

// ---------------------------------------------------------------------------
// 名称校验
// ---------------------------------------------------------------------------

pub fn validate_extension_name(name: &str) -> Result<(), String> {
    super::discovery::validate_name(name)
}

// ---------------------------------------------------------------------------
// Token 与端口
// ---------------------------------------------------------------------------

pub fn generate_token() -> String {
    format!("moke_ext_{}", Uuid::new_v4().as_simple())
}

pub fn allocate_port(next_port: &Arc<AtomicU16>, port_range_start: u16) -> u16 {
    let port = next_port.fetch_add(1, Ordering::SeqCst);
    if port > PORT_MAX {
        next_port.store(port_range_start + 1, Ordering::SeqCst);
        port_range_start
    } else {
        port
    }
}

pub fn reserve_after_port(next_port: &Arc<AtomicU16>, used_port: u16) {
    let next = used_port.saturating_add(1).clamp(PORT_MIN, PORT_MAX);
    let _ = next_port.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current| {
        if current <= used_port { Some(next) } else { None }
    });
}

// ---------------------------------------------------------------------------
// 后端进程管理
// ---------------------------------------------------------------------------

/// 启动拓展声明的后端进程。
///
/// 安全措施：
/// - 工作目录设为拓展自身目录
/// - 清除所有非必要环境变量（仅保留 SYSTEMROOT 和 PATH）
/// - 将 `{EXT_PORT}` 替换为实际分配的端口
/// - 可执行文件路径已由 discovery 模块校验过是纯文件名
pub fn start_backend(
    ext_dir: &Path,
    backend: &BackendConfig,
    port: u16,
    token: &str,
    api_port: u16,
    ws_port: u16,
) -> Result<std::process::Child, String> {
    let exe_path = ext_dir.join(&backend.executable);

    if !exe_path.exists() {
        return Err(format!(
            "后端可执行文件不存在: {}",
            exe_path.display()
        ));
    }

    // 构建参数，替换 {EXT_PORT} 占位符
    let args: Vec<String> = backend
        .args
        .iter()
        .map(|a| a.replace("{EXT_PORT}", &port.to_string()))
        .collect();

    // 构建最小化环境变量（防止拓展后端继承敏感环境变量）
    let mut cmd = std::process::Command::new(&exe_path);
    cmd.args(&args)
        .current_dir(ext_dir)
        .env_clear()
        // 最基本的 Windows 运行环境
        .env("SYSTEMROOT", std::env::var("SYSTEMROOT").unwrap_or_else(|_| "C:\\Windows".into()))
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        // 传递 token 和宿主服务端口，拓展后端可通过环境变量获取
        .env("MOKE_EXT_TOKEN", token)
        .env("MOKE_API_PORT", api_port.to_string())
        .env("MOKE_WS_PORT", ws_port.to_string());

    // Windows: 隐藏后端进程窗口
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动后端进程「{}」: {e}", exe_path.display()))?;

    std::thread::sleep(std::time::Duration::from_millis(150));
    if let Some(status) = child
        .try_wait()
        .map_err(|e| format!("检查后端进程状态失败「{}」: {e}", exe_path.display()))?
    {
        return Err(format!(
            "后端进程启动后立即退出「{}」(状态: {status})",
            exe_path.display()
        ));
    }

    log::info!(
        "启动拓展后端: {} (PID: {})",
        exe_path.display(),
        child.id()
    );

    Ok(child)
}

// ---------------------------------------------------------------------------
// 状态持久化
// ---------------------------------------------------------------------------

/// 持久化运行时状态的 JSON 结构。
#[derive(serde::Serialize, serde::Deserialize)]
struct RuntimeStateFile {
    enabled: HashMap<String, PersistedExtension>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct PersistedExtension {
    token: String,
    port: u16,
}

/// 将当前已启用的拓展状态写入文件。
pub fn save_runtime_state(
    extensions_dir: &Path,
    enabled_map: &Arc<Mutex<HashMap<String, EnabledExtension>>>,
) -> Result<(), String> {
    let enabled = enabled_map.lock().unwrap();

    let persisted: HashMap<String, PersistedExtension> = enabled
        .iter()
        .map(|(name, ext)| {
            (
                name.clone(),
                PersistedExtension {
                    token: ext.token.clone(),
                    port: ext.port,
                },
            )
        })
        .collect();

    let state = RuntimeStateFile {
        enabled: persisted,
    };

    let json = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("序列化运行时状态失败: {e}"))?;

    let path = extensions_dir.join(RUNTIME_STATE_FILE);

    // 先写临时文件，再原子替换（防写入过程中断电导致文件损坏）
    let tmp_path = extensions_dir.join("runtime.tmp");
    std::fs::write(&tmp_path, &json)
        .map_err(|e| format!("写入临时状态文件失败: {e}"))?;
    std::fs::rename(&tmp_path, &path)
        .map_err(|e| format!("替换状态文件失败: {e}"))?;

    Ok(())
}

/// 从持久化文件恢复运行时状态（用于初始化）。
pub fn restore_runtime_state_inner(
    extensions_dir: &Path,
    enabled_map: &Arc<Mutex<HashMap<String, EnabledExtension>>>,
    api_port: u16,
    ws_port: u16,
) -> Vec<u16> {
    let mut restored_ports = Vec::new();
    let path = extensions_dir.join(RUNTIME_STATE_FILE);
    if !path.exists() {
        return restored_ports;
    }

    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(e) => {
            log::warn!("无法读取运行时状态文件: {e}");
            return restored_ports;
        }
    };

    let state: RuntimeStateFile = match serde_json::from_str(&raw) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("运行时状态文件解析失败: {e}");
            let _ = std::fs::remove_file(&path);
            return restored_ports;
        }
    };

    let mut enabled = enabled_map.lock().unwrap();

    for (name, persisted) in state.enabled {
        let manifest_path = extensions_dir.join(&name).join("manifest.json");

        if !manifest_path.exists() {
            log::warn!("拓展「{name}」已不存在，跳过恢复");
            continue;
        }

        let manifest: Manifest = match std::fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
        {
            Some(m) => m,
            None => {
                log::warn!("拓展「{name}」的 manifest.json 无法解析，跳过恢复");
                continue;
            }
        };

        let backend_child = if let Some(entry) = &manifest.entry {
            if let Some(backend) = &entry.backend {
                let ext_dir = extensions_dir.join(&name);
                match start_backend(&ext_dir, backend, persisted.port, &persisted.token, api_port, ws_port) {
                    Ok(child) => Some(child),
                    Err(e) => {
                        log::warn!("恢复拓展「{name}」后端失败: {e}");
                        None
                    }
                }
            } else {
                None
            }
        } else {
            None
        };

        if persisted.port > 0 {
            restored_ports.push(persisted.port);
        }

        enabled.insert(
            name.clone(),
            EnabledExtension {
                token: persisted.token,
                port: persisted.port,
                backend: Mutex::new(backend_child),
            },
        );

        log::info!("已恢复拓展「{name}」, 端口 {}", persisted.port);
    }

    restored_ports
}
