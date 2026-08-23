# Moke v1.0.4

## 优化与修复

- 修复 Android 进入内嵌 Readest 阅读器后持续白屏、调试面板按钮无法显示的问题。
- 修复 Android 与 iOS 构建错误包含桌面文件夹选择器的问题。
- 优化默认离线下载路径，统一使用 AppData 相对路径，并增强原生索引恢复和文件访问权限。
- 减少安装包中的阅读器 sourcemap，并清理无用的构建中间产物，降低产物和缓存体积。

## 下载

| 平台 | 安装包 |
|---|---|
| Windows | `Moke_1.0.4_x64_en-US.msi` / `.exe` |
| macOS | `Moke_1.0.4_aarch64.dmg` |
| Linux | `Moke_1.0.4_amd64.AppImage` / `.deb` |
| Android | `moke-android-release.apk` |
| iOS/iPadOS | `Moke.ipa`（自签名安装） |
| OpenHarmony（鸿蒙） | `entry-default-unsigned.hap`（alpha，未签名，可能需要自签名安装） |

> 系统要求：Windows 10 1809+ / macOS 11+ / Linux（glibc 2.31+）/ Android 8+ / iOS/iPadOS 17+ / HarmonyOS NEXT 5.0+（API 12）

> ⚠️ OpenHarmony（鸿蒙）HAP 目前为 **alpha 版本**，Bug 较多，仅建议在测试设备上体验；安装包未签名，可能需要自签名安装。

## 反馈

遇到问题或建议请提交 [GitHub Issues](https://github.com/talebook/moke/issues)。安全漏洞请通过[私密报告](https://github.com/talebook/moke/security/advisories/new)提交。

**Full Changelog**: https://github.com/talebook/moke/compare/v1.0.3...v1.0.4
