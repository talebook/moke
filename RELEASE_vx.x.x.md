新增

- 新增离线下载管理中心，支持暂停、继续、删除、断点恢复、多格式书籍及任务状态持久化，并修复异常退出、磁盘索引恢复和重复下载问题。
- 内嵌 Readest 升级至最新上游版本，更新 foliate-js 与 PDF 资源适配，并保留阅读进度、标注同步、调试日志和 Moke 本地模式等定制功能。
- 修复 Android 内嵌阅读器启动白屏、本地文件分片请求悬空、加载动画不结束、原生导航返回及调试面板状态恢复问题。
- 修复 Windows 内嵌阅读器应用配置目录权限和 LocalSend 命令注册问题，确保设置保存及本地传输服务正常工作。
- 完善 Android 书籍分片响应、超时、异常头信息、并发范围读取和初始化失败的回归覆盖，协议异常时不再无限等待。
- 加固阅读记录、阅读进度和标注能力探测流程，修复请求超时、监听清理、导航完成事件、缓存重试及游客模式接口调用问题。
- 统一 Talebook 与 Moke 标注来源、客户端标识和响应契约，并修复扩展命令 `request_id` 关联、响应契约及并发请求隔离。
- 新增跨 Moke 与 Readest 的调试日志持久化和同步能力，过滤框架噪声，同时保留真实错误信息。
- 加固书籍简介、验证码和服务端内容处理，避免恶意标签、非预期脚本执行及敏感响应日志泄露。
- 统一 Windows、Linux、macOS、Android、iOS/iPadOS 的应用名称和发布产物名称，并完善 OpenHarmony 构建支持。
- 优化移动端状态栏、返回手势、分屏安全区、低高度隐私弹窗、长书库标题、侧边栏图标及应用缩放体验。
- 收紧 Tauri capabilities、CSP、asset protocol 与文件系统访问范围，升级存在安全告警的依赖，并减少安装包和中间构建产物体积。

## 下载

| 平台              | 安装包                                               |
| --------------- | ------------------------------------------------- |
| Windows         | `Moke_1.1.0_x64_en-US.msi` / `.exe`               |
| macOS           | `Moke_1.1.0_aarch64.dmg`                          |
| Linux           | `Moke_1.1.0_amd64.AppImage` / `.deb`              |
| Android         | `moke-android-release.apk`                        |
| iOS/iPadOS      | `Moke.ipa`（自签名安装）                                 |
| OpenHarmony（鸿蒙） | `entry-default-unsigned.hap`（alpha，未签名，可能需要自签名安装） |

> 系统要求：Windows 10 1809+ / macOS 11+ / Linux（glibc 2.31+）/ Android 8+ / iOS/iPadOS 17+ / HarmonyOS NEXT 5.0+（API 12）

> ⚠️ OpenHarmony（鸿蒙）HAP 目前为 **alpha 版本**，Bug 较多，仅建议在测试设备上体验；安装包未签名，可能需要自签名安装。

## 反馈

遇到问题或建议请提交 [GitHub Issues](https://github.com/talebook/moke/issues)。安全漏洞请通过[私密报告](https://github.com/talebook/moke/security/advisories/new)提交。

**Full Changelog**: [https://github.com/talebook/moke/compare/v1.0.2...v1.1.0](https://github.com/talebook/moke/compare/v1.0.2...v1.1.0)
