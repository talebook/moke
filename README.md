# Moke

**Moke** 是 [Talebook](https://github.com/talebook/talebook) 自托管电子书服务器的桌面客户端。在电脑上浏览、搜索、下载你的电子书库，内嵌专业阅读器，离线也能随时打开阅读。

## 功能

- **书库浏览** — 按分类、标签、作者、出版商等方式浏览服务器上的电子书
- **元数据搜索** — 快速检索书名、作者、简介等元数据
- **离线下载** — 将书籍下载到本地，断网也能阅读
- **专业阅读** — 内嵌 readest 阅读器，支持 EPUB、PDF 等多种格式
- **局域网友好** — 支持自签名证书和纯 HTTP 局域网服务器
- **完整认证** — 支持访问码、登录、注册等 Talebook 服务器的全部认证方式

## 安装

从 [Releases](../../releases) 页面下载对应平台的安装包：

| 平台 | 安装包格式 |
|---|---|
| Windows | `.msi` / `.exe` |
| macOS | `.dmg` |
| Linux | `.AppImage` / `.deb` |
| Android | `.apk` |
| iOS/iPadOS | `.ipa`（自签名安装，需将设备 UDID 加入开发者描述文件） |
| OpenHarmony（鸿蒙） | `.hap`（alpha，未签名，可能需要自签名安装） |

> **系统要求**：Windows 10 1809+ / macOS 11+ / Linux（glibc 2.31+）/ Android 8+ / iOS/iPadOS 17+ / HarmonyOS NEXT 5.0+（API 12）

## 使用

1. 启动 Moke，输入你的 Talebook 服务器地址（例如 `http://192.168.1.100:8080` 或 `https://mytalebook.example.com`）
2. 根据服务器设置，输入访问码或登录账号
3. 开始浏览、搜索、下载和阅读

下载的书籍存储在本地，在书架页面可以离线打开阅读。

## Reader 开发与构建

Reader 是独立递归子模块。全新检出或从旧 Readest 子模块迁移后执行：

```bash
git submodule sync --recursive
git submodule update --init --recursive
pnpm install --frozen-lockfile
cd readest && pnpm install --frozen-lockfile && cd ..
pnpm build:reader
```

`pnpm build:reader` 会自动执行 Reader 的 `setup-vendors`，生成 PDF.js、SimpleCC 和 Jieba 资源；只启动开发服务器时可先在 `readest/` 执行 `pnpm setup:vendors`。产物位于 `readest/out/readest`，Moke 打包时复制到 `/readest`。开发服务器通过 `pnpm dev:reader` 启动在 `http://localhost:3001/readest/reader`。协议、鉴权、错误和版本兼容说明见子模块的 `docs/MOKE_CONTRACT.md`；`mokeServerUrl` 始终是用户配置的 Talebook 地址，不是 Reader 服务地址。

真实桌面联调可使用 `pnpm tauri:reader-e2e` 启用仅绑定 `127.0.0.1` 的可选 WebDriver 插件。`reader-e2e` 与 release profile 同时启用会编译失败，不能进入发布产物。经过脱敏的环境、命令轮廓与实测结果见子模块的 `docs/E2E_EVIDENCE.md`。

Reader 原生命令仅授予顶层 Reader UI；书稿必须保持在 Foliate 的 sandbox iframe 内，不能接触顶层 Tauri IPC bridge。桌面 `allow_paths_in_scopes` 只能复用宿主已授权的 `fs_scope`，Moke 的 `open_reader` 也只为 AppData 书籍或文件选择器已授权路径扩展 scope。升级 Foliate、Reader 命令或 capability 时必须保留这些边界并运行 `tests/reader-only-build.test.mjs`。

## 相关链接

- [Talebook 服务器](https://github.com/talebook/talebook) — 自托管电子书服务端，Moke 的数据来源
- [readest-reader](https://github.com/hehetoshang/readest-reader) — 从 Readest 抽离、按 `moke.readest.embed.v1` 契约集成的专业阅读器
- [报告 Bug](../../issues) — 发现 Bug？请告诉我们
- [参与贡献](CONTRIBUTING.md) — 开发者贡献指南

## 开发者

- **houheya**（[@hehetoshang](https://github.com/hehetoshang)）— Moke 客户端开发

## 致谢

- **Rex**（[@talebook](https://github.com/talebook)）— Talebook 服务器作者，Moke 项目指导者

## 支持

如果 Moke 对你有帮助，欢迎请维护者喝杯咖啡~

<div align="center">
  <table>
    <tr>
      <td align="center"><img src="public/contributors/houheya/weixin.jpg" width="200" alt="微信赞赏码" /><br/>微信</td>
      <td align="center"><img src="public/contributors/houheya/alipay.jpg" width="200" alt="支付宝收款码" /><br/>支付宝</td>
    </tr>
  </table>
</div>

### 感谢以下用户的打赏支持

- 微信用户金海先生

## 说明

本项目部分代码由 AI 编程工具（Codex、cc-haha、multica-agent）辅助生成，所有代码均经过人工审查。

## 许可证

GPLv3
