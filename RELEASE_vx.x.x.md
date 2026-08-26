# Moke v1.0.10

这是从 `v1.0.2` 升级到 `v1.0.10` 的累计版本，包含此前 `v1.0.3` 至 `v1.0.9` 的全部代码更改。

## 内嵌阅读器

- 将内嵌 Readest 升级到 `v0.12.1`，随后同步到最新上游版本，并更新 foliate-js 与 PDF 资源适配。
- 修复 Android 内嵌阅读器无法检查应用配置、缓存和私有目录而启动白屏的问题。
- 修复 Android 打开书籍时本地文件分片请求悬空、阅读器一直停留在加载动画的问题。
- 修复 Android 单 WebView 阅读器的进入、返回和原生导航流程，并允许阅读器更新窗口标题。
- 保留进入和退出阅读器时的应用切换动画。
- Readest 原生服务初始化失败时显示具体错误和重试入口，同时保留右下角调试面板按钮。
- 修复调试 IPC 递归、窗口创建降级时阅读进度丢失，以及标注定位与进度事件关联问题。
- 保留阅读进度、标注同步、调试日志和 Moke 本地模式等定制功能。

## 离线下载与阅读记录

- 新增离线下载管理中心，支持暂停、继续、删除、断点恢复、多格式书籍和任务状态持久化。
- 修复 IndexedDB 升级、异常退出恢复、磁盘文件索引恢复和重复下载状态问题。
- Tauri 默认下载改用 AppData 相对路径，并稳定二进制、Range 和大文件下载流程。
- 修复阅读记录请求的超时、响应清理和失败生命周期，避免成功打开被误报为失败。
- 游客模式不再请求需要登录的书籍标注接口。

## 标注、扩展与内容处理

- 统一 Talebook 与 Moke 标注来源、客户端标识和响应契约。
- 加固标注能力探测、缓存、重试、导航完成事件和迟到监听清理。
- 修复扩展命令 `request_id` 关联、响应契约和并发请求隔离。
- 加固书籍简介的 HTML 转纯文本处理、异常恢复及恶意标签过滤。
- 阻止服务端验证码和电子书内容中的非预期脚本执行。

## 平台体验与安全

- 统一并本地化 Windows、Linux、macOS、Android、iOS/iPadOS 的应用名称和发布产物名称。
- 修复 Android 状态栏恢复、返回手势状态、分屏安全区和应用外壳缩放问题。
- 优化移动端低高度隐私弹窗、长书库标题和侧边栏图标显示。
- 收紧 Tauri capabilities、CSP、asset protocol 与文件系统访问范围，保持 Moke 下载书籍目录只读。
- 升级存在安全告警的前端与 Rust 依赖，并减少安装包和中间构建产物体积。

## 下载

| 平台 | 安装包 |
|---|---|
| Windows | `Moke_1.0.10_x64_en-US.msi` / `.exe` |
| macOS | `Moke_1.0.10_aarch64.dmg` |
| Linux | `Moke_1.0.10_amd64.AppImage` / `.deb` |
| Android | `moke-android-release.apk` |
| iOS/iPadOS | `Moke.ipa`（自签名安装） |
| OpenHarmony（鸿蒙） | `entry-default-unsigned.hap`（alpha，未签名，可能需要自签名安装） |

> 系统要求：Windows 10 1809+ / macOS 11+ / Linux（glibc 2.31+）/ Android 8+ / iOS/iPadOS 17+ / HarmonyOS NEXT 5.0+（API 12）

> ⚠️ OpenHarmony（鸿蒙）HAP 目前为 **alpha 版本**，Bug 较多，仅建议在测试设备上体验；安装包未签名，可能需要自签名安装。

## 反馈

遇到问题或建议请提交 [GitHub Issues](https://github.com/talebook/moke/issues)。安全漏洞请通过[私密报告](https://github.com/talebook/moke/security/advisories/new)提交。

**Full Changelog**: https://github.com/talebook/moke/compare/v1.0.2...v1.0.10
