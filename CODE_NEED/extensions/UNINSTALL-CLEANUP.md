# Moke 主程序卸载时的拓展清理

## 问题

当用户卸载 Moke 主程序时，拓展目录 `%APPDATA%\com.moke.client\extensions\` 不会被自动清理。
这会导致：
- 遗留的拓展文件占用磁盘空间
- 重装 Moke 后旧的拓展被恢复运行（runtime.json 仍然存在）

## 解决方案

### 方案 A：NSIS 卸载脚本（推荐，与当前打包方式一致）

在 Moke 的 NSIS 卸载区段中添加：

```nsis
Section "Uninstall"
  ; ... Moke 自身的卸载逻辑 ...

  ; 清理拓展目录
  RMDir /r "$APPDATA\com.moke.client\extensions"

  ; 询问用户是否保留个人数据
  ; MessageBox MB_YESNO "是否同时删除拓展和个人数据？" IDYES cleanup
  ; RMDir /r "$APPDATA\com.moke.client"

  ; cleanup:
  DeleteRegKey HKCU "Software\Moke\Extensions"
SectionEnd
```

### 方案 B：应用启动时垃圾回收（辅助方案）

在 Moke 的 `extensions::init()` 中增加：

```rust
// 清理已卸载但残留注册表项的拓展
fn cleanup_orphaned_registry_entries() {
    // 遍历 HKCU\Software\Moke\Extensions
    // 如果对应的目录不存在 → 删除注册表项
}
```

### 实施

在 `src-tauri/tauri.conf.json` 的 `bundle.windows.nsis` 中配置 install/uninstall hooks：

```json
{
  "bundle": {
    "windows": {
      "nsis": {
        "installMode": "currentUser",
        "installerHooks": "nsis/installer-hooks.nsh"
      }
    }
  }
}
```

需要创建 `src-tauri/nsis/installer-hooks.nsh`，在其中添加卸载时的清理逻辑。

## 临时措施

在正式 NSIS 配置完成前，Moke 的 `init()` 函数在恢复运行时状态时会自动跳过已经不存在的拓展（见 `lifecycle.rs` 的 `restore_runtime_state`）。因此即使遗留目录未被物理删除，已卸载的拓展也不会被重新激活。

用户也可以手动删除 `%APPDATA%\com.moke.client\extensions\` 目录来彻底清理。
