# 阅读统计 ZIP 示例

在 Moke 仓库根目录执行 `pnpm install --frozen-lockfile`，然后：

```sh
cd packages/moke-ext/examples/reading-stats
node ../../bin/moke-ext.js build
node ../../bin/moke-ext.js sign --key /path/outside/project/publisher.pem --key-id your-key-id
node ../../bin/moke-ext.js package
```

生成 `reading-stats-1.1.0.zip`。`build` 为当前 Windows/macOS/Linux x86_64/aarch64 目标编译 Rust 后端，写入准确的 `entry.backend.targets`。在其他平台分别构建并签名；不要把 Windows 二进制声明为 Linux。Windows 也可运行 `build.bat` 完成构建，再按提示签名与打包。

进入 Moke → 扩展 → 导入扩展，选择 ZIP，核对阅读事件/状态等权限并确认。首次安装后点击启用。第三方或示例测试密钥显示“未知发布者”，不会被当作 Moke 官方签名；需确认来源。不要把私钥提交或装入 ZIP。

旧 1.0.0 升级会保留宿主 storage.json 和完整旧目录。新统计数据写入 `MOKE_EXT_DATA_DIR/stats.json`，首次启动从宿主提供的 `MOKE_EXT_LEGACY_DIR/stats.json` 迁移，不覆盖现有数据。旧 NSIS 安装器不再调用，Moke 应用自身安装器不受影响。

浏览器 UI 只访问本扩展同源后端；`MOKE_EXT_TOKEN`、`MOKE_API_PORT`、`MOKE_WS_PORT` 只从后端环境读取，不向浏览器提供 token。

完整包格式、限额和安全边界见 [ZIP 文档](../../../../docs/extension-zip.md)。
