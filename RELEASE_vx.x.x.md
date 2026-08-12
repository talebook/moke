# Moke v0.2.5

## 优化与修复

- 修复移动端阅读进度保存问题，并为内嵌阅读器补充返回 Moke 书库的入口，改善移动端阅读与返回体验。
- 优化离线下载任务管理：离开书籍详情页后下载仍可继续，再次进入时可恢复进度并复用同一本书的在途任务。
- 补充阅读器随机访问本地书籍文件所需权限，修复部分 EPUB、MOBI 文件无法正常解析的问题。
- 优化书籍简介展示，将 Talebook 返回的 HTML 内容转换为安全、易读的纯文本。

## 下载

| 平台 | 安装包 |
|---|---|
| Windows | `Moke_0.2.5_x64_en-US.msi` / `.exe` |
| macOS | `Moke_0.2.5_aarch64.dmg` |
| Linux | `Moke_0.2.5_amd64.AppImage` / `.deb` |
| Android | `moke-android-release.apk` |
| iOS/iPadOS | `Moke.ipa`（自签名安装） |
| OpenHarmony（鸿蒙） | `entry-default-unsigned.hap`（alpha，未签名，可能需要自签名安装） |

> 系统要求：Windows 10 1809+ / macOS 11+ / Linux（glibc 2.31+）/ Android 8+ / iOS/iPadOS 17+ / HarmonyOS NEXT 5.0+（API 12）

> ⚠️ OpenHarmony（鸿蒙）HAP 目前为 **alpha 版本**，Bug 较多，仅建议在测试设备上体验；安装包未签名，可能需要自签名安装。

## 反馈

遇到问题或建议请提交 [GitHub Issues](https://github.com/talebook/moke/issues)。安全漏洞请通过[私密报告](https://github.com/talebook/moke/security/advisories/new)提交。

**Full Changelog**: https://github.com/talebook/moke/compare/v0.2.4...v0.2.5
