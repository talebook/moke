//! 拓展持久化存储：按拓展隔离的键值存储。
//!
//! 每个拓展的存储在 `{extensions_dir}/{name}/storage.json`。
//! key 只能包含 `[a-zA-Z0-9_.-]` 且最长 128 字符。
//! value 为任意字符串，最长 64 KB。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// 每个拓展存储的最大键数量。
const MAX_KEYS: usize = 1000;
/// 单个 value 的最大字节数（64 KB）。
const MAX_VALUE_LEN: usize = 64 * 1024;
/// key 的最大长度。
const MAX_KEY_LEN: usize = 128;

// ---------------------------------------------------------------------------
// 公开接口
// ---------------------------------------------------------------------------

/// 读取拓展存储中的一个键。
pub fn get(ext_dir: &Path, key: &str) -> Result<Option<String>, String> {
    validate_key(key)?;

    let storage = read_storage(ext_dir)?;
    Ok(storage.get(key).cloned())
}

/// 写入一个键值对到拓展存储。
pub fn set(ext_dir: &Path, key: &str, value: &str) -> Result<(), String> {
    validate_key(key)?;

    if value.len() > MAX_VALUE_LEN {
        return Err(format!(
            "value 过长（{} 字节，超过上限 {MAX_VALUE_LEN} 字节）",
            value.len()
        ));
    }

    let mut storage = read_storage(ext_dir)?;

    if storage.len() >= MAX_KEYS && !storage.contains_key(key) {
        return Err(format!("存储键数已达上限（{MAX_KEYS}）"));
    }

    storage.insert(key.to_string(), value.to_string());
    write_storage(ext_dir, &storage)?;

    Ok(())
}

/// 删除拓展存储中的一个键。
pub fn delete(ext_dir: &Path, key: &str) -> Result<(), String> {
    validate_key(key)?;

    let mut storage = read_storage(ext_dir)?;
    storage.remove(key);
    write_storage(ext_dir, &storage)?;

    Ok(())
}

/// 列出拓展存储中的所有键。
pub fn list_keys(ext_dir: &Path) -> Result<Vec<String>, String> {
    let storage = read_storage(ext_dir)?;
    Ok(storage.keys().cloned().collect())
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

fn storage_path(ext_dir: &Path) -> PathBuf {
    ext_dir.join("storage.json")
}

fn read_storage(ext_dir: &Path) -> Result<HashMap<String, String>, String> {
    let path = storage_path(ext_dir);
    if !path.exists() {
        return Ok(HashMap::new());
    }

    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("无法读取存储文件: {e}"))?;

    // 安全：限制文件大小（防止恶意超大文件）
    if raw.len() > 10 * 1024 * 1024 {
        // 10 MB
        return Err("存储文件过大（超过 10 MB）".into());
    }

    let storage: HashMap<String, String> = serde_json::from_str(&raw)
        .map_err(|e| format!("存储文件 JSON 解析失败: {e}"))?;

    // 校验所有 key
    for key in storage.keys() {
        validate_key(key)?;
    }

    Ok(storage)
}

fn write_storage(ext_dir: &Path, storage: &HashMap<String, String>) -> Result<(), String> {
    let path = storage_path(ext_dir);

    // 确保目录存在
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建存储目录失败: {e}"))?;
    }

    let json =
        serde_json::to_string_pretty(storage).map_err(|e| format!("序列化存储失败: {e}"))?;

    // 原子写入：先写临时文件再替换
    let tmp_path = ext_dir.join("storage.tmp");
    std::fs::write(&tmp_path, &json).map_err(|e| format!("写入临时存储文件失败: {e}"))?;
    std::fs::rename(&tmp_path, &path).map_err(|e| format!("替换存储文件失败: {e}"))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// 安全校验
// ---------------------------------------------------------------------------

/// 校验存储 key：只允许 `[a-zA-Z0-9_.-]`，最长 128 字符。
/// 禁止路径穿越字符（`/`、`\`、`..`）。
pub fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("key 不能为空".into());
    }
    if key.len() > MAX_KEY_LEN {
        return Err(format!("key 过长（超过 {MAX_KEY_LEN} 字符）"));
    }
    if key.contains("..") {
        return Err("key 包含非法字符「..」".into());
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
    {
        return Err(format!("key「{key}」包含非法字符（只允许字母、数字、下划线、点、连字符）"));
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
    fn test_validate_key_valid() {
        assert!(validate_key("my_key").is_ok());
        assert!(validate_key("config.v1").is_ok());
        assert!(validate_key("last-page-42").is_ok());
    }

    #[test]
    fn test_validate_key_rejects_traversal() {
        assert!(validate_key("../../../etc/passwd").is_err());
        assert!(validate_key("a/../b").is_err());
        assert!(validate_key("..config").is_err());
    }

    #[test]
    fn test_validate_key_rejects_empty() {
        assert!(validate_key("").is_err());
    }

    #[test]
    fn test_validate_key_rejects_too_long() {
        let long_key = "a".repeat(129);
        assert!(validate_key(&long_key).is_err());
    }

    #[test]
    fn test_validate_key_rejects_chinese() {
        assert!(validate_key("中文键").is_err());
    }
}
