//! 阅读统计拓展 — 后端。
//!
//! 架构：
//!   - 主线程： tiny_http 服务器，serve 静态文件 + /api/token + /api/stats
//!   - 后台线程： WebSocket 客户端，连接宿主的 WS Server，订阅阅读事件并累计统计
//!   - 统计数据结构在 Arc<Mutex<>> 中共享，持久化到 stats.json
//!
//! 用法: server --ext-port PORT

use std::collections::HashSet;
use std::env;
use std::fs;
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tiny_http::{Header, Response, Server};
use tungstenite::{connect, Message};

// ---------------------------------------------------------------------------
// 统计数据结构
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Stats {
    page_turns: u64,
    books_opened: u64,
    /// 累计阅读毫秒数（不含当前会话）
    total_reading_ms: u64,
    /// 当前书籍开始阅读的时间戳（毫秒），None 表示当前未在阅读
    #[serde(skip)]
    reading_start_time: Option<u64>,
    current_book: Option<CurrentBook>,
    /// 当前活跃的 view_key 集合，用于判断是否仍有书籍在阅读
    #[serde(skip)]
    active_view_keys: HashSet<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CurrentBook {
    book_id: String,
    title: String,
    author: String,
    format: String,
    progress: u32,
    cover_url: String,
    language: String,
}

impl Stats {
    /// 当前阅读中会话的毫秒数。
    fn session_ms(&self) -> u64 {
        self.reading_start_time
            .map(|t| now_ms().saturating_sub(t))
            .unwrap_or(0)
    }

    /// 总阅读分钟数。
    fn total_minutes(&self) -> u64 {
        (self.total_reading_ms + self.session_ms()) / 60_000
    }

    fn start_reading(&mut self) {
        if self.reading_start_time.is_none() {
            self.reading_start_time = Some(now_ms());
        }
    }

    fn stop_reading(&mut self) {
        if let Some(t) = self.reading_start_time.take() {
            self.total_reading_ms += now_ms().saturating_sub(t);
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

const STATS_FILE: &str = "stats.json";

fn load_stats() -> Stats {
    match fs::read_to_string(STATS_FILE) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => Stats::default(),
    }
}

fn save_stats(stats: &Stats) {
    let json = match serde_json::to_string(stats) {
        Ok(j) => j,
        Err(_) => return,
    };
    let tmp = format!("{STATS_FILE}.tmp");
    let _ = fs::write(&tmp, &json);
    let _ = fs::rename(&tmp, STATS_FILE);
}

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

fn json_response(data: serde_json::Value) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = data.to_string();
    Response::from_string(body)
        .with_header(header("Content-Type", "application/json"))
        .with_header(header("Access-Control-Allow-Origin", "*"))
}

// ===========================================================================
// 后台线程： WebSocket 客户端
// ===========================================================================

fn ws_client_loop(
    stats: Arc<Mutex<Stats>>,
    ws_port: u16,
    token: String,
    ext_name: String,
) {
    let url = format!("ws://127.0.0.1:{ws_port}");

    loop {
        eprintln!("[ws] 正在连接 {url}...");

        let (mut ws, _) = match connect(&url) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[ws] 连接失败: {e}，5 秒后重试");
                thread::sleep(Duration::from_secs(5));
                continue;
            }
        };

        eprintln!("[ws] 已连接，发送握手...");
        let hello = serde_json::json!({
            "type": "hello",
            "extension": ext_name,
            "token": token,
            "events": [
                "reader:book:opened",
                "reader:book:closed",
                "reader:page:changed"
            ]
        })
        .to_string();

        if ws.send(Message::Text(hello)).is_err() {
            eprintln!("[ws] 握手发送失败");
            thread::sleep(Duration::from_secs(5));
            continue;
        }

        eprintln!("[ws] 握手完成，等待事件...");

        // 事件读取循环
        loop {
            match ws.read() {
                Ok(Message::Text(text)) => {
                    if let Ok(envelope) = serde_json::from_str::<serde_json::Value>(&text) {
                        let event = envelope["event"].as_str().unwrap_or("");
                        let data = &envelope["data"];
                        handle_ws_event(&stats, event, data);
                    }
                }
                Ok(Message::Ping(p)) => {
                    let _ = ws.send(Message::Pong(p));
                }
                Ok(Message::Close(_)) => {
                    eprintln!("[ws] 服务器关闭连接，5 秒后重连");
                    break;
                }
                Err(e) => {
                    eprintln!("[ws] 读取错误: {e}，5 秒后重连");
                    break;
                }
                _ => {} // ignore binary, pong
            }
        }

        // 断线：停止当前会话计时
        stats.lock().unwrap().stop_reading();
        thread::sleep(Duration::from_secs(5));
    }
}

fn handle_ws_event(stats: &Arc<Mutex<Stats>>, event: &str, data: &serde_json::Value) {
    let mut s = stats.lock().unwrap();

    match event {
        "reader:book:opened" => {
            let view_key = data["view_key"].as_str().unwrap_or("").to_string();
            s.books_opened += 1;
            if !view_key.is_empty() {
                s.active_view_keys.insert(view_key);
            }
            s.start_reading();
            s.current_book = Some(CurrentBook {
                book_id: data["book_id"].as_str().unwrap_or("").into(),
                title: data["title"].as_str().unwrap_or("").into(),
                author: data["author"].as_str().unwrap_or("").into(),
                format: data["format"].as_str().unwrap_or("").into(),
                progress: data["progress"].as_u64().unwrap_or(0) as u32,
                cover_url: data["cover_url"].as_str().unwrap_or("").into(),
                language: data["language"].as_str().unwrap_or("").into(),
            });
            eprintln!("[stats] 打开书籍: {}", s.current_book.as_ref().map(|b| &b.title[..]).unwrap_or("?"));
        }

        "reader:book:closed" => {
            let view_key = data["view_key"].as_str().unwrap_or("");
            s.active_view_keys.remove(view_key);
            if s.active_view_keys.is_empty() {
                s.stop_reading();
                s.current_book = None;
            }
            eprintln!("[stats] 关闭书籍 (view_key={view_key}), 剩余活跃: {}", s.active_view_keys.len());
        }

        "reader:page:changed" => {
            s.page_turns += 1;
            if s.reading_start_time.is_none() {
                s.start_reading();
            }
            if let Some(ref mut book) = s.current_book {
                if let Some(p) = data["progress"].as_u64() {
                    book.progress = p as u32;
                }
            }
        }

        _ => {}
    }

    // 每次事件后持久化
    save_stats(&s);
}

// ===========================================================================
// 主线程： HTTP 服务器
// ===========================================================================

fn main() {
    // 解析参数: --ext-port PORT
    let args: Vec<String> = env::args().collect();
    let port: u16 = args
        .iter()
        .position(|a| a == "--ext-port")
        .and_then(|i| args.get(i + 1))
        .and_then(|p| p.parse().ok())
        .unwrap_or(19557);

    let exe_dir = env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let ui_dir = exe_dir.join("ui");

    if !ui_dir.exists() {
        eprintln!("错误: UI 目录不存在: {}", ui_dir.display());
        std::process::exit(1);
    }

    // 从环境变量读取宿主配置
    let token = env::var("MOKE_EXT_TOKEN").unwrap_or_default();
    let api_port: u16 = env::var("MOKE_API_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(19555);
    let ws_port: u16 = env::var("MOKE_WS_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(19556);

    // 加载已持久化的统计
    let stats = Arc::new(Mutex::new(load_stats()));

    // 启动后台 WebSocket 客户端
    {
        let stats = stats.clone();
        let ext_name = "reading-stats".to_string();
        let ws_token = token.clone();
        thread::spawn(move || {
            ws_client_loop(stats, ws_port, ws_token, ext_name);
        });
    }

    // 启动 HTTP 服务器（主线程）
    let server = Server::http(format!("127.0.0.1:{port}")).unwrap_or_else(|e| {
        eprintln!("无法启动服务器: {e}");
        std::process::exit(1);
    });

    eprintln!("阅读统计后端已启动:");
    eprintln!("  HTTP: http://127.0.0.1:{port}");
    eprintln!("  API 端口: {api_port}, WS 端口: {ws_port}");

    for request in server.incoming_requests() {
        let url = request.url().to_string();

        match url.as_str() {
            "/api/token" => {
                let _ = request.respond(json_response(serde_json::json!({
                    "token": token
                })));
                continue;
            }
            "/api/config" => {
                let _ = request.respond(json_response(serde_json::json!({
                    "api_port": api_port,
                    "ws_port": ws_port,
                })));
                continue;
            }
            "/api/stats" => {
                let s = stats.lock().unwrap();
                let _ = request.respond(json_response(serde_json::json!({
                    "page_turns": s.page_turns,
                    "books_opened": s.books_opened,
                    "total_minutes": s.total_minutes(),
                    "total_reading_ms": s.total_reading_ms,
                    "reading_active": s.reading_start_time.is_some(),
                    "current_book": s.current_book,
                })));
                continue;
            }
            _ => {}
        }

        // 静态文件
        let path = if url == "/" || url.is_empty() {
            "index.html".to_string()
        } else {
            url.trim_start_matches('/').to_string()
        };

        let decoded = urlencoding(&path);
        if is_path_traversal(&decoded) {
            let _ = request.respond(Response::from_string("403 Forbidden").with_status_code(403));
            continue;
        }

        let file_path = ui_dir.join(&decoded);
        serve_static(request, &file_path);
    }
}

// ---------------------------------------------------------------------------
// 静态文件服务
// ---------------------------------------------------------------------------

fn serve_static(request: tiny_http::Request, file_path: &std::path::Path) {
    match fs::read(file_path) {
        Ok(data) => {
            let mime = mime_type(file_path);
            let _ = request.respond(
                Response::from_data(data)
                    .with_header(header("Content-Type", mime))
                    .with_header(header("Access-Control-Allow-Origin", "*")),
            );
        }
        Err(_) => {
            let _ = request.respond(Response::from_string("404 Not Found").with_status_code(404));
        }
    }
}

fn mime_type(path: &std::path::Path) -> &str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "application/javascript; charset=utf-8",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    }
}

// ---------------------------------------------------------------------------
// 安全工具
// ---------------------------------------------------------------------------

fn urlencoding(raw: &str) -> String {
    let mut result = String::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&raw[i + 1..i + 3], 16) {
                result.push(hex as char);
                i += 3;
                continue;
            }
        }
        result.push(bytes[i] as char);
        i += 1;
    }
    result
}

fn is_path_traversal(path: &str) -> bool {
    path.contains("..") || path.contains('\\')
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_url_decode_percent() {
        assert_eq!(urlencoding("hello%20world"), "hello world");
        assert_eq!(urlencoding("%2e%2e%2f"), "../");
        assert_eq!(urlencoding("index.html"), "index.html");
    }

    #[test]
    fn test_path_traversal_detection() {
        assert!(!is_path_traversal("index.html"));
        assert!(is_path_traversal("../secret.txt"));
        assert!(is_path_traversal(&urlencoding("%2e%2e%2f")));
    }

    #[test]
    fn test_stats_session() {
        let mut s = Stats::default();
        assert_eq!(s.total_minutes(), 0);

        s.start_reading();
        assert!(s.reading_start_time.is_some());

        // Simulate elapsed time
        s.reading_start_time = Some(s.reading_start_time.unwrap() - 60_000);

        s.stop_reading();
        assert!(s.reading_start_time.is_none());
        assert!(s.total_reading_ms >= 60_000);
        assert_eq!(s.total_minutes(), 1);
    }
}
