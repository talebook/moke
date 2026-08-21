# Moke v1.0.2

## 新增

- 新增 Talebook 笔记与标注联动：可在书籍详情页查看来自 Talebook 及外部来源的高亮、笔记、书签和章评，支持按来源筛选、添加笔记，并可将已下载书籍精确定位到标注位置。

## 优化与修复

- 优化 Android 返回交互及页面切换动画，使应用页面与阅读器之间的返回体验更加连贯；墨水屏和减少动态效果模式下仍保持快速切换。
- 修复 Android 分屏模式下页面顶部出现多余偏移的问题，并在窗口模式切换、旋转或恢复应用时自动重新适配安全区域。
- 修复游客打开公开书籍详情时被错误跳转到登录页的问题。
- 优化本地阅读记录写入与重复点击处理，减少打开阅读器时的等待、重复开窗和阅读次数重复记录。
- 加固书籍简介解析，改进异常或嵌套 HTML 内容的过滤与展示。
- 简化首次启动的隐私确认界面，小屏设备也能更方便地完成选择。
- 更新内置 Readest 阅读器，完善标注同步支持。

## 下载

| 平台 | 安装包 |
|---|---|
| Windows | `Moke_1.0.2_x64_en-US.msi` / `.exe` |
| macOS | `Moke_1.0.2_aarch64.dmg` |
| Linux | `Moke_1.0.2_amd64.AppImage` / `.deb` |
| Android | `moke-android-release.apk` |
| iOS/iPadOS | `Moke.ipa`（自签名安装） |
| OpenHarmony（鸿蒙） | `entry-default-unsigned.hap`（alpha，未签名，可能需要自签名安装） |

> 系统要求：Windows 10 1809+ / macOS 11+ / Linux（glibc 2.31+）/ Android 8+ / iOS/iPadOS 17+ / HarmonyOS NEXT 5.0+（API 12）

> ⚠️ OpenHarmony（鸿蒙）HAP 目前为 **alpha 版本**，Bug 较多，仅建议在测试设备上体验；安装包未签名，可能需要自签名安装。

## 反馈

遇到问题或建议请提交 [GitHub Issues](https://github.com/talebook/moke/issues)。安全漏洞请通过[私密报告](https://github.com/talebook/moke/security/advisories/new)提交。

**Full Changelog**: https://github.com/talebook/moke/compare/v1.0.1...v1.0.2
