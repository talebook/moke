//! WebSocket 事件服务器 + Tauri event 桥接。
//!
//! 单线程事件循环：accept 新连接、接收认证/订阅、接收广播、发送消息。
//! 支持事件重放：新客户端订阅时，立即回放最近一次该类型事件的缓存数据。

use super::{deadline_stream::DeadlineStream, EnabledExtension};
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
    ws: tungstenite::WebSocket<DeadlineStream>,
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
    perform_handshake_with_deadline(
        stream,
        enabled,
        std::time::Instant::now() + WS_HANDSHAKE_TIMEOUT,
    )
}

fn perform_handshake_with_deadline(
    stream: std::net::TcpStream,
    enabled: &Arc<Mutex<HashMap<String, EnabledExtension>>>,
    deadline: std::time::Instant,
) -> Result<Client, String> {
    stream
        .set_nonblocking(false)
        .map_err(|error| format!("设置 WS 阻塞模式失败: {error}"))?;
    let stream = DeadlineStream::new(stream, deadline);

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
    ws: &mut tungstenite::WebSocket<DeadlineStream>,
    enabled: &Arc<Mutex<HashMap<String, EnabledExtension>>>,
) -> Result<(String, Vec<String>), String> {
    // 单条握手消息：同时携带 auth 和 subscriptions
    // 格式: {"type":"hello", "extension":"...", "token":"...", "events":[...]}
    // 循环读取，跳过 Ping/Pong 帧，直到收到 Text/Binary
    let msg = loop {
        ws.get_mut()
            .check_deadline()
            .map_err(|e| format!("握手总时限已到: {e}"))?;
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

    ws.get_mut()
        .check_deadline()
        .map_err(|e| format!("握手总时限已到: {e}"))?;
    ws.get_mut()
        .clear_deadline()
        .map_err(|e| format!("清理握手时限失败: {e}"))?;
    // 设为非阻塞模式，认证后的事件循环不使用握手 deadline。
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
    ws: &mut tungstenite::WebSocket<DeadlineStream>,
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
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpStream};
    use std::time::Instant;

    fn handshake_fixture() -> (
        TcpStream,
        Arc<AtomicUsize>,
        thread::JoinHandle<Result<Client, String>>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let stream = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let active = Arc::new(AtomicUsize::new(0));
        let observed = active.clone();
        let task = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let _slot = try_acquire_handshake_slot(&observed).unwrap();
            let enabled = Arc::new(Mutex::new(HashMap::new()));
            perform_handshake_with_deadline(
                stream,
                &enabled,
                Instant::now() + Duration::from_millis(300),
            )
        });
        (stream, active, task)
    }

    #[test]
    fn silent_and_trickling_upgrade_connections_expire_and_release_the_slot() {
        for trickle in [false, true] {
            let (mut stream, active, task) = handshake_fixture();
            let started = Instant::now();
            let sender = thread::spawn(move || {
                if trickle {
                    for byte in b"GET / HTTP/1.1\r\nHost: localhost\r\n" {
                        if stream.write_all(&[*byte]).is_err() {
                            break;
                        }
                        thread::sleep(Duration::from_millis(20));
                    }
                } else {
                    thread::sleep(Duration::from_millis(450));
                }
            });
            assert!(task.join().unwrap().is_err());
            assert!(started.elapsed() < Duration::from_millis(600));
            assert_eq!(active.load(Ordering::Acquire), 0);
            sender.join().unwrap();
        }
    }

    #[test]
    fn ping_only_or_trickling_auth_frames_cannot_restart_the_upgrade_budget() {
        for trickle in [false, true] {
            let (stream, active, task) = handshake_fixture();
            let started = Instant::now();
            // Spend part of the same deadline before HTTP Upgrade.
            thread::sleep(Duration::from_millis(100));
            let (mut ws, _) = tungstenite::client("ws://localhost/", stream).unwrap();
            let sender = thread::spawn(move || {
                if trickle {
                    // Masked text frame claiming 120 bytes, delivered one byte
                    // at a time. tungstenite performs repeated internal reads.
                    let _ = ws.get_mut().write_all(&[0x81, 0x80 | 120, 1, 2, 3, 4]);
                    for _ in 0..30 {
                        if ws.get_mut().write_all(b"x").is_err() {
                            break;
                        }
                        thread::sleep(Duration::from_millis(20));
                    }
                } else {
                    for _ in 0..30 {
                        if ws.send(tungstenite::Message::Ping(vec![1])).is_err() {
                            break;
                        }
                        thread::sleep(Duration::from_millis(20));
                    }
                }
                let _ = ws.get_mut().shutdown(Shutdown::Both);
            });
            assert!(task.join().unwrap().is_err());
            assert!(started.elapsed() < Duration::from_millis(500));
            assert_eq!(active.load(Ordering::Acquire), 0);
            sender.join().unwrap();
        }
    }

    #[test]
    fn normal_auth_subscription_and_replay_still_use_the_real_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut enabled = HashMap::new();
            enabled.insert(
                "fixture".to_string(),
                EnabledExtension {
                    token: "fixture".to_string(),
                    port: 0,
                    backend: Mutex::new(None),
                },
            );
            let mut client = perform_handshake(stream, &Arc::new(Mutex::new(enabled))).unwrap();
            assert_eq!(client.extension_name, "fixture");
            assert_eq!(client.subscriptions, vec!["reader.test"]);
            let payload = build_payload(&WsBroadcast {
                event: "reader.test".into(),
                data: "{\"value\":42}".into(),
            });
            let events = HashMap::from([("reader.test".to_string(), payload)]);
            replay_events(&mut client.ws, &client.subscriptions, &events);
        });
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let (mut ws, _) = tungstenite::client("ws://localhost/", stream).unwrap();
        ws.send(tungstenite::Message::Text(
            serde_json::json!({
                "type":"hello", "extension":"fixture", "token":"fixture", "events":["reader.test"]
            })
            .to_string(),
        ))
        .unwrap();
        let replay: serde_json::Value =
            serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(replay["event"], "reader.test");
        assert_eq!(replay["data"]["value"], 42);
        server.join().unwrap();
    }

    #[test]
    fn full_handshake_capacity_expires_and_a_legal_client_can_use_the_same_server() {
        let mut enabled = HashMap::new();
        enabled.insert(
            "fixture".to_string(),
            EnabledExtension {
                token: "fixture".to_string(),
                port: 0,
                backend: Mutex::new(None),
            },
        );
        let (port, broadcast) = start(Arc::new(Mutex::new(enabled)), 0);
        let mut stalled = Vec::new();
        for _ in 0..MAX_PENDING_WS_HANDSHAKES {
            let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(7)))
                .unwrap();
            stalled.push(stream);
        }
        let started = Instant::now();
        for stream in &mut stalled {
            let mut bytes = Vec::new();
            assert!(stream.read_to_end(&mut bytes).is_ok());
            assert!(bytes.is_empty());
        }
        assert!(started.elapsed() < Duration::from_secs(7));
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let (mut ws, _) = tungstenite::client("ws://localhost/", stream).unwrap();
        ws.send(tungstenite::Message::Text(
            serde_json::json!({
                "extension":"fixture", "token":"fixture", "events":["reader.test"]
            })
            .to_string(),
        ))
        .unwrap();
        broadcast
            .send(WsBroadcast {
                event: "reader.test".into(),
                data: "{\"value\":42}".into(),
            })
            .unwrap();
        loop {
            match ws.read().unwrap() {
                tungstenite::Message::Ping(data) => {
                    ws.send(tungstenite::Message::Pong(data)).unwrap()
                }
                tungstenite::Message::Text(data) => {
                    assert_eq!(
                        serde_json::from_str::<serde_json::Value>(&data).unwrap()["data"]["value"],
                        42
                    );
                    break;
                }
                other => panic!("unexpected event: {other:?}"),
            }
        }
        let _ = ws.close(None);
    }

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
