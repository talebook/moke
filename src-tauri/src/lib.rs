use tauri::Manager;

/// 阅读器资源在打包后相对于 `resource_dir` 的相对路径。
///
/// readest 阅读器作为一份打包资源随 Moke 一起发布（见 tauri.conf.json
/// 的 `bundle.resources`）。把路径集中在这里，后续想更换阅读器（例如换成
/// 别的阅读器程序）只需替换 `resources/reader/` 下的可执行文件，并改这一处常量。
#[cfg(target_os = "windows")]
const READER_RELATIVE_PATH: &str = "reader/readest.exe";
#[cfg(not(target_os = "windows"))]
const READER_RELATIVE_PATH: &str = "reader/readest";

/// 统一的“打开阅读器”入口。
///
/// 前端只调用这一个命令；它负责定位随应用打包的阅读器程序，并以独立窗口
/// （独立进程）方式打开指定的书籍文件。这样两个应用在编译/打包时合为一个
/// 安装包，同时阅读器仍然在自己的窗口中呈现，且保留了清晰的调用关系，便于
/// 后续整体替换阅读器。
#[tauri::command]
async fn open_reader(app: tauri::AppHandle, file_path: String) -> Result<(), String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法定位资源目录: {e}"))?;

    let reader_path = resource_dir.join(READER_RELATIVE_PATH);

    if !reader_path.exists() {
        return Err(format!(
            "未找到打包的阅读器程序: {}",
            reader_path.display()
        ));
    }

    // 以独立进程启动阅读器，把书籍文件路径作为参数传入。
    // readest 本身是一个独立的 GUI 程序，会在自己的窗口中打开书籍。
    std::process::Command::new(&reader_path)
        .arg(&file_path)
        .spawn()
        .map_err(|e| format!("启动阅读器失败: {e}"))?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_reader])
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri_plugin_shell::ShellExt;
                let _ = app.shell();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
