//! 拓展 REST API Server。
//!
//! 基于 `tiny_http` 提供 REST 接口，供拓展（外部进程）调用。
//! 监听 `127.0.0.1`（仅本地可达），通过 token 认证拓展身份。

use super::EnabledExtension;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use tauri::Manager;

// ---------------------------------------------------------------------------
// 共享上下文
// ---------------------------------------------------------------------------

/// API Server 线程持有的只读上下文。
pub struct ServerContext {
    pub enabled: Arc<Mutex<HashMap<String, EnabledExtension>>>,
    pub extensions_dir: std::path::PathBuf,
    pub app_handle: tauri::AppHandle,
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

/// 在独立线程中启动 REST API Server。
/// 如果首选端口被占用，自动尝试下一个端口（最多 10 次）。
pub fn start(ctx: Arc<ServerContext>, start_port: u16) -> u16 {
    let mut port = start_port;
    let server = loop {
        match tiny_http::Server::http(format!("127.0.0.1:{port}")) {
            Ok(s) => break s,
            Err(e) if port < start_port + 10 => {
                log::warn!("API Server 端口 {port} 被占用，尝试 {next}", next = port + 1);
                port += 1;
            }
            Err(e) => panic!("无法启动 API Server (尝试了 {start_port}-{port}): {e}"),
        }
    };

    let actual_port = server.server_addr().to_ip().unwrap().port();
    log::info!("拓展 API Server 已启动: http://127.0.0.1:{actual_port}");

    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let ctx = ctx.clone();
            std::thread::spawn(move || handle_request(request, ctx));
        }
    });

    actual_port
}

// ---------------------------------------------------------------------------
// 路由分发
// ---------------------------------------------------------------------------

fn handle_request(mut request: tiny_http::Request, ctx: Arc<ServerContext>) {
    // 先提取所有需要的数据（immutable borrows），然后读取 body（mutable borrow）
    let url = request.url().to_string();
    let method = request.method().clone();
    let ext_name = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("X-Extension-Name"))
        .map(|h| h.value.to_string());
    let ext_token = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("X-Extension-Token"))
        .map(|h| h.value.to_string());

    // 读取请求体（需要 mutable borrow，必须在所有 immutable borrow 结束之后）
    let body = {
        let mut s = String::new();
        let _ = request.as_reader().read_to_string(&mut s);
        s
    };

    // 添加 CORS header（仅对本地拓展，实际不限来源）
    let cors_header =
        tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap();

    // 处理 CORS 预检请求
    if method == tiny_http::Method::Options || url == "/" {
        // for CORS preflight & health check
        let response = tiny_http::Response::from_string("")
            .with_header(cors_header)
            .with_header(
                tiny_http::Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"X-Extension-Name, X-Extension-Token, Content-Type"[..])
                    .unwrap(),
            )
            .with_header(
                tiny_http::Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"GET, POST, PUT, DELETE, OPTIONS"[..])
                    .unwrap(),
            );
        let _ = request.respond(response);
        return;
    }

    // Token 认证
    if let Err(e) = authenticate(&ctx, ext_name.as_deref(), ext_token.as_deref()) {
        let response = tiny_http::Response::from_string(serde_json::json!({"error": e}).to_string())
            .with_status_code(401)
            .with_header(cors_header)
            .with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
            );
        let _ = request.respond(response);
        return;
    }

    let ext_name = ext_name.unwrap();

    // 路由
    let result = match (&method, url.as_str()) {
        // ---- 宿主信息 ----
        (tiny_http::Method::Get, "/api/v1/info") => handle_info(&ctx, &ext_name),

        // ---- 阅读器 ----
        (_, u) if u.starts_with("/api/v1/reader/") => {
            handle_reader(&ctx, &ext_name, &method, u)
        }

        // ---- 拓展自管理 ----
        (tiny_http::Method::Post, "/api/v1/extension/sidebar/add") => {
            handle_ext_sidebar_add(&ctx, &ext_name, &body)
        }
        (tiny_http::Method::Post, "/api/v1/extension/page/register") => {
            handle_ext_page_register(&ctx, &ext_name, &body)
        }
        (_, u) if u.starts_with("/api/v1/extension/storage/") => {
            handle_ext_storage(&ctx, &ext_name, &method, u)
        }

        // ---- 404 ----
        _ => Err("未找到".into()),
    };

    match result {
        Ok(body) => {
            let response = tiny_http::Response::from_string(body)
                .with_header(cors_header)
                .with_header(
                    tiny_http::Header::from_bytes(
                        &b"Content-Type"[..],
                        &b"application/json"[..],
                    )
                    .unwrap(),
                );
            let _ = request.respond(response);
        }
        Err(msg) => {
            let body = serde_json::json!({"error": msg}).to_string();
            let response = tiny_http::Response::from_string(body)
                .with_status_code(400)
                .with_header(cors_header)
                .with_header(
                    tiny_http::Header::from_bytes(
                        &b"Content-Type"[..],
                        &b"application/json"[..],
                    )
                    .unwrap(),
                );
            let _ = request.respond(response);
        }
    }
}

// ---------------------------------------------------------------------------
// 认证
// ---------------------------------------------------------------------------

fn authenticate(
    ctx: &ServerContext,
    ext_name: Option<&str>,
    ext_token: Option<&str>,
) -> Result<(), String> {
    let name = ext_name.ok_or("缺少 X-Extension-Name 头".to_string())?;
    let token = ext_token.ok_or("缺少 X-Extension-Token 头".to_string())?;

    let enabled = ctx.enabled.lock().unwrap();
    let ext = enabled
        .get(name)
        .ok_or_else(|| format!("拓展「{name}」未启用或不存在"))?;

    if ext.token != token {
        return Err("token 无效".into());
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// 路由实现
// ---------------------------------------------------------------------------

/// GET /api/v1/info
fn handle_info(ctx: &ServerContext, _ext_name: &str) -> Result<String, String> {
    let all_windows: Vec<String> = ctx
        .app_handle
        .webview_windows()
        .keys()
        .cloned()
        .collect();
    log::info!("/api/v1/info: all windows = {:?}", all_windows);

    let windows: Vec<String> = all_windows
        .into_iter()
        .filter(|l| l.starts_with("reader-"))
        .collect();

    let info = serde_json::json!({
        "host_version": env!("CARGO_PKG_VERSION"),
        "reader_windows": windows,
    });

    Ok(info.to_string())
}

/// /api/v1/reader/*
fn handle_reader(
    ctx: &ServerContext,
    _ext_name: &str,
    method: &tiny_http::Method,
    url: &str,
) -> Result<String, String> {
    // GET /api/v1/reader/windows
    if url == "/api/v1/reader/windows" && method == &tiny_http::Method::Get {
        let windows: Vec<String> = ctx
            .app_handle
            .webview_windows()
            .keys()
            .filter(|l| l.starts_with("reader-"))
            .cloned()
            .collect();
        return Ok(serde_json::json!({"windows": windows}).to_string());
    }

    // GET /api/v1/reader/{label}/state
    if let Some(label) = url.strip_prefix("/api/v1/reader/") {
        let label = label.strip_suffix("/state").unwrap_or(label);

        if method == &tiny_http::Method::Get && url.ends_with("/state") {
            // 返回阅读器基本状态（窗口存在性 + 标签）
            if let Some(_window) = ctx.app_handle.get_webview_window(label) {
                let state = serde_json::json!({
                    "window": label,
                    "status": "open",
                });
                return Ok(state.to_string());
            } else {
                return Ok(
                    serde_json::json!({"window": label, "status": "closed"}).to_string(),
                );
            }
        }

        // POST /api/v1/reader/{label}/command
        if method == &tiny_http::Method::Post && url.ends_with("/command") {
            let label = label.strip_suffix("/command").unwrap_or(label);
            if let Some(window) = ctx.app_handle.get_webview_window(label) {
                // 将命令作为 Tauri event 转发给阅读器窗口
                // 拓展发送: { "command": "jump_to_page", "page": 50 }
                // 我们转发为: reader:command 事件
                // 注：此处只是透传；阅读器前端需要监听此事件
                if let Err(e) = window.emit("reader:command", ()) {
                    return Err(format!("发送命令失败: {e}"));
                }
                return Ok(serde_json::json!({"sent": true}).to_string());
            } else {
                return Err(format!("阅读器窗口「{label}」不存在"));
            }
        }
    }

    Err("未知的阅读器 API 路径".into())
}

/// POST /api/v1/extension/sidebar/add
fn handle_ext_sidebar_add(
    ctx: &ServerContext,
    _ext_name: &str,
    body: &str,
) -> Result<String, String> {
    let data: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("JSON 解析失败: {e}"))?;

    // 转发为 Tauri event，前端 Sidebar 监听此事件动态添加
    ctx.app_handle
        .emit("ext:sidebar:add", &data)
        .map_err(|e| format!("发送事件失败: {e}"))?;

    Ok(serde_json::json!({"registered": true}).to_string())
}

/// POST /api/v1/extension/page/register
fn handle_ext_page_register(
    ctx: &ServerContext,
    _ext_name: &str,
    body: &str,
) -> Result<String, String> {
    let data: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("JSON 解析失败: {e}"))?;

    ctx.app_handle
        .emit("ext:page:register", &data)
        .map_err(|e| format!("发送事件失败: {e}"))?;

    Ok(serde_json::json!({"registered": true}).to_string())
}

/// /api/v1/extension/storage/{key}
fn handle_ext_storage(
    ctx: &ServerContext,
    ext_name: &str,
    method: &tiny_http::Method,
    url: &str,
) -> Result<String, String> {
    // 安全：只有允许 storage 权限的拓展才能访问
    super::permissions::check_permission(ext_name, "storage", &ctx.extensions_dir)?;

    let key = url
        .strip_prefix("/api/v1/extension/storage/")
        .unwrap_or("");
    if key.is_empty() {
        return Err("缺少 key".into());
    }

    let ext_dir = ctx.extensions_dir.join(ext_name);

    match method {
        &tiny_http::Method::Get => {
            let value = super::storage::get(&ext_dir, key)?;
            Ok(serde_json::json!({"key": key, "value": value}).to_string())
        }
        &tiny_http::Method::Put => {
            // 需要读取请求体获取 value
            // 简化：从 query string 读取
            Err("PUT 需要请求体，请查看 API 文档".into())
        }
        &tiny_http::Method::Delete => {
            super::storage::delete(&ext_dir, key)?;
            Ok(serde_json::json!({"deleted": true}).to_string())
        }
        _ => Err("不支持的方法".into()),
    }
}
