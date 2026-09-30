//! 拓展权限校验。
//!
//! 根据启用时经用户确认的权限快照校验，不再读取可被运行中篡改的 manifest。

use super::EnabledExtension;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// 检查拓展是否声明了指定权限。
///
/// 从启用时确认的内存快照读取 permissions 字段进行匹配。
pub fn check_permission(
    enabled: &Arc<Mutex<HashMap<String, EnabledExtension>>>,
    ext_name: &str,
    required: &str,
) -> Result<(), String> {
    let enabled = enabled.lock().unwrap();
    let extension = enabled
        .get(ext_name)
        .ok_or_else(|| format!("拓展「{ext_name}」未启用"))?;
    let has_permission = extension.permissions.iter().any(|permission| permission == required);

    if !has_permission {
        return Err(format!("拓展「{ext_name}」未声明权限「{required}」"));
    }

    Ok(())
}
