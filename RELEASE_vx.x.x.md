# Moke v1.0.3

## 新增

- 新增离线下载管理中心：可统一查看下载任务与离线书籍，按状态筛选，并支持暂停、继续、重试、取消、批量清理及打开文件所在位置；管理中心还可查看存储占用，设置页支持选择下载目录。

## 优化与修复

- 优化离线下载稳定性：支持恢复未完成任务、保留可续传的临时文件，并在书籍文件更新或删除后同步刷新本地状态。
- 优化阅读记录与阅读进度同步，避免请求超时、重复操作或晚到事件造成错误记录、无效提示及状态回退。
- 完善笔记与标注联动，统一不同来源的标识与写入结果，并修复游客访问公开书籍时仍请求标注接口的问题。
- 优化 Android 返回动画、状态栏恢复和应用内缩放行为，提升窗口切换、旋转及从阅读器返回时的稳定性。
- 调试日志现可跨 Moke 与内置 Readest 阅读器同步并持久保留，便于复现和排查阅读问题。
- 完善 macOS、Linux 与移动端的系统应用名称本地化，并统一各平台安装包命名。
- 加固验证码脚本、原生权限、内容安全策略与本地文件访问范围，并升级存在安全告警的依赖。
- 更新内置 Readest 阅读器至 v0.12.1，修复阅读器标题更新、进度回传及调试通信等问题。

## 下载

| 平台 | 安装包 |
|---|---|
| Windows | `Moke_1.0.3_x64_en-US.msi` / `.exe` |
| macOS | `Moke_1.0.3_aarch64.dmg` |
| Linux | `Moke_1.0.3_amd64.AppImage` / `.deb` |
| Android | `moke-android-release.apk` |
| iOS/iPadOS | `Moke.ipa`（自签名安装） |
| OpenHarmony（鸿蒙） | `entry-default-unsigned.hap`（alpha，未签名，可能需要自签名安装） |

> 系统要求：Windows 10 1809+ / macOS 11+ / Linux（glibc 2.31+）/ Android 8+ / iOS/iPadOS 17+ / HarmonyOS NEXT 5.0+（API 12）

> ⚠️ OpenHarmony（鸿蒙）HAP 目前为 **alpha 版本**，Bug 较多，仅建议在测试设备上体验；安装包未签名，可能需要自签名安装。

## 反馈

遇到问题或建议请提交 [GitHub Issues](https://github.com/talebook/moke/issues)。安全漏洞请通过[私密报告](https://github.com/talebook/moke/security/advisories/new)提交。

**Full Changelog**: https://github.com/talebook/moke/compare/v1.0.2...v1.0.3
