//! 拓展发现：扫描拓展目录，解析并校验 manifest.json。

use super::Manifest;
use std::path::{Path, PathBuf};

/// 一次发现的结果：拓展目录路径 + 已解析的 manifest。
pub struct Discovery {
    #[allow(dead_code)]
    pub dir: PathBuf,
    pub manifest: Manifest,
}

/// 允许的权限白名单。不在白名单中的权限声明将被拒绝。
const KNOWN_PERMISSIONS: &[&str] = &[
    "books.read",
    "books.download",
    "user.profile",
    "server.info",
    "reader.events.subscribe",
    "reader.command.send",
    "reader.state.read",
    "storage",
    "sidebar.add",
    "page.register",
];

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

/// 扫描拓展目录，返回所有合法拓展的发现结果。
/// 非法拓展（manifest 解析失败 / 校验失败）只记录日志，不影响其他拓展。
pub fn discover_extensions(extensions_dir: &Path) -> Vec<Discovery> {
    let mut results = Vec::new();

    let entries = match std::fs::read_dir(extensions_dir) {
        Ok(e) => e,
        Err(_) => return results, // 目录不存在或无法读取
    };

    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }

        let manifest_path = dir.join("manifest.json");
        if !manifest_path.is_file() {
            continue;
        }

        match read_and_validate_manifest(&manifest_path) {
            Ok(manifest) => {
                results.push(Discovery { dir, manifest });
            }
            Err(e) => {
                log::warn!("跳过无效拓展「{}」: {e}", dir.display());
            }
        }
    }

    results
}

// ---------------------------------------------------------------------------
// Manifest 读取与校验
// ---------------------------------------------------------------------------

/// 读取并严格校验 manifest.json。
pub fn read_and_validate_manifest(path: &Path) -> Result<Manifest, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("无法读取 manifest.json: {e}"))?;

    // 文件大小限制：64 KB（防止巨大 JSON 攻击）
    if raw.len() > 64 * 1024 {
        return Err("manifest.json 过大（超过 64 KB）".into());
    }

    let manifest: Manifest = serde_json::from_str(&raw)
        .map_err(|e| format!("manifest.json 解析失败: {e}"))?;

    validate_manifest(&manifest)?;
    Ok(manifest)
}

/// 对 manifest 做安全与合法性校验。
pub fn validate_manifest(manifest: &Manifest) -> Result<(), String> {
    // 1. 名称：只能包含小写字母、数字和连字符，最长 64 字符
    validate_name(&manifest.name)?;

    // 2. 版本：必须是合法 semver
    validate_version(&manifest.version)?;

    // 3. api_version：如填写则必须为 "1"
    if !manifest.api_version.is_empty() && manifest.api_version != "1" {
        return Err(format!(
            "不支持的 api_version「{}」",
            manifest.api_version
        ));
    }

    // 4. display_name：不能为空，最长 128 字符
    if manifest.display_name.is_empty() {
        return Err("display_name 不能为空".into());
    }
    if manifest.display_name.len() > 128 {
        return Err("display_name 过长（超过 128 字符）".into());
    }

    // 5. description：最长 512 字符
    if manifest.description.len() > 512 {
        return Err("description 过长（超过 512 字符）".into());
    }

    // 6. author：最长 128 字符
    if manifest.author.len() > 128 {
        return Err("author 过长（超过 128 字符）".into());
    }

    // 7. permissions：必须在白名单中
    for perm in &manifest.permissions {
        if !KNOWN_PERMISSIONS.contains(&perm.as_str()) {
            return Err(format!("未知权限声明「{perm}」"));
        }
    }

    // 8. entry.backend.executable：禁止路径穿越
    if let Some(entry) = &manifest.entry {
        if let Some(backend) = &entry.backend {
            validate_executable_path(&backend.executable)?;
            // args 中禁止包含换行符（防注入）
            for arg in &backend.args {
                if arg.contains('\n') || arg.contains('\r') {
                    return Err("backend.args 包含非法字符".into());
                }
            }
        }
    }

    // 9. sidebar：基础校验
    if let Some(sidebar) = &manifest.sidebar {
        if sidebar.label.is_empty() || sidebar.label.len() > 64 {
            return Err("sidebar.label 无效（空或超过 64 字符）".into());
        }
        if sidebar.icon.len() > 64 {
            return Err("sidebar.icon 过长".into());
        }
    }

    // 10. lucide_icons：数组长度限制
    if manifest.lucide_icons.len() > 50 {
        return Err("lucide_icons 数量过多（超过 50 个）".into());
    }
    for icon in &manifest.lucide_icons {
        if icon.len() > 64 {
            return Err("lucide_icons 项过长".into());
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// 字段级安全校验
// ---------------------------------------------------------------------------

/// 校验拓展名称：只允许 `[a-z0-9-]+`，最长 64 字符。
/// 防止路径穿越、命令注入等攻击。
pub fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("拓展名称不能为空".into());
    }
    if name.len() > 64 {
        return Err("拓展名称过长（超过 64 字符）".into());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(format!(
            "拓展名称「{name}」包含非法字符（只允许小写字母、数字、连字符）"
        ));
    }
    // 不能以连字符开头或结尾
    if name.starts_with('-') || name.ends_with('-') {
        return Err("拓展名称不能以连字符开头或结尾".into());
    }
    // 不能包含连续的连字符
    if name.contains("--") {
        return Err("拓展名称不能包含连续连字符".into());
    }
    Ok(())
}

/// 校验版本号：必须是 `major.minor.patch` 格式。
fn validate_version(version: &str) -> Result<(), String> {
    if version.is_empty() || version.len() > 64 {
        return Err("版本号格式无效".into());
    }
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() != 3 {
        return Err(format!("版本号「{version}」格式无效，需要 major.minor.patch"));
    }
    for part in &parts {
        if part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()) {
            return Err(format!("版本号「{version}」包含非数字部分"));
        }
        // 每个部分最长 10 位数字
        if part.len() > 10 {
            return Err(format!("版本号「{version}」数字过大"));
        }
    }
    Ok(())
}

/// 校验可执行文件路径：必须是纯文件名（不含路径分隔符、不含 `..`）。
/// 后端可执行文件必须位于拓展目录内。
fn validate_executable_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("backend.executable 不能为空".into());
    }
    if path.len() > 256 {
        return Err("backend.executable 路径过长".into());
    }
    // 禁止路径遍历
    if path.contains("..") {
        return Err("backend.executable 包含非法路径「..」".into());
    }
    // 禁止绝对路径
    if path.starts_with('/') || path.starts_with('\\') {
        return Err("backend.executable 不能使用绝对路径".into());
    }
    // 禁止 Windows 盘符路径
    if path.len() >= 2 && path.as_bytes().get(1) == Some(&b':') {
        return Err("backend.executable 不能使用绝对路径".into());
    }
    // 禁止包含路径分隔符（只允许纯文件名）
    if path.contains('/') || path.contains('\\') {
        return Err("backend.executable 必须为纯文件名（不含路径分隔符）".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_name_valid() {
        assert!(validate_name("reading-stats").is_ok());
        assert!(validate_name("my-extension").is_ok());
        assert!(validate_name("abc123").is_ok());
    }

    #[test]
    fn test_validate_name_rejects_dots() {
        assert!(validate_name("my.extension").is_err());
    }

    #[test]
    fn test_validate_name_rejects_uppercase() {
        assert!(validate_name("MyExtension").is_err());
    }

    #[test]
    fn test_validate_name_rejects_path_traversal() {
        assert!(validate_name("../etc/passwd").is_err());
        assert!(validate_name("a/../../../b").is_err());
    }

    #[test]
    fn test_validate_name_rejects_empty() {
        assert!(validate_name("").is_err());
    }

    #[test]
    fn test_validate_name_rejects_dash_prefix() {
        assert!(validate_name("-test").is_err());
    }

    #[test]
    fn test_validate_name_rejects_double_dash() {
        assert!(validate_name("test--ext").is_err());
    }

    #[test]
    fn test_validate_version_valid() {
        assert!(validate_version("1.0.0").is_ok());
        assert!(validate_version("0.1.0").is_ok());
        assert!(validate_version("10.20.30").is_ok());
    }

    #[test]
    fn test_validate_version_rejects_non_semver() {
        assert!(validate_version("one.two.three").is_err());
        assert!(validate_version("1.0").is_err());
        assert!(validate_version("").is_err());
    }

    #[test]
    fn test_validate_executable_rejects_traversal() {
        assert!(validate_executable_path("../../cmd.exe").is_err());
        assert!(validate_executable_path("a/../b").is_err());
    }

    #[test]
    fn test_validate_executable_rejects_absolute() {
        assert!(validate_executable_path("C:/windows/system32/cmd.exe").is_err());
        assert!(validate_executable_path("/bin/sh").is_err());
    }

    #[test]
    fn test_validate_executable_accepts_simple_name() {
        assert!(validate_executable_path("server.exe").is_ok());
        assert!(validate_executable_path("my-backend").is_ok());
    }
}
