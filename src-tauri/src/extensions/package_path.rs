//! Portable ZIP/digest names: NFC UTF-8, slash separators, bytewise ordering.
use unicode_normalization::UnicodeNormalization;

pub fn validate(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.len() > 1024
        || path.nfc().collect::<String>() != path
        || path.split('/').count() > 32
    {
        return Err(format!("包路径必须为 NFC UTF-8 且长度/深度受限: {path}"));
    }
    for part in path.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.len() > 240
            || part.ends_with(['.', ' '])
            || part.chars().any(|c| {
                c.is_control() || matches!(c, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
            })
        {
            return Err(format!("不安全或不兼容的包路径: {path}"));
        }
        let stem = part.split('.').next().unwrap().to_uppercase();
        if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str())
            || (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(
                    &stem[3..],
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
        {
            return Err(format!("包路径包含 Windows 保留名称: {path}"));
        }
    }
    Ok(())
}

pub fn reserved_root(path: &str) -> bool {
    let first = path.split('/').next().unwrap_or("").to_ascii_lowercase();
    matches!(
        first.as_str(),
        "storage.json"
            | "storage.tmp"
            | "trust.json"
            | "trust.tmp"
            | "runtime.json"
            | "runtime.tmp"
            | "uninstall.exe"
            | "installer.nsi"
    ) || first.starts_with('.')
        || first.ends_with("-setup.exe")
}

pub fn normalized_relative(path: &std::path::Path) -> Result<String, String> {
    let parts: Result<Vec<_>, _> = path
        .components()
        .map(|p| match p {
            std::path::Component::Normal(p) => p.to_str().ok_or("包路径不是 UTF-8"),
            _ => Err("包路径必须是相对路径"),
        })
        .collect();
    let value = parts?.join("/");
    validate(&value)?;
    Ok(value)
}
