# 贡献指南

感谢你对 Moke 的关注！这份文档说明如何报告问题、提出建议以及提交代码变更。

## 报告 Bug

发现 Bug 请通过 [GitHub Issues](../../issues) 提交，提交时请包含以下信息：

- **问题描述** — 发生了什么？预期应该发生什么？
- **复现步骤** — 详细的操作步骤，能稳定复现最好
- **环境信息** — 操作系统及版本、Moke 版本（在设置页面可查看）
- **截图或日志** — 如果有报错界面或控制台错误信息，请附上

提交前请先搜索已有 Issue，避免重复。

## 报告安全漏洞

**请不要在公开的 Issue 中披露安全漏洞。** 请通过 GitHub 的私密漏洞报告功能提交：

**<https://github.com/talebook/moke/security/advisories/new>**

报告中请包含：

- 漏洞的简要描述与影响范围
- 复现步骤或概念验证（PoC）
- 受影响的版本

我们会在收到邮件后尽快回复，并在修复发布前与你保持沟通。感谢你的负责任披露。

## 提出新功能

有新功能想法？欢迎在 Issues 中提出，请包含：

- 你想解决什么问题？
- 你期望的功能是什么样的？
- 有没有你设想的实现思路或参考？

我们会评估功能与项目的匹配度，讨论后再决定是否进入开发。

## 开发环境

### 环境要求

- **Node.js** 22+
- **pnpm** 10+
- **Rust** 工具链（[rustup](https://rustup.rs/)）
- **Windows** — 需要 Visual Studio 2022 Build Tools（"使用 C++ 的桌面开发" 工作负荷）
- **macOS** — 需要 Xcode Command Line Tools
- **Linux** — 需要 `build-essential`、`libwebkit2gtk-4.1-dev` 等 Tauri 系统依赖（参见 [Tauri 文档](https://v2.tauri.app/start/prerequisites/)）

### 克隆并安装依赖

```bash
git clone https://github.com/talebook/moke.git
cd talebook_client
pnpm install
cd readest && pnpm install && cd ..
```

### 开发命令

```bash
pnpm dev            # 前端开发服务器（Tauri 环境，端口 3000）
pnpm dev-web        # 前端开发服务器（纯 Web 环境，端口 3000）
pnpm tauri dev      # 完整桌面应用开发（Rust 后端 + Next.js 前端）
pnpm lint           # ESLint 检查
pnpm typecheck      # TypeScript 类型检查
```

### 构建

```bash
pnpm build && pnpm build:reader && pnpm copy:reader
pnpm tauri build    # 生产桌面安装包
```


## 提交变更

### 分支约定

- `main` — 主分支，始终保持可构建、可运行
- 功能分支 — 从 `main` 创建，命名格式：`feature/<简短描述>` 或 `fix/<简短描述>`
- 示例：`feature/offline-search`、`fix/login-redirect`

### Commit 消息格式

使用中文或英文均可，但需保持清晰。格式：

```
<类型>: <简要描述>

<详细说明（可选）>
```

类型示例：
- `feat:` — 新功能
- `fix:` — Bug 修复
- `refactor:` — 重构（不改变功能）
- `docs:` — 文档变更
- `chore:` — 构建、依赖等杂项

示例：

```
feat: 书架支持拖拽排序

- 长按书籍卡片后进入拖拽模式
- 释放后自动保存排序结果到本地
```

### 代码规范

- **TypeScript** — 使用项目已有的类型定义风格，已有类型可复用时不要重复定义
- **样式** — 使用 Tailwind CSS，通过 `clsx` + `tailwind-merge` 组合类名
- **API 请求** — 所有服务器通信统一通过 `src/lib/api.ts` 的 `request()` 函数
- **平台差异** — 通过 `process.env.NEXT_PUBLIC_APP_PLATFORM` 区分 Tauri 和 Web 行为，不要在 Web 代码中直接引入 `@tauri-apps/*`
- **导航** — Tauri 环境下禁止使用 `window.location.href`，必须使用 `router.push` / `router.replace`（否则会重载 WebView 丢失所有内存状态）
- **提交前检查** — 确保 `pnpm lint` 和 `pnpm typecheck` 通过

### 提交 PR

1. 从 `main` 分支创建你的功能分支
2. 完成开发后，确保 lint 和 typecheck 通过
3. 如果有阅读器改动，确保 `pnpm build:reader` 能正常构建
4. 向 `main` 分支发起 Pull Request
5. PR 标题简洁描述改动，正文补充背景和实现思路

PR 合并方式：**Squash merge**，将分支的所有 commit 压缩为一个干净的 commit 合入 `main`。

## 目录结构参考

```
src/                       # 前端源码
  app/                     # Next.js App Router 页面
  components/              # 共享组件
  lib/                     # 工具库
    api.ts                 # HTTP 请求层（所有 API 调用的入口）
    offline-books.ts       # 离线下载管理
    store/                 # Zustand 状态管理
src-tauri/                 # Tauri Rust 后端
readest/apps/readest-app/  # readest 阅读器（独立 workspace）
```
