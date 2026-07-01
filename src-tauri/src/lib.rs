/// Moke 桌面客户端入口。
///
/// 阅读器（readest）的 Rust 后端通过 `readestlib` 以库形式编译进本应用：
/// - 基础插件（fs/http/os/shell/opener）由 moke 自己注册，供两端复用；
/// - 其余阅读器专用插件由 `readestlib::register_reader_plugins` 统一注册；
/// - 阅读器前端以"裸命令名"调用的所有后端命令（含 `open_reader`）由
///   `readestlib::reader_invoke_handler()` 一次性挂到应用级 handler。
///
/// `open_reader` 现在在进程内新开阅读器窗口（不再 spawn 外部 exe），因此整个
/// 应用最终只产出一个二进制。前端调用方式 `invoke('open_reader', { filePath })`
/// 保持不变。更换阅读器只需替换 `readestlib` 依赖与 `/readest` 前端产物。
///
/// 拓展系统：通过 `extensions` 模块管理拓展的发现、生命周期、存储。
/// 拓展以独立进程方式运行，通过本地 HTTP + WebSocket 与主程序通信。

mod extensions;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init());

    // 注册阅读器（readest）后端额外依赖的插件（dialog / turso / native-tts 等）。
    let builder = readestlib::register_reader_plugins(builder);

    // 合并拓展系统的 Tauri commands 与 readest 的命令 handler。
    // 拓展命令以 "ext_" 为前缀，readest 命令不包含此前缀，
    // 通过命令名分派到对应的 handler，避免 Invoke 被移动两次。
    builder
        .invoke_handler({
            let reader_handler = readestlib::reader_invoke_handler();
            let ext_handler = extensions::invoke_handler();
            move |invoke| {
                let cmd = invoke.message.command().to_string();
                if cmd.starts_with("ext_") {
                    ext_handler(invoke)
                } else {
                    reader_handler(invoke)
                }
            }
        })
        .setup(|app| {
            // 初始化阅读器相关的进程内状态（如 Discord Rich Presence 客户端）。
            readestlib::manage_reader_state(app.handle());

            // 初始化拓展系统
            extensions::init(app.handle());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
