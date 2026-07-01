//! WebSocket 事件服务器 + Tauri event 桥接。
//!
//! 单线程事件循环：accept 新连接、接收认证/订阅、接收广播、发送消息。

use super::EnabledExtension;
use std::collections::HashMap;
use std::net::TcpListener;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

/// 广播消息。
#[derive(Debug, Clone)]
pub struct WsBroadcast {
    pub event: String,
    pub data: String,
}

/// 一个已认证且已订阅的客户端连接。
struct Client {
    ws: tungstenite::WebSocket<std::net::TcpStream>,
    extension_name: String,
    subscriptions: Vec<String>,
}

// ---------------------------------------------------------------------------
// 公开接口
// ---------------------------------------------------------------------------

/// 启动 WebSocket 服务器，返回 (实际端口, 广播发送端)。
/// 如果首选端口被占用，自动尝试下一个端口（最多 10 次）。
pub fn start(
    enabled: Arc<Mutex<HashMap<String, EnabledExtension>>>,
    start_port: u16,
) -> (u16, Sender<WsBroadcast>) {
    let (tx, rx) = mpsc::channel::<WsBroadcast>();

    let mut port = start_port;
    let listener = loop {
        match TcpListener::bind(format!("127.0.0.1:{port}")) {
            Ok(l) => break l,
            Err(e) if port < start_port + 10 => {
                log::warn!("WS Server 端口 {port} 被占用，尝试 {next}", next = port + 1);
                port += 1;
            }
            Err(e) => panic!("无法启动 WS Server (尝试了 {start_port}-{port}): {e}"),
        }
    };
    listener
        .set_nonblocking(true)
        .expect("无法设置非阻塞模式");

    let actual_port = listener.local_addr().unwrap().port();
    log::info!("拓展 WS Server 已启动: ws://127.0.0.1:{actual_port}");

    thread::spawn(move || {
        let mut clients: Vec<Client> = Vec::new();

        loop {
            // 1. 接受新连接
            match listener.accept() {
                Ok((stream, addr)) => {
                    log::info!("WS 新连接: {addr}");

                    let mut ws = match tungstenite::accept(stream) {
                        Ok(w) => w,
                        Err(e) => {
                            log::warn!("WS 握手失败: {e}");
                            continue;
                        }
                    };

                    // 读取认证和订阅消息（非阻塞超时）
                    match authenticate_and_subscribe(&mut ws, &enabled) {
                        Ok((name, subs)) => {
                            log::info!("WS 认证成功: {name}, 订阅: {subs:?}");
                            clients.push(Client {
                                ws,
                                extension_name: name,
                                subscriptions: subs,
                            });
                        }
                        Err(e) => {
                            log::warn!("WS 认证失败: {e}");
                            let _ = ws.close(None);
                        }
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // 无新连接，继续处理
                }
                Err(e) => {
                    log::error!("WS accept 错误: {e}");
                }
            }

            // 2. 处理广播
            while let Ok(msg) = rx.try_recv() {
                broadcast(&mut clients, &msg);
            }

            // 3. 处理客户端消息（pong、unsubscribe 等）并清理断线
            clients.retain_mut(|client| {
                match client.ws.read() {
                    Ok(tungstenite::Message::Text(text)) => {
                        if text == "ping" {
                            let _ = client.ws.send(tungstenite::Message::Text("pong".into()));
                        }
                        true
                    }
                    Ok(tungstenite::Message::Binary(_)) => true,
                    Ok(tungstenite::Message::Ping(data)) => {
                        let _ = client.ws.send(tungstenite::Message::Pong(data));
                        true
                    }
                    Ok(tungstenite::Message::Pong(_)) => true,
                    Ok(tungstenite::Message::Close(_)) => {
                        log::info!("WS 客户端断开: {}", client.extension_name);
                        false
                    }
                    Err(tungstenite::Error::ConnectionClosed)
                    | Err(tungstenite::Error::AlreadyClosed) => {
                        log::info!("WS 连接关闭: {}", client.extension_name);
                        false
                    }
                    Err(tungstenite::Error::Io(ref io))
                        if io.kind() == std::io::ErrorKind::WouldBlock =>
                    {
                        true
                    }
                    Err(e) => {
                        log::warn!("WS 错误 ({}): {e}", client.extension_name);
                        false
                    }
                    _ => true,
                }
            });

            // 4. 短暂休眠避免忙等
            thread::sleep(Duration::from_millis(50));
        }
    });

    (actual_port, tx)
}

// ---------------------------------------------------------------------------
// 认证与订阅
// ---------------------------------------------------------------------------

fn authenticate_and_subscribe(
    ws: &mut tungstenite::WebSocket<std::net::TcpStream>,
    enabled: &Arc<Mutex<HashMap<String, EnabledExtension>>>,
) -> Result<(String, Vec<String>), String> {
    // 显式设为阻塞模式 + 5 秒超时（Windows 上 set_read_timeout 不会自动从 nonblocking 切回）
    ws.get_mut()
        .set_nonblocking(false)
        .map_err(|e| format!("设置阻塞模式失败: {e}"))?;
    ws.get_mut()
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| format!("设置超时失败: {e}"))?;

    // 单条握手消息：同时携带 auth 和 subscriptions
    // 格式: {"type":"hello", "extension":"...", "token":"...", "events":[...]}
    // 循环读取，跳过 Ping/Pong 帧，直到收到 Text/Binary
    let msg = loop {
        match ws.read() {
            Ok(tungstenite::Message::Text(text)) => break text,
            Ok(tungstenite::Message::Binary(data)) => {
                break String::from_utf8_lossy(&data).to_string()
            }
            Ok(tungstenite::Message::Ping(data)) => {
                let _ = ws.send(tungstenite::Message::Pong(data));
            }
            Ok(tungstenite::Message::Pong(_)) => { /* ignore */ }
            Ok(tungstenite::Message::Close(_)) => {
                return Err("客户端在握手阶段关闭了连接".into());
            }
            Ok(other) => {
                log::warn!("WS 握手收到非预期消息: {other:?}");
                return Err(format!("握手消息无效 ({other:?})"));
            }
            Err(e) => {
                log::warn!("WS 握手读取错误: {e}");
                return Err(format!("握手读取失败: {e}"));
            }
        }
    };

    let data: serde_json::Value =
        serde_json::from_str(&msg).map_err(|_| "握手 JSON 解析失败".to_string())?;

    let ext_name = data["extension"].as_str().unwrap_or("").to_string();
    let token = data["token"].as_str().unwrap_or("");

    {
        let enabled_map = enabled.lock().unwrap();
        match enabled_map.get(&ext_name) {
            Some(ext) if ext.token == token => { /* OK */ }
            _ => return Err("token 无效或拓展未启用".into()),
        }
    }

    let subscriptions: Vec<String> = data["events"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    // 设为非阻塞模式（set_read_timeout(None) = 无限阻塞，会卡死主循环！）
    ws.get_mut()
        .set_nonblocking(true)
        .map_err(|e| format!("设置非阻塞失败: {e}"))?;

    Ok((ext_name, subscriptions))
}

// ---------------------------------------------------------------------------
// 广播
// ---------------------------------------------------------------------------

fn broadcast(clients: &mut Vec<Client>, msg: &WsBroadcast) {
    let payload = serde_json::json!({
        "event": msg.event,
        "data": serde_json::from_str::<serde_json::Value>(&msg.data).unwrap_or_default(),
        "timestamp": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    })
    .to_string();

    for client in clients.iter_mut() {
        if client.subscriptions.iter().any(|s| s == &msg.event) {
            if let Err(e) = client
                .ws
                .send(tungstenite::Message::Text(payload.clone()))
            {
                log::warn!("WS 发送失败 ({}): {e}", client.extension_name);
            }
        }
    }
}
