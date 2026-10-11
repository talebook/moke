#![allow(dead_code)]
struct EnabledExtension {
    token: String,
    port: u16,
    backend: std::sync::Mutex<Option<std::process::Child>>,
}
#[path = "../../../src-tauri/src/extensions/deadline_stream.rs"]
mod deadline_stream;
#[path = "../../../src-tauri/src/extensions/events.rs"]
mod events;
#[path = "../../../src-tauri/src/extensions/http_transport.rs"]
mod http_transport;
