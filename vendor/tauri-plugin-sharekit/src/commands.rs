use tauri::AppHandle;
use tauri::{command, Runtime, WebviewWindow};

use crate::models::*;
use crate::ShareExt;

#[command]
pub async fn share_text<R: Runtime>(
    app_handle: AppHandle<R>,
    window: WebviewWindow<R>,
    text: String,
    mime_type: Option<String>,
    position: Option<SharePosition>,
) -> Result<(), String> {
    app_handle
        .share()
        .share_text(
            window,
            text,
            ShareTextOptions {
                mime_type,
                position,
            },
        )
        .map_err(|e| e.to_string())
}

#[command]
pub async fn share_file<R: Runtime>(
    app_handle: AppHandle<R>,
    window: WebviewWindow<R>,
    url: String,
    mime_type: Option<String>,
    title: Option<String>,
    position: Option<SharePosition>,
) -> Result<(), String> {
    app_handle
        .share()
        .share_file(
            window,
            url,
            ShareFileOptions {
                mime_type,
                title,
                position,
            },
        )
        .map_err(|e| e.to_string())
}
