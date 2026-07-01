//! 拓展权限校验。
//!
//! 根据 manifest.json 中声明的 permissions 字段，校验拓展是否拥有指定权限。

use std::path::Path;

/// 检查拓展是否声明了指定权限。
///
/// 从拓展目录中的 manifest.json 读取 permissions 字段进行匹配。
pub fn check_permission(ext_name: &str, required: &str, extensions_dir: &Path) -> Result<(), String> {
    let manifest_path = extensions_dir.join(ext_name).join("manifest.json");

    let raw = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("无法读取 manifest.json: {e}"))?;

    let manifest: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("manifest.json 解析失败: {e}"))?;

    let permissions = manifest["permissions"]
        .as_array()
        .ok_or("manifest.json 缺少 permissions 字段")?;

    let has_permission = permissions
        .iter()
        .any(|p| p.as_str() == Some(required));

    if !has_permission {
        return Err(format!("拓展「{ext_name}」未声明权限「{required}」"));
    }

    Ok(())
}
