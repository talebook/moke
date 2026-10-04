<div align="center">
  <img src="public/logo/logo.png" width="96" height="96" alt="Moke 应用图标" />
  <h1>Moke · 墨客</h1>
  <p>连接你的 Talebook 书库，让阅读触手可及。</p>
  <p>
    <a href="https://github.com/talebook/moke/releases"><img src="https://img.shields.io/github/v/release/talebook/moke" alt="最新稳定版本" /></a>
    <a href="https://github.com/talebook/moke/actions/workflows/ci.yml"><img src="https://github.com/talebook/moke/actions/workflows/ci.yml/badge.svg" alt="CI 状态" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPLv3-blue" alt="GPLv3 许可证" /></a>
  </p>
  <p>
    <a href="https://github.com/talebook/moke/releases">下载安装</a> ·
    <a href="#快速开始">快速开始</a> ·
    <a href="https://github.com/talebook/moke/issues">问题反馈</a> ·
    <a href="CONTRIBUTING.md">参与贡献</a>
  </p>
</div>

**Moke** 是为 [Talebook](https://github.com/talebook/talebook) 自托管电子书服务器打造的开源客户端，基于 Next.js、React 和 Tauri 构建，提供桌面与移动平台安装包。你可以浏览、搜索自己的书库，下载书籍离线阅读，或通过内嵌的 [readest-reader](https://github.com/hehetoshang/readest-reader) 在线阅读 EPUB。

> 使用前请准备一个可访问的 Talebook 服务器。Moke 是客户端，书库管理与账号服务由 Talebook 提供。

[应用预览](#应用预览) · [主要功能](#主要功能) · [安装](#安装) · [快速开始](#快速开始) · [本地开发](#本地开发) · [贡献与反馈](#贡献与反馈) · [许可证](#许可证)

## 应用预览

### 桌面书库

![Moke 桌面书库：侧边导航、格式与分类筛选，以及书籍封面网格](docs/screenshots/library-desktop.png)

<details>
  <summary>查看书籍详情与移动端书库</summary>

### 书籍详情

![Moke 书籍详情：封面、作者、出版信息、格式和内容简介](docs/screenshots/book-detail-desktop.png)

### 移动端书库

<img src="docs/screenshots/library-mobile.png" width="320" alt="Moke 移动端书库：双列封面网格与底部导航" />

</details>

截图来自当前代码的 Web 开发预览，使用虚构书库与原创示例封面；原生应用的窗口和可用操作可能有所不同。[截图来源与更新方法](docs/screenshots/README.md)。

## 主要功能

- **浏览与搜索**：按分类、标签、作者、出版商浏览书库，检索书名、作者与简介。
- **多种视图**：在封面网格、列表和桌面表格之间切换，查看书籍详情。
- **离线阅读**：将书籍下载到本地，在书架中打开已下载的书籍。
- **内嵌阅读器**：集成 readest-reader，支持 EPUB、PDF 等多种格式。
- **漫画阅读**：按服务端书籍类型打开 Talebook 同款漫画阅读器，在线支持 CBZ/ZIP/CBR/RAR，保存并恢复页码；[格式与离线限制](docs/COMIC_READING.md)。
- **在线 EPUB**：通过 Talebook 授权的 Range 接口按需读取，无需先下载整本书。
- **局域网连接**：支持纯 HTTP 与自签名 HTTPS 的自托管服务器。
- **账号与访问控制**：支持访问码、登录和注册，遵循服务器权限设置。
- **墨水屏模式**：提供高对比度界面，减少阴影与装饰效果。

## 安装

前往 [GitHub Releases](https://github.com/talebook/moke/releases) 下载适合设备的安装包，具体可用平台以对应版本的发布资产为准。

| 平台 | 安装包格式 |
|---|---|
| Windows | `.msi` / `.exe` |
| macOS | `.dmg` |
| Linux | `.AppImage` / `.deb` |
| Android | `.apk` |
| iOS/iPadOS | `.ipa`（自签名安装，需将设备 UDID 加入开发者描述文件） |
| OpenHarmony（鸿蒙） | `.hap`（alpha，未签名，可能需要自签名安装） |

> **系统要求**：Windows 10 1809+ / macOS 11+ / Linux（glibc 2.31+）/ Android 8+ / iOS/iPadOS 17+ / HarmonyOS NEXT 5.0+（API 12）

OpenHarmony 安装包目前处于 alpha 阶段，建议在测试设备上体验；iOS/iPadOS 和 OpenHarmony 的签名、安装要求见对应版本的发布说明。

## 快速开始

1. **保存服务器**：启动后进入「服务器」列表，点击「加入服务器」，输入 Talebook 根地址并「保存到列表」。可继续保存 A、B 等多个服务器；保存只校验地址格式，不连接服务器，列表在重启后保留。
2. **从列表连接**：点击已保存条目，直接使用该地址连接；按服务器配置输入访问码或登录账号。连接失败、超时或取消不会删除列表，也不会替换原连接。
3. **切换与断开**：从桌面侧栏或移动端「我的 → 设置」进入「服务器列表」，点击另一条目。请先关闭 Reader 及 Reader 书库窗口；窗口仍打开时会保留原连接并提示重试。「断开」只结束连接，保留已保存条目。
4. **浏览与阅读**：打开「书库」搜索、筛选书籍。在原生书籍详情页选择「在线阅读」，或「下载后阅读」；已下载的文件仍可离线打开。

旧单服务器配置会在本地迁移一次。地址按 HTTP(S) origin 去重，拒绝账号、非根路径、查询参数和片段；不同协议或非默认端口分别保存。加载或保存失败会明确提示，不报保存成功；坏配置可通过「保留原数据并重建列表」恢复，可读取的原配置会先备份，已有离线文件保留。Web 使用 localStorage；原生版本使用 AppData/books/.servers 中的原子 JSON 文件并读回校验。

服务器列表不保存账号凭据。Cookie 仍由浏览器或原生 HTTP 传输层管理；同主机不同端口不构成 Cookie 隔离边界。下载、重试和阅读进度使用各自的来源服务器地址。

在线 EPUB 按需读取，不会自动加入离线书库。服务器不支持在线阅读接口、权限失效或网络异常时，可以重试，或明确选择下载后阅读。在线阅读的接口要求和兼容性说明见 [Reader 集成文档](docs/reader-development.md#在线阅读兼容性)。

## 本地开发

推荐使用 **Node.js 24**（与 CI 一致）和 **pnpm 9.15.9**（由 `package.json` 固定）。运行桌面应用还需要 Rust 工具链和 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)。

### Web 界面开发

只开发 Moke 的书库与设置界面时，可以先启动 Web 预览：

```bash
git clone https://github.com/talebook/moke.git
cd moke
pnpm install --frozen-lockfile
pnpm dev-web
```

打开 <http://localhost:3000>。Web 预览用于界面开发，原生文件访问、离线阅读和内嵌 Reader 联调需要完整应用环境；连接真实服务器时还需满足浏览器的跨域访问要求。

### Reader 开发与构建

完整应用需要初始化递归子模块并安装 Reader 依赖，详见 [Reader 开发与构建](docs/reader-development.md)。完成准备后：

```bash
git submodule sync --recursive
git submodule update --init --recursive
cd readest
pnpm install --frozen-lockfile
pnpm setup:vendors
cd ..
```

然后使用以下命令：

| 命令 | 用途 |
|---|---|
| `pnpm tauri dev` | 启动桌面应用，同时启动 Moke 与 Reader 开发服务 |
| `pnpm tauri build` | 构建生产安装包，自动构建并复制 Reader 资源 |
| `pnpm lint` | 检查 ESLint 规则 |
| `pnpm typecheck` | 检查 TypeScript 类型 |
| `pnpm test` | 运行 API、离线存储和平台分支等测试 |

服务器列表 Web 回归（另一个终端先启动 `pnpm dev-web --port 3000`）：

```bash
pnpm exec playwright test tests/server-list.spec.mjs
# 使用系统 Chromium 时可指定 MOKE_TEST_CHROMIUM_PATH=/path/to/chromium
```

这些测试使用虚构 A/B 网络响应和实际浏览器存储，覆盖 PC/移动列表、保存/连接分离、迁移、失败/取消/重试和认证切换；不能替代真实原生重启、Reader 或 Cookie/CORS 验证。

测试前至少执行 `git submodule update --init readest`，Reader 契约测试会读取子模块内容。详细的环境准备、代码规范和提交流程见 [贡献指南](CONTRIBUTING.md)。

## 贡献与反馈

- [报告 Bug 或提出建议](https://github.com/talebook/moke/issues)：请附上应用版本、系统环境与复现步骤。
- [参与贡献](CONTRIBUTING.md)：了解开发流程与提交规范。
- [安全政策](SECURITY.md)：安全漏洞请通过私密渠道报告。
- [隐私政策](PRIVACY.md)：了解应用的数据处理方式。

## 相关项目

- [Talebook](https://github.com/talebook/talebook)：自托管电子书服务端，提供书库与账号服务。
- [readest-reader](https://github.com/hehetoshang/readest-reader)：从 Readest 抽离、按 `moke.readest.embed.v1` 契约集成的阅读器。

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

- 金海先生
- 千成

## 说明

本项目部分代码由 AI 编程工具（Codex、cc-haha、multica-agent）辅助生成，所有代码均经过人工审查。

## 许可证

Moke 使用 [GNU General Public License v3.0](LICENSE) 许可证。
