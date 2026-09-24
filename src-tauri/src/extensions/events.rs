//! WebSocket 事件服务器 + Tauri event 桥接。
//!
//! 单线程事件循环：accept 新连接、接收认证/订阅、接收广播、发送消息。
//! 支持事件重放：新客户端订阅时，立即回放最近一次该类型事件的缓存数据。

use super::EnabledExtension;
use std::collections::HashMap;
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub(crate) const MAX_PENDING_WS_HANDSHAKES: usize = 16;
pub(crate) const MAX_AUTHENTICATED_WS_CLIENTS: usize = 64;
pub(crate) const MAX_WS_MESSAGE_BYTES: usize = 64 * 1024;
const WS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

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
    /// 最后一次收到消息或 pong 的时间，用于心跳超时检测。
    last_activity: std::time::Instant,
}

struct HandshakeSlot {
    active: Arc<AtomicUsize>,
}

impl Drop for HandshakeSlot {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::Release);
    }
}

fn try_acquire_handshake_slot(active: &Arc<AtomicUsize>) -> Option<HandshakeSlot> {
    active
        .fetch_update(Ordering::Acquire, Ordering::Relaxed, |current| {
            (current < MAX_PENDING_WS_HANDSHAKES).then_some(current + 1)
        })
        .ok()
        .map(|_| HandshakeSlot {
            active: active.clone(),
        })
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
    let (handshake_tx, handshake_rx) = mpsc::channel::<Result<Client, String>>();

    let mut port = start_port;
    let listener = loop {
        match TcpListener::bind(format!("127.0.0.1:{port}")) {
            Ok(l) => break l,
            Err(_e) if port < start_port + 10 => {
                log::warn!("WS Server 端口 {port} 被占用，尝试 {next}", next = port + 1);
                port += 1;
            }
            Err(e) => panic!("无法启动 WS Server (尝试了 {start_port}-{port}): {e}"),
        }
    };
    listener.set_nonblocking(true).expect("无法设置非阻塞模式");

    let actual_port = listener.local_addr().unwrap().port();
    log::info!("拓展 WS Server 已启动: ws://127.0.0.1:{actual_port}");

    thread::spawn(move || {
        let mut clients: Vec<Client> = Vec::new();
        let active_handshakes = Arc::new(AtomicUsize::new(0));
        // 事件重放缓存：event → 最近一次广播的 JSON payload
        let mut last_events: HashMap<String, String> = HashMap::new();
        // 心跳 tick 计数器
        let mut tick: u64 = 0;
        const HEARTBEAT_INTERVAL: u64 = 20; // 每 20 tick (~1s) 发一次 ping
        const STALE_TIMEOUT_SECS: u64 = 30;

        loop {
            // 1. 接受新连接
            match listener.accept() {
                Ok((stream, addr)) => {
                    log::info!("WS 新连接: {addr}");
                    let Some(slot) = try_acquire_handshake_slot(&active_handshakes) else {
                        log::warn!("WS 握手并发已达上限，拒绝连接: {addr}");
                        drop(stream);
                        continue;
                    };
                    if clients.len() >= MAX_AUTHENTICATED_WS_CLIENTS {
                        log::warn!("WS 客户端数量已达上限，拒绝连接: {addr}");
                        drop(stream);
                        continue;
                    }
                    let enabled = enabled.clone();
                    let handshake_tx = handshake_tx.clone();
                    thread::spawn(move || {
                        let _slot = slot;
                        let result = perform_handshake(stream, &enabled);
                        let _ = handshake_tx.send(result);
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // 无新连接，继续处理
                }
                Err(e) => {
                    log::error!("WS accept 错误: {e}");
                }
            }

            // 已认证握手通过有界并发工作线程返回，不阻塞事件广播循环。
            while let Ok(result) = handshake_rx.try_recv() {
                match result {
                    Ok(mut client) if clients.len() < MAX_AUTHENTICATED_WS_CLIENTS => {
                        log::info!(
                            "WS 认证成功: {}, 订阅: {:?}",
                            client.extension_name,
                            client.subscriptions
                        );
                        replay_events(&mut client.ws, &client.subscriptions, &last_events);
                        clients.push(client);
                    }
                    Ok(mut client) => {
                        let _ = client.ws.close(None);
                    }
                    Err(error) => log::warn!("WS 握手或认证失败: {error}"),
                }
            }

            // 2. 处理广播（同时更新缓存）
            while let Ok(msg) = rx.try_recv() {
                let payload = build_payload(&msg);
                last_events.insert(msg.event.clone(), payload.clone());
                broadcast_to_clients(&mut clients, &msg.event, &payload);
            }

            // 3. 处理客户端消息（pong、unsubscribe 等）并清理断线
            clients.retain_mut(|client| match client.ws.read() {
                Ok(tungstenite::Message::Text(text)) => {
                    client.last_activity = std::time::Instant::now();
                    if text == "ping" {
                        let _ = client.ws.send(tungstenite::Message::Text("pong".into()));
                    }
                    true
                }
                Ok(tungstenite::Message::Binary(_)) => {
                    client.last_activity = std::time::Instant::now();
                    true
                }
                Ok(tungstenite::Message::Ping(data)) => {
                    client.last_activity = std::time::Instant::now();
                    let _ = client.ws.send(tungstenite::Message::Pong(data));
                    true
                }
                Ok(tungstenite::Message::Pong(_)) => {
                    client.last_activity = std::time::Instant::now();
                    true
                }
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
            });

            // 4. 心跳：定期 ping 客户端 + 清理超时连接
            tick = tick.wrapping_add(1);
            if tick % HEARTBEAT_INTERVAL == 0 {
                let now = std::time::Instant::now();
                // 发送 ping 帧，并清理超时（STALE_TIMEOUT_SECS 无活动）的连接
                clients.retain_mut(|client| {
                    if now.duration_since(client.last_activity)
                        > Duration::from_secs(STALE_TIMEOUT_SECS)
                    {
                        log::warn!(
                            "[ext] WS 客户端 {} 心跳超时，断开连接",
                            client.extension_name
                        );
                        return false;
                    }
                    // 发送 WebSocket Ping，接收方自动回复 Pong
                    if let Err(e) = client.ws.send(tungstenite::Message::Ping(vec![])) {
                        log::warn!("[ext] WS ping 失败 ({}): {e}", client.extension_name);
                        return false;
                    }
                    true
                });
            }

            // 5. 短暂休眠避免忙等
            thread::sleep(Duration::from_millis(50));
        }
    });

    (actual_port, tx)
}

fn perform_handshake(
    stream: std::net::TcpStream,
    enabled: &Arc<Mutex<HashMap<String, EnabledExtension>>>,
) -> Result<Client, String> {
    // Apply timeouts before parsing the HTTP Upgrade request. A peer that
    // connects without sending headers can therefore occupy only one bounded
    // handshake slot for a short, fixed interval.
    stream
        .set_nonblocking(false)
        .map_err(|error| format!("设置 WS 阻塞模式失败: {error}"))?;
    stream
        .set_read_timeout(Some(WS_HANDSHAKE_TIMEOUT))
        .map_err(|error| format!("设置 WS 握手读取超时失败: {error}"))?;
    stream
        .set_write_timeout(Some(WS_HANDSHAKE_TIMEOUT))
        .map_err(|error| format!("设置 WS 握手写入超时失败: {error}"))?;

    let mut config = tungstenite::protocol::WebSocketConfig::default();
    config.max_message_size = Some(MAX_WS_MESSAGE_BYTES);
    config.max_frame_size = Some(MAX_WS_MESSAGE_BYTES);
    let mut ws = tungstenite::accept_with_config(stream, Some(config))
        .map_err(|error| format!("WebSocket HTTP 握手失败: {error}"))?;
    let (extension_name, subscriptions) = authenticate_and_subscribe(&mut ws, enabled)?;
    Ok(Client {
        ws,
        extension_name,
        subscriptions,
        last_activity: std::time::Instant::now(),
    })
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
// 广播与重放
// ---------------------------------------------------------------------------

/// 构建广播 JSON payload。
fn build_payload(msg: &WsBroadcast) -> String {
    serde_json::json!({
        "event": msg.event,
        "data": serde_json::from_str::<serde_json::Value>(&msg.data).unwrap_or_default(),
        "timestamp": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    })
    .to_string()
}

/// 向已订阅客户端广播消息。
fn broadcast_to_clients(clients: &mut Vec<Client>, event: &str, payload: &str) {
    for client in clients.iter_mut() {
        if client.subscriptions.iter().any(|s| s == event) {
            if let Err(e) = client
                .ws
                .send(tungstenite::Message::Text(payload.to_string()))
            {
                log::warn!("WS 发送失败 ({}): {e}", client.extension_name);
            }
        }
    }
}

/// 向新连接客户端重放已缓存的事件（每个事件类型最近一条）。
fn replay_events(
    ws: &mut tungstenite::WebSocket<std::net::TcpStream>,
    subscriptions: &[String],
    last_events: &HashMap<String, String>,
) {
    for sub in subscriptions {
        if let Some(payload) = last_events.get(sub) {
            if let Err(e) = ws.send(tungstenite::Message::Text(payload.clone())) {
                log::warn!("WS 事件重放失败 ({sub}): {e}");
            } else {
                log::info!("WS 事件重放: {sub}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_handshake_slots_are_bounded_and_released() {
        let active = Arc::new(AtomicUsize::new(0));
        let mut slots = Vec::new();
        for _ in 0..MAX_PENDING_WS_HANDSHAKES {
            slots.push(try_acquire_handshake_slot(&active).unwrap());
        }
        assert!(try_acquire_handshake_slot(&active).is_none());
        slots.pop();
        assert!(try_acquire_handshake_slot(&active).is_some());
    }

    #[test]
    fn websocket_auth_messages_have_a_small_fixed_limit() {
        assert!(MAX_WS_MESSAGE_BYTES <= 64 * 1024);
        assert!(MAX_PENDING_WS_HANDSHAKES < MAX_AUTHENTICATED_WS_CLIENTS);
    }
}
