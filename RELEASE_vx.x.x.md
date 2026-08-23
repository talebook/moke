# Moke v1.0.5

## 优化与修复

- 修复安全权限拆分后，Android 内嵌 Readest 因无法检查和创建应用私有目录而启动失败、持续白屏且调试面板按钮不显示的问题。
- 保持 Moke 下载书籍目录只读，并将新增权限限制在 Readest 的设置、缓存和应用私有目录。

## 下载

| 平台 | 安装包 |
|---|---|
| Windows | `Moke_1.0.5_x64_en-US.msi` / `.exe` |
| macOS | `Moke_1.0.5_aarch64.dmg` |
| Linux | `Moke_1.0.5_amd64.AppImage` / `.deb` |
| Android | `moke-android-release.apk` |
| iOS/iPadOS | `Moke.ipa`（自签名安装） |
| OpenHarmony（鸿蒙） | `entry-default-unsigned.hap`（alpha，未签名，可能需要自签名安装） |

> 系统要求：Windows 10 1809+ / macOS 11+ / Linux（glibc 2.31+）/ Android 8+ / iOS/iPadOS 17+ / HarmonyOS NEXT 5.0+（API 12）

> ⚠️ OpenHarmony（鸿蒙）HAP 目前为 **alpha 版本**，Bug 较多，仅建议在测试设备上体验；安装包未签名，可能需要自签名安装。

## 反馈

遇到问题或建议请提交 [GitHub Issues](https://github.com/talebook/moke/issues)。安全漏洞请通过[私密报告](https://github.com/talebook/moke/security/advisories/new)提交。

**Full Changelog**: https://github.com/talebook/moke/compare/v1.0.4...v1.0.5
