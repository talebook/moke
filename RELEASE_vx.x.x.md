# Moke v1.0.7

## 优化与修复

- 将内嵌 Readest 更新到最新上游版本，并重新应用 Moke v1.0.3 使用的定制改动。
- 合入 Readest 启动失败恢复逻辑，避免初始化异常后持续显示白屏。
- 保留 Android 内嵌阅读器原生导航、调试面板、阅读进度与标注同步功能。
- 保留进入内嵌阅读器时的应用切换动画，并同步更新 foliate-js 依赖与 PDF 资源路径适配。

## 下载

| 平台 | 安装包 |
|---|---|
| Windows | `Moke_1.0.7_x64_en-US.msi` / `.exe` |
| macOS | `Moke_1.0.7_aarch64.dmg` |
| Linux | `Moke_1.0.7_amd64.AppImage` / `.deb` |
| Android | `moke-android-release.apk` |
| iOS/iPadOS | `Moke.ipa`（自签名安装） |
| OpenHarmony（鸿蒙） | `entry-default-unsigned.hap`（alpha，未签名，可能需要自签名安装） |

> 系统要求：Windows 10 1809+ / macOS 11+ / Linux（glibc 2.31+）/ Android 8+ / iOS/iPadOS 17+ / HarmonyOS NEXT 5.0+（API 12）

> ⚠️ OpenHarmony（鸿蒙）HAP 目前为 **alpha 版本**，Bug 较多，仅建议在测试设备上体验；安装包未签名，可能需要自签名安装。

## 反馈

遇到问题或建议请提交 [GitHub Issues](https://github.com/talebook/moke/issues)。安全漏洞请通过[私密报告](https://github.com/talebook/moke/security/advisories/new)提交。

**Full Changelog**: https://github.com/talebook/moke/compare/v1.0.6...v1.0.7
