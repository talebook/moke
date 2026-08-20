# Moke v1.0.1

## 新增

- 新增《Moke 隐私政策》与首次启动隐私确认：只有在用户同意后才会连接 Talebook 服务器和同步书库数据，并支持随时从设置页查看政策、撤回同意。

## 优化与修复

- 完善 Android 系统返回键交互：在应用内按返回键可正常返回上一页，在首页连续按两次即可退出应用。
- 优化 Android 与 iOS 的安全区域适配，修复冷启动时页面内容可能被系统状态栏遮挡的问题。
- 优化全平台应用图标背景，修复部分系统中图标边缘留白的问题。

## 下载

| 平台 | 安装包 |
|---|---|
| Windows | `Moke_1.0.1_x64_en-US.msi` / `.exe` |
| macOS | `Moke_1.0.1_aarch64.dmg` |
| Linux | `Moke_1.0.1_amd64.AppImage` / `.deb` |
| Android | `moke-android-release.apk` |
| iOS/iPadOS | `Moke.ipa`（自签名安装） |
| OpenHarmony（鸿蒙） | `entry-default-unsigned.hap`（alpha，未签名，可能需要自签名安装） |

> 系统要求：Windows 10 1809+ / macOS 11+ / Linux（glibc 2.31+）/ Android 8+ / iOS/iPadOS 17+ / HarmonyOS NEXT 5.0+（API 12）

> ⚠️ OpenHarmony（鸿蒙）HAP 目前为 **alpha 版本**，Bug 较多，仅建议在测试设备上体验；安装包未签名，可能需要自签名安装。

## 反馈

遇到问题或建议请提交 [GitHub Issues](https://github.com/talebook/moke/issues)。安全漏洞请通过[私密报告](https://github.com/talebook/moke/security/advisories/new)提交。

**Full Changelog**: https://github.com/talebook/moke/compare/v1.0.0...v1.0.1
