# Moke v1.0.8

## 优化与修复

- 修复 Android 内嵌 Readest 启动时无法检查应用配置和缓存根目录、导致初始化失败白屏的问题。
- Readest 原生服务初始化失败时显示具体错误和重试入口，不再永久白屏。
- 调试面板在原生服务初始化阶段也会挂载，便于直接查看启动错误。
- 保留进入内嵌阅读器时的应用切换动画，以及原有阅读进度、标注同步等 Moke 定制功能。

## 下载

| 平台 | 安装包 |
|---|---|
| Windows | `Moke_1.0.8_x64_en-US.msi` / `.exe` |
| macOS | `Moke_1.0.8_aarch64.dmg` |
| Linux | `Moke_1.0.8_amd64.AppImage` / `.deb` |
| Android | `moke-android-release.apk` |
| iOS/iPadOS | `Moke.ipa`（自签名安装） |
| OpenHarmony（鸿蒙） | `entry-default-unsigned.hap`（alpha，未签名，可能需要自签名安装） |

> 系统要求：Windows 10 1809+ / macOS 11+ / Linux（glibc 2.31+）/ Android 8+ / iOS/iPadOS 17+ / HarmonyOS NEXT 5.0+（API 12）

> ⚠️ OpenHarmony（鸿蒙）HAP 目前为 **alpha 版本**，Bug 较多，仅建议在测试设备上体验；安装包未签名，可能需要自签名安装。

## 反馈

遇到问题或建议请提交 [GitHub Issues](https://github.com/talebook/moke/issues)。安全漏洞请通过[私密报告](https://github.com/talebook/moke/security/advisories/new)提交。

**Full Changelog**: https://github.com/talebook/moke/compare/v1.0.7...v1.0.8
