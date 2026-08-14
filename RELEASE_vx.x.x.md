# Moke v1.0.0

## 优化与修复

- 补全本地阅读记录同步：成功打开已下载书籍后会更新 Talebook 阅读历史与阅读次数，并增加“打开中”状态以避免重复操作。
- 优化 Android 与 iOS 的安全区域适配，修复沉浸式页面内容和提示消息被系统状态栏遮挡的问题。
- 调整欢迎页演示书库入口，点击后改为复制演示地址，避免误触时直接连接书库。
- 优化服务器异常响应处理：当 Talebook 服务或中间网关返回非 JSON 内容时，不再暴露底层解析错误，并提供更清晰、便于排查问题的提示。
- 加固书籍简介解析，安全处理嵌套或编码的 HTML 标签及异常字符实体，同时保留正文中的比较符号等内容。
- 修复 `moke-ext` 扩展构建命令的 ESM 语法问题，提升 Windows 扩展打包的可靠性。

## 下载

| 平台 | 安装包 |
|---|---|
| Windows | `Moke_1.0.0_x64_en-US.msi` / `.exe` |
| macOS | `Moke_1.0.0_aarch64.dmg` |
| Linux | `Moke_1.0.0_amd64.AppImage` / `.deb` |
| Android | `moke-android-release.apk` |
| iOS/iPadOS | `Moke.ipa`（自签名安装） |
| OpenHarmony（鸿蒙） | `entry-default-unsigned.hap`（alpha，未签名，可能需要自签名安装） |

> 系统要求：Windows 10 1809+ / macOS 11+ / Linux（glibc 2.31+）/ Android 8+ / iOS/iPadOS 17+ / HarmonyOS NEXT 5.0+（API 12）

> ⚠️ OpenHarmony（鸿蒙）HAP 目前为 **alpha 版本**，Bug 较多，仅建议在测试设备上体验；安装包未签名，可能需要自签名安装。

## 反馈

遇到问题或建议请提交 [GitHub Issues](https://github.com/talebook/moke/issues)。安全漏洞请通过[私密报告](https://github.com/talebook/moke/security/advisories/new)提交。

**Full Changelog**: https://github.com/talebook/moke/compare/v0.2.5...v1.0.0
