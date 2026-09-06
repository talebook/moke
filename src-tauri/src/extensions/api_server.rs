//! 拓展 REST API Server。
//!
//! 使用有连接并发上限、绝对读取截止时间的回环传输提供 REST 接口。
//! 监听 `127.0.0.1`（仅本地可达），通过 token 认证拓展身份。

use super::security::ValidatedOrigin;
use super::EnabledExtension;
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tauri::Manager;

/// 同步等待阅读器命令回执的最大时长。
pub(crate) const MAX_COMMAND_WAIT_MS: u64 = 30_000;
/// 同时阻塞等待阅读器命令回执的请求上限，避免耗尽 API 请求线程。
pub(crate) const MAX_CONCURRENT_COMMAND_WAITS: usize = 32;
/// Maximum number of HTTP handlers, including handlers waiting for reader receipts.
pub(crate) const MAX_CONCURRENT_REQUESTS: usize = 48;
/// Requests larger than this are rejected before their bodies are read.
pub(crate) const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;
const RETIRED_COMMAND_TTL: Duration = Duration::from_secs(60);
const INTERNAL_REQUEST_ID_PREFIX: &str = "moke-pending:";

type ApiResult = Result<String, ApiError>;

#[derive(Debug)]
struct ApiError {
    status: u16,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: 400,
            code,
            message: message.into(),
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: 401,
            code: "AUTH_FAILED",
            message: message.into(),
        }
    }

    fn forbidden(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: 403,
            code,
            message: message.into(),
        }
    }

    fn request_timeout(message: impl Into<String>) -> Self {
        Self {
            status: 408,
            code: "REQUEST_TIMEOUT",
            message: message.into(),
        }
    }

    fn payload_too_large() -> Self {
        Self {
            status: 413,
            code: "PAYLOAD_TOO_LARGE",
            message: format!("请求体不能超过 {MAX_REQUEST_BODY_BYTES} 字节"),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: 404,
            code: "NOT_FOUND",
            message: message.into(),
        }
    }

    fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: 409,
            code,
            message: message.into(),
        }
    }

    fn too_many_requests(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: 429,
            code,
            message: message.into(),
        }
    }

    fn internal_error(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: 500,
            code,
            message: message.into(),
        }
    }
}

impl From<String> for ApiError {
    fn from(message: String) -> Self {
        // String errors propagated from storage, permissions and Tauri are
        // host failures by default. Client validation must choose an explicit
        // 4xx constructor at the boundary where its semantics are known.
        Self::internal_error("INTERNAL_ERROR", message)
    }
}

impl From<&str> for ApiError {
    fn from(message: &str) -> Self {
        Self::internal_error("INTERNAL_ERROR", message)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct PendingCommandKey {
    extension_name: String,
    target_window: String,
    request_id: String,
}

struct PendingCommand {
    key: PendingCommandKey,
    sender: Sender<serde_json::Value>,
}

struct RetiredCommand {
    key: PendingCommandKey,
    expires_at: Instant,
}

/// 同步命令等待表。
///
/// 外部 request_id 只用于同一拓展、同一窗口内的重复检测。发给阅读器的是每次
/// 调用独有的 correlation_id，因此超时后的旧回执不会命中新一轮同名请求。
#[derive(Default)]
pub(crate) struct PendingCommands {
    active_by_correlation: HashMap<String, PendingCommand>,
    correlation_by_key: HashMap<PendingCommandKey, String>,
    retired_by_correlation: HashMap<String, RetiredCommand>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ReceiptMatch {
    Active { request_id: String },
    Late { request_id: String },
    SourceMismatch { target_window: String },
    Unknown,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RegisterPendingCommandError {
    Duplicate,
    AtCapacity,
}

impl PendingCommands {
    pub(crate) fn register(
        &mut self,
        key: PendingCommandKey,
        sender: Sender<serde_json::Value>,
    ) -> Result<String, RegisterPendingCommandError> {
        self.remove_expired();
        if self.correlation_by_key.contains_key(&key) {
            return Err(RegisterPendingCommandError::Duplicate);
        }
        if self.active_by_correlation.len() >= MAX_CONCURRENT_COMMAND_WAITS {
            return Err(RegisterPendingCommandError::AtCapacity);
        }

        let correlation_id = format!("{INTERNAL_REQUEST_ID_PREFIX}{}", uuid::Uuid::new_v4());
        self.correlation_by_key
            .insert(key.clone(), correlation_id.clone());
        self.active_by_correlation
            .insert(correlation_id.clone(), PendingCommand { key, sender });
        Ok(correlation_id)
    }

    pub(crate) fn cancel(&mut self, correlation_id: &str) {
        if let Some(command) = self.active_by_correlation.remove(correlation_id) {
            self.remove_key_if_current(&command.key, correlation_id);
        }
    }

    /// Atomically claim timeout ownership for an active command.
    ///
    /// `true` means the timeout won and the command was retired. `false`
    /// means a delivery already removed the command and sent its result while
    /// holding the same registry lock.
    pub(crate) fn retire(&mut self, correlation_id: &str) -> bool {
        if let Some(command) = self.active_by_correlation.remove(correlation_id) {
            self.remove_key_if_current(&command.key, correlation_id);
            self.retired_by_correlation.insert(
                correlation_id.to_string(),
                RetiredCommand {
                    key: command.key,
                    expires_at: Instant::now() + RETIRED_COMMAND_TTL,
                },
            );
            return true;
        }
        false
    }

    pub(crate) fn deliver(
        &mut self,
        correlation_id: &str,
        source_window: &str,
        data: serde_json::Value,
    ) -> ReceiptMatch {
        self.remove_expired();

        if let Some(command) = self.active_by_correlation.get(correlation_id) {
            if command.key.target_window != source_window {
                return ReceiptMatch::SourceMismatch {
                    target_window: command.key.target_window.clone(),
                };
            }
        }
        if let Some(command) = self.active_by_correlation.remove(correlation_id) {
            self.remove_key_if_current(&command.key, correlation_id);
            let request_id = command.key.request_id.clone();
            let _ = command.sender.send(data);
            return ReceiptMatch::Active { request_id };
        }

        if let Some(command) = self.retired_by_correlation.get(correlation_id) {
            if command.key.target_window != source_window {
                return ReceiptMatch::SourceMismatch {
                    target_window: command.key.target_window.clone(),
                };
            }
        }
        if let Some(command) = self.retired_by_correlation.remove(correlation_id) {
            return ReceiptMatch::Late {
                request_id: command.key.request_id,
            };
        }

        ReceiptMatch::Unknown
    }

    fn remove_key_if_current(&mut self, key: &PendingCommandKey, correlation_id: &str) {
        if self.correlation_by_key.get(key).map(String::as_str) == Some(correlation_id) {
            self.correlation_by_key.remove(key);
        }
    }

    fn remove_expired(&mut self) {
        let now = Instant::now();
        self.retired_by_correlation
            .retain(|_, command| command.expires_at > now);
    }
}

pub(crate) fn is_internal_request_id(request_id: &str) -> bool {
    request_id.starts_with(INTERNAL_REQUEST_ID_PREFIX)
}

// ---------------------------------------------------------------------------
// 运行时形态
// ---------------------------------------------------------------------------

/// 当前是否为单 WebView 运行时（OHOS / Android / iOS）。
/// 与前端 `src/lib/moke-reader.ts` 的 `isSingleWebviewRuntime` 保持一致：
/// 这些平台上阅读器运行在唯一 WebView（label 为 `main`）里，而不是独立的
/// `reader-*` 窗口，扩展必须能把 `main` 当作阅读器寻址。
pub(crate) fn is_single_webview_runtime() -> bool {
    #[cfg(target_env = "ohos")]
    {
        return true;
    }
    #[cfg(not(target_env = "ohos"))]
    {
        matches!(std::env::consts::OS, "android" | "ios")
    }
}

/// 判断一个窗口 label 是否代表阅读器窗口。
/// - 桌面多窗口形态：`reader-*` 前缀（含独立阅读器窗口）；
/// - 单 WebView 形态：`main` 窗口即阅读器宿主。
pub(crate) fn is_reader_window_label(label: &str) -> bool {
    label.starts_with("reader-") || (is_single_webview_runtime() && label == "main")
}

// ---------------------------------------------------------------------------
// 共享上下文
// ---------------------------------------------------------------------------

/// API Server 线程持有的只读上下文。
pub struct ServerContext {
    pub operations: Arc<Mutex<()>>,
    pub enabled: Arc<Mutex<HashMap<String, EnabledExtension>>>,
    pub extensions_dir: std::path::PathBuf,
    pub app_handle: tauri::AppHandle,
    /// 阻塞等待命令回执的注册表，按拓展、目标窗口、request_id 隔离，
    /// 并通过每次调用独有的 correlation_id 匹配阅读器回执。
    pub pending_commands: Arc<Mutex<PendingCommands>>,
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

#[derive(Default)]
struct RequestLimiter {
    active: AtomicUsize,
}

struct RequestPermit {
    limiter: Arc<RequestLimiter>,
}

impl RequestLimiter {
    fn try_acquire(self: &Arc<Self>) -> Option<RequestPermit> {
        let mut active = self.active.load(Ordering::Acquire);
        loop {
            if active >= MAX_CONCURRENT_REQUESTS {
                return None;
            }
            match self.active.compare_exchange_weak(
                active,
                active + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    return Some(RequestPermit {
                        limiter: self.clone(),
                    })
                }
                Err(current) => active = current,
            }
        }
    }
}

impl Drop for RequestPermit {
    fn drop(&mut self) {
        self.limiter.active.fetch_sub(1, Ordering::AcqRel);
    }
}

fn dispatch_connection(
    stream: std::net::TcpStream,
    limiter: &Arc<RequestLimiter>,
    handler: impl FnOnce(std::net::TcpStream) + Send + 'static,
) -> Option<std::thread::JoinHandle<()>> {
    // Acquire before parsing any bytes or creating a worker.
    let Some(permit) = limiter.try_acquire() else {
        let _ = stream.shutdown(std::net::Shutdown::Both);
        return None;
    };
    Some(std::thread::spawn(move || {
        let _permit = permit;
        handler(stream);
    }))
}

/// 在独立线程中启动 REST API Server。`start_port == 0` 让操作系统为本次
/// Moke 会话分配随机回环端口；非零值仅用于兼容测试和诊断。
pub fn start(ctx: Arc<ServerContext>, start_port: u16) -> u16 {
    let listener = std::net::TcpListener::bind(("127.0.0.1", start_port))
        .unwrap_or_else(|e| panic!("无法启动 API Server: {e}"));
    let actual_port = listener.local_addr().unwrap().port();
    let limiter = Arc::new(RequestLimiter::default());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let ctx = ctx.clone();
            dispatch_connection(stream, &limiter, move |stream| {
                match super::transport::Request::read_headers(stream) {
                    Ok(request) => handle_request(request, ctx, actual_port),
                    Err((stream, status)) => super::transport::reject(stream, status),
                }
            });
        }
    });

    actual_port
}

// ---------------------------------------------------------------------------
// 路由分发
// ---------------------------------------------------------------------------

fn header(name: &str, value: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

fn single_header(
    request: &super::transport::Request,
    name: &str,
) -> Result<Option<String>, ApiError> {
    let values: Vec<String> = request
        .headers()
        .iter()
        .filter(|item| item.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|item| item.value.to_string())
        .collect();
    match values.as_slice() {
        [] => Ok(None),
        [value] => Ok(Some(value.clone())),
        _ => Err(ApiError::bad_request(
            "DUPLICATE_HEADER",
            format!("请求头 {name} 不能重复"),
        )),
    }
}

fn with_security_headers(
    mut response: tiny_http::Response<std::io::Cursor<Vec<u8>>>,
    cors_origin: Option<&str>,
) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    response.add_header(header("Content-Type", "application/json; charset=utf-8"));
    response.add_header(header("X-Content-Type-Options", "nosniff"));
    response.add_header(header("Cache-Control", "no-store"));
    if let Some(origin) = cors_origin {
        response.add_header(header("Access-Control-Allow-Origin", origin));
        response.add_header(header("Vary", "Origin"));
    }
    response
}

fn respond_json(
    request: super::transport::Request,
    status: u16,
    body: String,
    cors_origin: Option<&str>,
) {
    let response = with_security_headers(
        tiny_http::Response::from_string(body).with_status_code(status),
        cors_origin,
    );
    let _ = request.respond(response);
}

fn respond_error(request: super::transport::Request, error: ApiError, cors_origin: Option<&str>) {
    let body = serde_json::json!({
        "code": error.code,
        "error": error.message,
    })
    .to_string();
    respond_json(request, error.status, body, cors_origin);
}

fn validate_requested_headers(value: Option<&str>) -> Result<(), ApiError> {
    const ALLOWED: [&str; 3] = ["content-type", "x-extension-name", "x-extension-token"];
    if let Some(value) = value {
        for requested in value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if !ALLOWED
                .iter()
                .any(|allowed| requested.eq_ignore_ascii_case(allowed))
            {
                return Err(ApiError::forbidden(
                    "CORS_HEADER_FORBIDDEN",
                    format!("预检请求头「{requested}」不被允许"),
                ));
            }
        }
    }
    Ok(())
}

fn validate_preflight(
    request: &super::transport::Request,
    ctx: &ServerContext,
    actual_port: u16,
) -> Result<String, ApiError> {
    let host = single_header(request, "Host")?;
    if !super::security::validate_host(host.as_deref(), actual_port) {
        return Err(ApiError::forbidden(
            "INVALID_HOST",
            "Host 必须是当前回环监听地址",
        ));
    }

    let origin = single_header(request, "Origin")?;
    let validated = {
        let enabled = ctx.enabled.lock().unwrap();
        super::security::validate_origin(origin.as_deref(), &enabled)
    }
    .map_err(|message| ApiError::forbidden("INVALID_ORIGIN", message))?;
    let ValidatedOrigin::Extension { value, .. } = validated else {
        return Err(ApiError::forbidden(
            "INVALID_ORIGIN",
            "浏览器预检请求必须携带受信拓展 Origin",
        ));
    };

    let requested_method =
        single_header(request, "Access-Control-Request-Method")?.ok_or_else(|| {
            ApiError::bad_request("INVALID_PREFLIGHT", "缺少 Access-Control-Request-Method 头")
        })?;
    if !["GET", "POST", "PUT", "DELETE"]
        .iter()
        .any(|allowed| requested_method.eq_ignore_ascii_case(allowed))
    {
        return Err(ApiError::forbidden(
            "CORS_METHOD_FORBIDDEN",
            "预检请求方法不被允许",
        ));
    }
    let requested_headers = single_header(request, "Access-Control-Request-Headers")?;
    validate_requested_headers(requested_headers.as_deref())?;
    Ok(value)
}

fn validate_body_length(request: &super::transport::Request) -> Result<(), ApiError> {
    if request
        .body_length()
        .is_some_and(|length| length > MAX_REQUEST_BODY_BYTES)
    {
        Err(ApiError::payload_too_large())
    } else {
        Ok(())
    }
}

fn read_request_body(request: &mut super::transport::Request) -> Result<String, ApiError> {
    validate_body_length(request)?;

    let mut bytes = Vec::new();
    request
        .as_reader()
        .take((MAX_REQUEST_BODY_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
                ApiError::request_timeout("读取请求体超时")
            }
            _ => ApiError::bad_request("BODY_READ_FAILED", error.to_string()),
        })?;
    if bytes.len() > MAX_REQUEST_BODY_BYTES {
        return Err(ApiError::payload_too_large());
    }
    String::from_utf8(bytes)
        .map_err(|_| ApiError::bad_request("INVALID_BODY_ENCODING", "请求体必须是 UTF-8"))
}

fn handle_request(
    mut request: super::transport::Request,
    ctx: Arc<ServerContext>,
    actual_port: u16,
) {
    let url = request.url().to_string();
    let method = request.method().clone();

    if method == tiny_http::Method::Options {
        match validate_preflight(&request, &ctx, actual_port) {
            Ok(origin) => {
                let mut response = with_security_headers(
                    tiny_http::Response::from_string("").with_status_code(204),
                    Some(&origin),
                );
                response.add_header(header(
                    "Access-Control-Allow-Headers",
                    "X-Extension-Name, X-Extension-Token, Content-Type",
                ));
                response.add_header(header(
                    "Access-Control-Allow-Methods",
                    "GET, POST, PUT, DELETE",
                ));
                response.add_header(header("Access-Control-Max-Age", "600"));
                let _ = request.respond(response);
            }
            Err(error) => respond_error(request, error, None),
        }
        return;
    }

    // Host, Origin and token checks deliberately happen before any body read.
    let host = match single_header(&request, "Host") {
        Ok(value) => value,
        Err(error) => {
            respond_error(request, error, None);
            return;
        }
    };
    if !super::security::validate_host(host.as_deref(), actual_port) {
        respond_error(
            request,
            ApiError::forbidden("INVALID_HOST", "Host 必须是当前回环监听地址"),
            None,
        );
        return;
    }

    let origin = match single_header(&request, "Origin") {
        Ok(value) => value,
        Err(error) => {
            respond_error(request, error, None);
            return;
        }
    };
    let validated_origin = {
        let enabled = ctx.enabled.lock().unwrap();
        super::security::validate_origin(origin.as_deref(), &enabled)
    };
    let validated_origin = match validated_origin {
        Ok(value) => value,
        Err(message) => {
            respond_error(
                request,
                ApiError::forbidden("INVALID_ORIGIN", message),
                None,
            );
            return;
        }
    };
    let cors_origin = match &validated_origin {
        ValidatedOrigin::Backend => None,
        ValidatedOrigin::Extension { value, .. } => Some(value.clone()),
    };

    // A declared oversized body is rejected before authentication and without
    // touching the body stream. This also prevents attackers from using auth
    // failures to tie up workers with large uploads.
    if let Err(error) = validate_body_length(&request) {
        respond_error(request, error, cors_origin.as_deref());
        return;
    }

    let ext_name = match single_header(&request, "X-Extension-Name") {
        Ok(value) => value,
        Err(error) => {
            respond_error(request, error, cors_origin.as_deref());
            return;
        }
    };
    if let ValidatedOrigin::Extension { name, .. } = &validated_origin {
        if ext_name.as_deref() != Some(name.as_str()) {
            respond_error(
                request,
                ApiError::forbidden("ORIGIN_EXTENSION_MISMATCH", "Origin 与拓展身份不匹配"),
                cors_origin.as_deref(),
            );
            return;
        }
    }
    let ext_token = match single_header(&request, "X-Extension-Token") {
        Ok(value) => value,
        Err(error) => {
            respond_error(request, error, cors_origin.as_deref());
            return;
        }
    };
    if let Err(error) = authenticate(&ctx, ext_name.as_deref(), ext_token.as_deref()) {
        respond_error(request, error, cors_origin.as_deref());
        return;
    }
    let ext_name = ext_name.unwrap();

    let body = match read_request_body(&mut request) {
        Ok(body) => body,
        Err(error) => {
            respond_error(request, error, cors_origin.as_deref());
            return;
        }
    };

    // Keep storage/permissions in step with installation and token revocation.
    // Reader waits do not hold the filesystem operation lock.
    let _operation = if url.starts_with("/api/v1/extension/storage") {
        Some(ctx.operations.lock().unwrap())
    } else {
        None
    };
    if let Err(error) = authenticate(&ctx, Some(&ext_name), ext_token.as_deref()) {
        respond_error(request, error, cors_origin.as_deref());
        return;
    }
    let result = match (&method, url.as_str()) {
        (tiny_http::Method::Get, "/api/v1/info") => handle_info(&ctx, &ext_name),
        (_, path) if path.starts_with("/api/v1/reader/") => {
            handle_reader(&ctx, &ext_name, &method, path, &body)
        }
        (tiny_http::Method::Get, "/api/v1/extension/storage") => {
            handle_ext_storage_list(&ctx, &ext_name)
        }
        (tiny_http::Method::Post, "/api/v1/extension/sidebar/add") => {
            handle_ext_sidebar_add(&ctx, &ext_name, &body)
        }
        (tiny_http::Method::Post, "/api/v1/extension/page/register") => {
            handle_ext_page_register(&ctx, &ext_name, &body)
        }
        (_, path) if path.starts_with("/api/v1/extension/storage/") => {
            handle_ext_storage(&ctx, &ext_name, &method, path, &body)
        }
        _ => Err(ApiError::not_found("未找到")),
    };

    match result {
        Ok(body) => respond_json(request, 200, body, cors_origin.as_deref()),
        Err(error) => respond_error(request, error, cors_origin.as_deref()),
    }
}

// ---------------------------------------------------------------------------
// 认证
// ---------------------------------------------------------------------------

fn authenticate(
    ctx: &ServerContext,
    ext_name: Option<&str>,
    ext_token: Option<&str>,
) -> Result<(), ApiError> {
    let name = ext_name.ok_or_else(|| ApiError::unauthorized("缺少 X-Extension-Name 头"))?;
    let token = ext_token.ok_or_else(|| ApiError::unauthorized("缺少 X-Extension-Token 头"))?;

    let enabled = ctx.enabled.lock().unwrap();
    let ext = enabled
        .get(name)
        .ok_or_else(|| ApiError::unauthorized(format!("拓展「{name}」未启用或不存在")))?;

    if !super::security::token_matches(&ext.token, token) {
        return Err(ApiError::unauthorized("token 无效"));
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// 路由实现
// ---------------------------------------------------------------------------

/// GET /api/v1/info
fn handle_info(ctx: &ServerContext, _ext_name: &str) -> ApiResult {
    super::permissions::check_permission(&ctx.enabled, _ext_name, "server.info").map_err(
        |message| {
            ApiError::forbidden(
                "PERMISSION_REQUIRED",
                format!("{message}；请作者更新 manifest 权限并重新打包导入"),
            )
        },
    )?;
    let all_windows: Vec<String> = ctx.app_handle.webview_windows().keys().cloned().collect();
    log::info!("/api/v1/info: all windows = {:?}", all_windows);

    let windows: Vec<String> = all_windows
        .into_iter()
        .filter(|l| is_reader_window_label(l))
        .collect();

    let info = serde_json::json!({
        "host_version": env!("CARGO_PKG_VERSION"),
        "reader_windows": windows,
        "runtime": if is_single_webview_runtime() { "single_webview" } else { "multi_window" },
    });

    Ok(info.to_string())
}

fn parse_command_wait(payload: &serde_json::Value) -> Result<(Option<String>, u64), ApiError> {
    let wait_ms = match payload.get("wait_ms") {
        Some(value) => value
            .as_u64()
            .ok_or_else(|| ApiError::bad_request("INVALID_WAIT_MS", "wait_ms 必须是非负整数"))?,
        None => 0,
    };

    let request_id = match payload.get("request_id") {
        Some(serde_json::Value::String(value)) if !value.trim().is_empty() => {
            Some(value.trim().to_string())
        }
        Some(serde_json::Value::Null) | None => None,
        Some(_) if wait_ms == 0 => None,
        Some(_) => {
            return Err(ApiError::bad_request(
                "INVALID_REQUEST_ID",
                "request_id 必须是非空字符串",
            ))
        }
    };

    if wait_ms > MAX_COMMAND_WAIT_MS {
        return Err(ApiError::bad_request(
            "WAIT_MS_TOO_LARGE",
            format!("wait_ms 不能超过 {MAX_COMMAND_WAIT_MS} 毫秒"),
        ));
    }
    if wait_ms > 0 && request_id.is_none() {
        return Err(ApiError::bad_request(
            "MISSING_REQUEST_ID",
            "wait_ms 大于 0 时必须提供非空 request_id",
        ));
    }

    Ok((request_id, wait_ms))
}

fn pending_command_registration_error(
    error: RegisterPendingCommandError,
    extension_name: &str,
    target_window: &str,
    request_id: &str,
) -> ApiError {
    match error {
        RegisterPendingCommandError::Duplicate => ApiError::conflict(
            "DUPLICATE_REQUEST_ID",
            format!(
                "拓展「{extension_name}」已有 request_id「{request_id}」等待窗口「{target_window}」回执"
            ),
        ),
        RegisterPendingCommandError::AtCapacity => ApiError::too_many_requests(
            "TOO_MANY_PENDING_COMMANDS",
            format!("同步等待请求已达上限（{MAX_CONCURRENT_COMMAND_WAITS}）"),
        ),
    }
}

fn build_command_result_response(request_id: &str, receipt: &serde_json::Value) -> String {
    match receipt.get("success").and_then(serde_json::Value::as_bool) {
        Some(true) => serde_json::json!({
            "sent": true,
            "request_id": request_id,
            "success": true,
            "result": receipt.get("result").cloned().unwrap_or(serde_json::Value::Null),
        })
        .to_string(),
        Some(false) => serde_json::json!({
            "sent": true,
            "request_id": request_id,
            "success": false,
            "error": receipt
                .get("error")
                .cloned()
                .unwrap_or_else(|| serde_json::Value::String("阅读器命令执行失败".into())),
        })
        .to_string(),
        None => serde_json::json!({
            "sent": true,
            "request_id": request_id,
            "success": false,
            "error": "阅读器返回了无效的命令回执",
            "result": receipt,
        })
        .to_string(),
    }
}

/// /api/v1/reader/*
fn handle_reader(
    ctx: &ServerContext,
    ext_name: &str,
    method: &tiny_http::Method,
    url: &str,
    body: &str,
) -> ApiResult {
    // GET /api/v1/reader/windows
    if url == "/api/v1/reader/windows" && method == &tiny_http::Method::Get {
        super::permissions::check_permission(&ctx.enabled, ext_name, "reader.state.read").map_err(
            |message| {
                ApiError::forbidden(
                    "PERMISSION_REQUIRED",
                    format!("{message}；请作者更新 manifest 权限并重新打包导入"),
                )
            },
        )?;
        let windows: Vec<String> = ctx
            .app_handle
            .webview_windows()
            .keys()
            .filter(|l| is_reader_window_label(l))
            .cloned()
            .collect();
        return Ok(serde_json::json!({"windows": windows}).to_string());
    }

    // GET /api/v1/reader/{label}/state
    if let Some(label) = url.strip_prefix("/api/v1/reader/") {
        let label = label.strip_suffix("/state").unwrap_or(label);

        if method == &tiny_http::Method::Get && url.ends_with("/state") {
            super::permissions::check_permission(&ctx.enabled, ext_name, "reader.state.read")
                .map_err(|message| {
                    ApiError::forbidden(
                        "PERMISSION_REQUIRED",
                        format!("{message}；请作者更新 manifest 权限并重新打包导入"),
                    )
                })?;
            // 返回阅读器基本状态（窗口存在性 + 标签）
            if let Some(_window) = ctx.app_handle.get_webview_window(label) {
                let state = serde_json::json!({
                    "window": label,
                    "status": "open",
                });
                return Ok(state.to_string());
            } else {
                return Ok(serde_json::json!({"window": label, "status": "closed"}).to_string());
            }
        }

        // POST /api/v1/reader/{label}/command
        if method == &tiny_http::Method::Post && url.ends_with("/command") {
            super::permissions::check_permission(&ctx.enabled, ext_name, "reader.command.send")
                .map_err(|message| {
                    ApiError::forbidden(
                        "PERMISSION_REQUIRED",
                        format!("{message}；请作者更新 manifest 权限并重新打包导入"),
                    )
                })?;
            let label = label.strip_suffix("/command").unwrap_or(label);
            if let Some(window) = ctx.app_handle.get_webview_window(label) {
                // 将命令作为 Tauri event 转发给阅读器窗口。同步等待时会暂时把
                // request_id 替换为宿主生成的 correlation_id；回执投递和广播前
                // 再恢复拓展传入的 request_id，隔离同名并发和迟到回执。
                let mut payload: serde_json::Value = serde_json::from_str(body).map_err(|e| {
                    ApiError::bad_request("INVALID_JSON", format!("JSON 解析失败: {e}"))
                })?;
                if !payload.is_object() {
                    return Err(ApiError::bad_request(
                        "INVALID_COMMAND",
                        "命令 body 必须是 JSON 对象",
                    ));
                }

                let (request_id, wait_ms) = parse_command_wait(&payload)?;
                if let Some(rid) = &request_id {
                    payload["request_id"] = serde_json::Value::String(rid.clone());
                }
                let result_rx = if wait_ms > 0 {
                    let rid = request_id.as_ref().ok_or_else(|| {
                        ApiError::bad_request(
                            "MISSING_REQUEST_ID",
                            "wait_ms 大于 0 时必须提供非空 request_id",
                        )
                    })?;
                    let (tx, rx) = std::sync::mpsc::channel::<serde_json::Value>();
                    let key = PendingCommandKey {
                        extension_name: ext_name.to_string(),
                        target_window: label.to_string(),
                        request_id: rid.clone(),
                    };
                    let correlation_id = ctx
                        .pending_commands
                        .lock()
                        .unwrap()
                        .register(key, tx)
                        .map_err(|error| {
                            pending_command_registration_error(error, ext_name, label, rid)
                        })?;
                    payload["request_id"] = serde_json::Value::String(correlation_id.clone());
                    Some((rid.clone(), correlation_id, rx))
                } else {
                    None
                };

                if let Err(e) = window.emit("reader:command", &payload) {
                    if let Some((_, correlation_id, _)) = &result_rx {
                        ctx.pending_commands.lock().unwrap().cancel(correlation_id);
                    }
                    return Err(format!("发送命令失败: {e}").into());
                }

                if let Some((rid, correlation_id, rx)) = result_rx {
                    return match rx.recv_timeout(Duration::from_millis(wait_ms)) {
                        Ok(result) => Ok(build_command_result_response(&rid, &result)),
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                            let timeout_won =
                                ctx.pending_commands.lock().unwrap().retire(&correlation_id);
                            if timeout_won {
                                Ok(serde_json::json!({
                                    "sent": true,
                                    "request_id": rid,
                                    "timed_out": true,
                                })
                                .to_string())
                            } else {
                                match rx.try_recv() {
                                    Ok(result) => Ok(build_command_result_response(&rid, &result)),
                                    Err(error) => Err(ApiError::internal_error(
                                        "COMMAND_WAIT_STATE_ERROR",
                                        format!("等待阅读器回执时状态不一致: {error}"),
                                    )),
                                }
                            }
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                            ctx.pending_commands.lock().unwrap().cancel(&correlation_id);
                            Err(ApiError::internal_error(
                                "COMMAND_WAIT_CANCELLED",
                                "等待阅读器回执时通道已关闭",
                            ))
                        }
                    };
                }

                let mut response = serde_json::json!({"sent": true});
                if let Some(rid) = request_id {
                    response["request_id"] = serde_json::Value::String(rid);
                }
                return Ok(response.to_string());
            } else {
                return Err(ApiError::not_found(format!("阅读器窗口「{label}」不存在")));
            }
        }
    }

    Err(ApiError::not_found("未知的阅读器 API 路径"))
}

/// POST /api/v1/extension/sidebar/add
fn handle_ext_sidebar_add(ctx: &ServerContext, ext_name: &str, body: &str) -> ApiResult {
    super::permissions::check_permission(&ctx.enabled, ext_name, "sidebar.add").map_err(
        |message| {
            ApiError::forbidden(
                "PERMISSION_REQUIRED",
                format!("{message}；请作者更新 manifest 权限并重新打包导入"),
            )
        },
    )?;
    let data: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| ApiError::bad_request("INVALID_JSON", format!("JSON 解析失败: {e}")))?;

    // 转发为 Tauri event，前端 Sidebar 监听此事件动态添加
    ctx.app_handle
        .emit("ext:sidebar:add", &data)
        .map_err(|e| format!("发送事件失败: {e}"))?;

    Ok(serde_json::json!({"registered": true}).to_string())
}

/// POST /api/v1/extension/page/register
fn handle_ext_page_register(ctx: &ServerContext, ext_name: &str, body: &str) -> ApiResult {
    super::permissions::check_permission(&ctx.enabled, ext_name, "page.register").map_err(
        |message| {
            ApiError::forbidden(
                "PERMISSION_REQUIRED",
                format!("{message}；请作者更新 manifest 权限并重新打包导入"),
            )
        },
    )?;
    let data: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| ApiError::bad_request("INVALID_JSON", format!("JSON 解析失败: {e}")))?;

    ctx.app_handle
        .emit("ext:page:register", &data)
        .map_err(|e| format!("发送事件失败: {e}"))?;

    Ok(serde_json::json!({"registered": true}).to_string())
}

/// GET /api/v1/extension/storage — 列出所有 key
fn handle_ext_storage_list(ctx: &ServerContext, ext_name: &str) -> ApiResult {
    super::permissions::check_permission(&ctx.enabled, ext_name, "storage").map_err(|message| {
        ApiError::forbidden(
            "PERMISSION_REQUIRED",
            format!("{message}；请作者更新 manifest 权限并重新打包导入"),
        )
    })?;
    let ext_dir = ctx.extensions_dir.join(ext_name);
    let keys = super::storage::list_keys(&ext_dir)?;
    Ok(serde_json::json!({"keys": keys}).to_string())
}

/// /api/v1/extension/storage/{key}
fn handle_ext_storage(
    ctx: &ServerContext,
    ext_name: &str,
    method: &tiny_http::Method,
    url: &str,
    body: &str,
) -> ApiResult {
    // 安全：只有允许 storage 权限的拓展才能访问
    super::permissions::check_permission(&ctx.enabled, ext_name, "storage").map_err(|message| {
        ApiError::forbidden(
            "PERMISSION_REQUIRED",
            format!("{message}；请作者更新 manifest 权限并重新打包导入"),
        )
    })?;

    let key = url.strip_prefix("/api/v1/extension/storage/").unwrap_or("");
    if key.is_empty() {
        return Err(ApiError::bad_request("MISSING_STORAGE_KEY", "缺少 key"));
    }
    super::storage::validate_key(key)
        .map_err(|message| ApiError::bad_request("INVALID_STORAGE_KEY", message))?;

    let ext_dir = ctx.extensions_dir.join(ext_name);

    match method {
        &tiny_http::Method::Get => {
            let value = super::storage::get(&ext_dir, key)?;
            Ok(serde_json::json!({"key": key, "value": value}).to_string())
        }
        &tiny_http::Method::Put => {
            let data: serde_json::Value = serde_json::from_str(body).map_err(|e| {
                ApiError::bad_request("INVALID_JSON", format!("JSON 解析失败: {e}"))
            })?;
            let value = data["value"]
                .as_str()
                .ok_or_else(|| ApiError::bad_request("MISSING_VALUE", "缺少 value 字段"))?;
            super::storage::set(&ext_dir, key, value)?;
            Ok(serde_json::json!({"key": key, "stored": true}).to_string())
        }
        &tiny_http::Method::Delete => {
            super::storage::delete(&ext_dir, key)?;
            Ok(serde_json::json!({"deleted": true}).to_string())
        }
        _ => Err(ApiError::bad_request("UNSUPPORTED_METHOD", "不支持的方法")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{self, TryRecvError};

    fn key(extension_name: &str, target_window: &str, request_id: &str) -> PendingCommandKey {
        PendingCommandKey {
            extension_name: extension_name.into(),
            target_window: target_window.into(),
            request_id: request_id.into(),
        }
    }

    #[test]
    fn raw_socket_limit_precedes_header_parsing_and_recovers() {
        use std::io::{Read, Write};
        use std::net::{TcpListener, TcpStream};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let limiter = Arc::new(RequestLimiter::default());
        let mut clients = Vec::new();
        let mut workers = Vec::new();
        let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        for _ in 0..MAX_CONCURRENT_REQUESTS {
            clients.push(TcpStream::connect(listener.local_addr().unwrap()).unwrap());
            let stream = listener.accept().unwrap().0;
            let gate = gate.clone();
            workers.push(
                dispatch_connection(stream, &limiter, move |stream| {
                    let (lock, condition) = &*gate;
                    let _guard = condition
                        .wait_while(lock.lock().unwrap(), |released| !*released)
                        .unwrap();
                    drop(stream);
                })
                .unwrap(),
            );
        }
        let mut rejected = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        assert!(
            dispatch_connection(listener.accept().unwrap().0, &limiter, |_| panic!(
                "must not parse"
            ))
            .is_none()
        );
        rejected
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        assert!(matches!(rejected.read(&mut [0]), Ok(0) | Err(_)));
        {
            let (lock, condition) = &*gate;
            *lock.lock().unwrap() = true;
            condition.notify_all();
        }
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(limiter.active.load(Ordering::Acquire), 0);
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let worker = dispatch_connection(listener.accept().unwrap().0, &limiter, |stream| {
            let request = super::super::transport::Request::read_headers(stream)
                .ok()
                .unwrap();
            request
                .respond(tiny_http::Response::from_string("ok"))
                .unwrap();
        })
        .unwrap();
        client
            .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert!(response.ends_with("ok"));
        worker.join().unwrap();
    }

    #[test]
    fn concurrent_same_request_id_is_isolated_between_extensions() {
        let mut pending = PendingCommands::default();
        let (first_tx, first_rx) = mpsc::channel();
        let (second_tx, second_rx) = mpsc::channel();
        let first_id = pending
            .register(key("extension-a", "reader-one", "same-id"), first_tx)
            .unwrap();
        let second_id = pending
            .register(key("extension-b", "reader-one", "same-id"), second_tx)
            .unwrap();

        assert_ne!(first_id, second_id);
        assert_eq!(
            pending.deliver(
                &second_id,
                "reader-one",
                serde_json::json!({"success": true, "result": "second"}),
            ),
            ReceiptMatch::Active {
                request_id: "same-id".into()
            }
        );
        assert_eq!(second_rx.recv().unwrap()["result"], "second");
        assert_eq!(first_rx.try_recv(), Err(TryRecvError::Empty));

        assert_eq!(
            pending.deliver(
                &first_id,
                "reader-one",
                serde_json::json!({"success": true, "result": "first"}),
            ),
            ReceiptMatch::Active {
                request_id: "same-id".into()
            }
        );
        assert_eq!(first_rx.recv().unwrap()["result"], "first");
    }

    #[test]
    fn duplicate_active_request_is_rejected() {
        let mut pending = PendingCommands::default();
        let (first_tx, _first_rx) = mpsc::channel();
        let (duplicate_tx, _duplicate_rx) = mpsc::channel();
        pending
            .register(key("extension-a", "reader-one", "request-1"), first_tx)
            .unwrap();

        assert_eq!(
            pending.register(key("extension-a", "reader-one", "request-1"), duplicate_tx,),
            Err(RegisterPendingCommandError::Duplicate)
        );
    }

    #[test]
    fn concurrent_wait_limit_rejects_excess_and_releases_capacity() {
        let mut pending = PendingCommands::default();
        let mut correlation_ids = Vec::new();
        let mut receivers = Vec::new();

        for index in 0..MAX_CONCURRENT_COMMAND_WAITS {
            let (tx, rx) = mpsc::channel();
            correlation_ids.push(
                pending
                    .register(
                        key("extension-a", "reader-one", &format!("request-{index}")),
                        tx,
                    )
                    .unwrap(),
            );
            receivers.push(rx);
        }

        let (excess_tx, _excess_rx) = mpsc::channel();
        assert_eq!(
            pending.register(
                key("extension-b", "reader-two", "request-over-limit"),
                excess_tx,
            ),
            Err(RegisterPendingCommandError::AtCapacity)
        );

        assert_eq!(
            pending.deliver(
                &correlation_ids[0],
                "reader-one",
                serde_json::json!({"success": true}),
            ),
            ReceiptMatch::Active {
                request_id: "request-0".into()
            }
        );
        assert!(receivers[0].recv().is_ok());

        let (replacement_tx, _replacement_rx) = mpsc::channel();
        assert!(pending
            .register(
                key("extension-b", "reader-two", "request-after-release"),
                replacement_tx,
            )
            .is_ok());
    }

    #[test]
    fn receipt_source_must_match_target_window() {
        let mut pending = PendingCommands::default();
        let (tx, rx) = mpsc::channel();
        let correlation_id = pending
            .register(key("extension-a", "reader-one", "request-1"), tx)
            .unwrap();
        let receipt = serde_json::json!({"success": true});

        assert_eq!(
            pending.deliver(&correlation_id, "reader-two", receipt.clone()),
            ReceiptMatch::SourceMismatch {
                target_window: "reader-one".into()
            }
        );
        assert_eq!(rx.try_recv(), Err(TryRecvError::Empty));
        assert_eq!(
            pending.deliver(&correlation_id, "reader-one", receipt),
            ReceiptMatch::Active {
                request_id: "request-1".into()
            }
        );
        assert!(rx.recv().is_ok());
    }

    #[test]
    fn late_receipt_cannot_satisfy_reused_request_id() {
        let mut pending = PendingCommands::default();
        let (old_tx, old_rx) = mpsc::channel();
        let old_id = pending
            .register(key("extension-a", "reader-one", "request-1"), old_tx)
            .unwrap();
        assert_eq!(
            old_rx.recv_timeout(Duration::from_millis(1)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        );
        assert!(pending.retire(&old_id));

        let (new_tx, new_rx) = mpsc::channel();
        let new_id = pending
            .register(key("extension-a", "reader-one", "request-1"), new_tx)
            .unwrap();
        assert_ne!(old_id, new_id);
        assert_eq!(
            pending.deliver(
                &old_id,
                "reader-one",
                serde_json::json!({"success": true, "result": "old"}),
            ),
            ReceiptMatch::Late {
                request_id: "request-1".into()
            }
        );
        assert_eq!(new_rx.try_recv(), Err(TryRecvError::Empty));

        assert_eq!(
            pending.deliver(
                &new_id,
                "reader-one",
                serde_json::json!({"success": true, "result": "new"}),
            ),
            ReceiptMatch::Active {
                request_id: "request-1".into()
            }
        );
        assert_eq!(new_rx.recv().unwrap()["result"], "new");
    }

    #[test]
    fn timeout_and_delivery_have_a_single_registry_winner() {
        let mut pending = PendingCommands::default();

        let (timed_out_tx, timed_out_rx) = mpsc::channel();
        let timed_out_id = pending
            .register(key("extension-a", "reader-one", "timed-out"), timed_out_tx)
            .unwrap();
        assert!(pending.retire(&timed_out_id));
        assert_eq!(
            pending.deliver(
                &timed_out_id,
                "reader-one",
                serde_json::json!({"success": true}),
            ),
            ReceiptMatch::Late {
                request_id: "timed-out".into()
            }
        );
        assert_eq!(timed_out_rx.try_recv(), Err(TryRecvError::Disconnected));

        let (delivered_tx, delivered_rx) = mpsc::channel();
        let delivered_id = pending
            .register(key("extension-a", "reader-one", "delivered"), delivered_tx)
            .unwrap();
        assert_eq!(
            pending.deliver(
                &delivered_id,
                "reader-one",
                serde_json::json!({"success": true, "result": "on-time"}),
            ),
            ReceiptMatch::Active {
                request_id: "delivered".into()
            }
        );
        assert!(!pending.retire(&delivered_id));
        assert_eq!(delivered_rx.try_recv().unwrap()["result"], "on-time");
    }

    #[test]
    fn wait_parameters_have_deterministic_errors_and_limit() {
        assert_eq!(
            parse_command_wait(&serde_json::json!({"command": "ping"})).unwrap(),
            (None, 0)
        );
        assert_eq!(
            parse_command_wait(&serde_json::json!({"wait_ms": 0})).unwrap(),
            (None, 0)
        );
        assert_eq!(
            parse_command_wait(&serde_json::json!({
                "request_id": 42,
                "wait_ms": 0,
            }))
            .unwrap(),
            (None, 0)
        );

        let missing_id = parse_command_wait(&serde_json::json!({"wait_ms": 1})).unwrap_err();
        assert_eq!(missing_id.status, 400);
        assert_eq!(missing_id.code, "MISSING_REQUEST_ID");

        let invalid_id = parse_command_wait(&serde_json::json!({
            "request_id": 42,
            "wait_ms": 1,
        }))
        .unwrap_err();
        assert_eq!(invalid_id.status, 400);
        assert_eq!(invalid_id.code, "INVALID_REQUEST_ID");

        let invalid_wait = parse_command_wait(&serde_json::json!({
            "request_id": "r1",
            "wait_ms": -1,
        }))
        .unwrap_err();
        assert_eq!(invalid_wait.status, 400);
        assert_eq!(invalid_wait.code, "INVALID_WAIT_MS");

        let too_large = parse_command_wait(&serde_json::json!({
            "request_id": "r1",
            "wait_ms": MAX_COMMAND_WAIT_MS + 1,
        }))
        .unwrap_err();
        assert_eq!(too_large.status, 400);
        assert_eq!(too_large.code, "WAIT_MS_TOO_LARGE");
        assert_eq!(
            parse_command_wait(&serde_json::json!({
                "request_id": "  r1  ",
                "wait_ms": MAX_COMMAND_WAIT_MS,
            }))
            .unwrap(),
            (Some("r1".into()), MAX_COMMAND_WAIT_MS)
        );
    }

    #[test]
    fn route_not_found_error_uses_http_404() {
        let error = ApiError::not_found("未知路径");
        assert_eq!(error.status, 404);
        assert_eq!(error.code, "NOT_FOUND");
    }

    #[test]
    fn string_errors_default_to_internal_server_errors() {
        let error = ApiError::from("storage failed".to_string());
        assert_eq!(error.status, 500);
        assert_eq!(error.code, "INTERNAL_ERROR");
    }

    #[test]
    fn internal_request_ids_are_recognized() {
        assert!(is_internal_request_id("moke-pending:123"));
        assert!(!is_internal_request_id("extension-request"));
    }

    #[test]
    fn wait_capacity_error_uses_http_429_and_stable_code() {
        let error = pending_command_registration_error(
            RegisterPendingCommandError::AtCapacity,
            "extension-a",
            "reader-one",
            "request-1",
        );
        assert_eq!(error.status, 429);
        assert_eq!(error.code, "TOO_MANY_PENDING_COMMANDS");
    }

    #[test]
    fn command_receipt_is_flattened_for_success_and_failure() {
        let success: serde_json::Value = serde_json::from_str(&build_command_result_response(
            "r1",
            &serde_json::json!({
                "request_id": "internal",
                "command": "get_position",
                "success": true,
                "result": {"view_key": "book-1"},
            }),
        ))
        .unwrap();
        assert_eq!(
            success,
            serde_json::json!({
                "sent": true,
                "request_id": "r1",
                "success": true,
                "result": {"view_key": "book-1"},
            })
        );

        let failure: serde_json::Value = serde_json::from_str(&build_command_result_response(
            "r2",
            &serde_json::json!({"success": false, "error": "No active reader view"}),
        ))
        .unwrap();
        assert_eq!(
            failure,
            serde_json::json!({
                "sent": true,
                "request_id": "r2",
                "success": false,
                "error": "No active reader view",
            })
        );

        let invalid: serde_json::Value = serde_json::from_str(&build_command_result_response(
            "r3",
            &serde_json::json!({"command": "legacy", "value": 42}),
        ))
        .unwrap();
        assert_eq!(invalid["success"], false);
        assert_eq!(
            invalid["result"],
            serde_json::json!({"command": "legacy", "value": 42})
        );
    }

    #[test]
    fn cors_preflight_header_policy_matches_actual_api_headers() {
        assert!(validate_requested_headers(Some(
            "content-type, X-Extension-Name, x-extension-token",
        ))
        .is_ok());
        let error = validate_requested_headers(Some("X-Extension-Name, X-Evil")).unwrap_err();
        assert_eq!(error.status, 403);
        assert_eq!(error.code, "CORS_HEADER_FORBIDDEN");
    }

    #[test]
    fn body_and_concurrency_limits_have_stable_errors() {
        let body_error = ApiError::payload_too_large();
        assert_eq!(body_error.status, 413);
        assert_eq!(body_error.code, "PAYLOAD_TOO_LARGE");

        let limiter = Arc::new(RequestLimiter::default());
        let permits: Vec<_> = (0..MAX_CONCURRENT_REQUESTS)
            .map(|_| limiter.try_acquire().expect("capacity available"))
            .collect();
        assert!(limiter.try_acquire().is_none());
        drop(permits);
        assert!(limiter.try_acquire().is_some());
    }

    #[test]
    fn oversized_and_authentication_errors_are_stable_without_echoing_credentials() {
        let auth_error = ApiError::unauthorized("token 无效");
        let body_error = ApiError::payload_too_large();
        assert_eq!((auth_error.status, auth_error.code), (401, "AUTH_FAILED"));
        assert_eq!(
            (body_error.status, body_error.code),
            (413, "PAYLOAD_TOO_LARGE")
        );
        assert!(!auth_error.message.contains("moke_ext_"));
        assert!(!body_error.message.contains("moke_ext_"));
    }
}
