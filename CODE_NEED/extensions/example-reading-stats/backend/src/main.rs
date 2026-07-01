//! 阅读统计拓展 — 最小化后端。
//!
//! 用法: server --ext-port PORT
//!
//! 功能:
//!   - 在指定端口上 serve ui/ 目录下的静态文件
//!   - 提供 /api/token 端点让前端获取 token（从环境变量 MOKE_EXT_TOKEN 读取）

use std::env;
use std::fs;
use std::path::PathBuf;
use tiny_http::{Header, Response, Server};

/// 快速创建 Header，避免 `.parse()` 的类型推断问题。
fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

fn main() {
    // 解析参数: --ext-port PORT
    let args: Vec<String> = env::args().collect();
    let port: u16 = args
        .iter()
        .position(|a| a == "--ext-port")
        .and_then(|i| args.get(i + 1))
        .and_then(|p| p.parse().ok())
        .unwrap_or(19557);

    // 确定 ui 目录位置（相对于可执行文件所在目录）
    let exe_dir = env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let ui_dir = exe_dir.join("ui");

    if !ui_dir.exists() {
        eprintln!("错误: UI 目录不存在: {}", ui_dir.display());
        std::process::exit(1);
    }

    let server = Server::http(format!("127.0.0.1:{port}")).unwrap_or_else(|e| {
        eprintln!("无法启动服务器: {e}");
        std::process::exit(1);
    });

    println!("阅读统计后端已启动: http://127.0.0.1:{port}");
    println!("UI 目录: {}", ui_dir.display());

    for request in server.incoming_requests() {
        let url = request.url().to_string();
        let path = if url == "/" || url.is_empty() {
            "index.html".to_string()
        } else {
            url.trim_start_matches('/').to_string()
        };

        // 安全: 防止路径穿越
        if path.contains("..") || path.contains('\\') {
            let _ = request.respond(
                Response::from_string("403 Forbidden").with_status_code(403),
            );
            continue;
        }

        let file_path = ui_dir.join(&path);

        // /api/token — 返回 token
        if url == "/api/token" {
            let token = env::var("MOKE_EXT_TOKEN").unwrap_or_default();
            let json = format!(r#"{{"token":"{token}"}}"#);
            let _ = request.respond(
                Response::from_string(json)
                    .with_header(header("Content-Type", "application/json"))
                    .with_header(header("Access-Control-Allow-Origin", "*")),
            );
            continue;
        }

        // 静态文件服务
        match fs::read(&file_path) {
            Ok(data) => {
                let mime = mime_type(&path);
                let _ = request.respond(
                    Response::from_data(data)
                        .with_header(header("Content-Type", mime))
                        .with_header(header("Access-Control-Allow-Origin", "*")),
                );
            }
            Err(_) => {
                let _ = request.respond(
                    Response::from_string("404 Not Found").with_status_code(404),
                );
            }
        }
    }
}

fn mime_type(path: &str) -> &str {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}
