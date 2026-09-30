# Moke 拓展开发指南

## 概述

Moke 拓展是安装在 `%APPDATA%\com.moke.client\extensions\{name}\` 下的独立程序，
通过主程序提供的 **本地 HTTP API**（REST + WebSocket）与主程序交互。

拓展可以使用**任意编程语言**开发——只要后端进程能发送 HTTP 请求。宿主凭据不会提供给浏览器 UI。

## 快速开始

### 1. 目录结构

```
my-extension/
├── manifest.json        # 必填：元数据、权限、入口声明
├── icon.png             # 可选：128×128 图标
├── server.exe           # 可选：原生后端程序（任意语言编译）
└── ui/
    └── index.html       # 前端入口（纯 HTML 或任意框架构建产物）
```

### 2. manifest.json

```json
{
  "name": "my-extension",         // 必填: 仅 [a-z0-9-]，最长 64 字符
  "version": "1.0.0",             // 必填: semver major.minor.patch
  "display_name": "我的拓展",      // 必填: 显示名称，最长 128 字符
  "description": "功能描述",       // 可选: 最长 512 字符
  "author": "开发者",              // 可选

  "entry": {
    "ui_port": 0,                 // 0 = 自动分配端口，或指定固定端口
    "backend": {                  // 可选: 原生后端
      "executable": "server.exe", // 纯文件名，禁止路径/../
      "args": ["--port", "{EXT_PORT}"]  // {EXT_PORT} 会被替换
    }
  },

  "sidebar": {                    // 可选: 侧边栏入口
    "label": "我的拓展",
    "icon": "chart-line",         // lucide 图标名
    "order": 100                  // 排序位置
  },

  "permissions": [                // 必填: 权限白名单
    "books.read",
    "reader.events.subscribe",
    "storage"
  ]
}
```

### 3. 权限列表

| 权限 | 说明 |
|---|---|
| `books.read` | 读取书库数据 |
| `books.download` | 下载书籍文件 |
| `user.profile` | 读取用户信息 |
| `server.info` | 读取服务器信息 |
| `reader.events.subscribe` | 通过 WebSocket 订阅阅读器事件 |
| `reader.command.send` | 向阅读器发送指令 |
| `reader.state.read` | 查询阅读器当前状态 |
| `storage` | 读写持久化键值存储 |
| `sidebar.add` | 动态注册侧边栏项 |
| `page.register` | 注册自定义页面 |

## API 参考

### REST API — 会话级随机回环端口

Moke 启动拓展后端时通过 `MOKE_API_PORT` 环境变量传入本次会话的端口。不要硬编码端口。所有请求需携带：
```
X-Extension-Name: my-extension
X-Extension-Token: {token}    // 启用拓展时由主程序分配
```

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/v1/info` | GET | 宿主和服务器信息（含运行时形态与阅读器窗口） |
| `/api/v1/books` | POST | 查询书库（分页/搜索） |
| `/api/v1/books/{id}` | GET | 书籍详情 |
| `/api/v1/user` | GET | 当前用户 |
| `/api/v1/server` | GET | 服务器信息 |
| `/api/v1/reader/windows` | GET | 活跃的阅读器窗口列表 |
| `/api/v1/reader/{label}/state` | GET | 阅读器状态 |
| `/api/v1/reader/{label}/command` | POST | 向阅读器发指令（可阻塞等待回执） |
| `/api/v1/extension/sidebar/add` | POST | 动态添加侧边栏 |
| `/api/v1/extension/page/register` | POST | 注册自定义页面 |
| `/api/v1/extension/storage/{key}` | GET/PUT/DELETE | 持久化存储 |

### 阅读器窗口寻址

- `/api/v1/info` 的 `runtime` 字段返回 `multi_window`（桌面多窗口）或 `single_webview`（OHOS / Android / iOS 单 WebView）。
- 多窗口形态下，阅读器窗口 label 以 `reader-` 开头；单 WebView 形态下阅读器运行在 `main` 窗口中，`/api/v1/reader/windows` 与 `reader_windows` 会把 `main` 一并列出，直接用 `main` 作为 `{label}` 寻址即可。

### 命令与回执（request_id 关联）

`POST /api/v1/reader/{label}/command` 的 body 是透传给阅读器的命令对象。推荐带上 `request_id`，并**订阅 WS 的 `reader:command:result` 事件**接收回执（未订阅则收不到回执，属正常订阅过滤）：

```json
{
  "request_id": "ext-abc-123",
  "command": "go_to_fraction",
  "fraction": 0.42
}
```

响应：

```json
{ "sent": true, "request_id": "ext-abc-123" }
```

若需要**同步拿到执行结果**，可在 body 里加 `wait_ms`（毫秒）启用阻塞等待。`wait_ms` 必须是 `0` 到 `30000` 的整数；大于 `0` 时 `request_id` 必须是非空字符串。服务端按「拓展身份 + 目标窗口 + `request_id`」隔离等待请求，并校验回执来自目标阅读器窗口：不同拓展可以复用同一个 ID，同一拓展对同一窗口并发复用 ID 则返回冲突。每次调用还会使用宿主内部唯一关联 ID，因此超时后的迟到回执不会满足后来复用同一 `request_id` 的请求。

宿主全局最多同时处理 32 个阻塞等待；达到上限时，新等待会立即返回 HTTP 429 + `TOO_MANY_PENDING_COMMANDS`。该上限仅计入 `wait_ms > 0` 的命令，不影响 `wait_ms` 为 0 的发送或其它 REST 请求。超时后到达的回执仍会广播到 WS，但会带上 `data.late: true`；拓展复用同一 `request_id` 时应忽略这类迟到回执。

```json
{
  "request_id": "ext-abc-123",
  "command": "get_position",
  "wait_ms": 5000
}
```

命令执行成功或失败时，REST 会把阅读器回执摊平到响应顶层；超时返回 `timed_out: true`：

```json
{ "sent": true, "request_id": "ext-abc-123", "success": true, "result": { "view_key": "...", "progress": { "page": 42, "fraction": 0.42 } } }
```

```json
{ "sent": true, "request_id": "ext-abc-123", "success": false, "error": "No active reader view" }
```

```json
{ "sent": true, "request_id": "ext-abc-123", "timed_out": true }
```

等待参数错误返回 JSON `{ "code": "...", "error": "..." }`。确定的 HTTP 状态与错误码如下：

| 条件 | HTTP | `code` |
|---|---:|---|
| `wait_ms > 0` 且 `request_id` 不是非空字符串 | 400 | `INVALID_REQUEST_ID` |
| `wait_ms` 不是非负整数 | 400 | `INVALID_WAIT_MS` |
| `wait_ms > 30000` | 400 | `WAIT_MS_TOO_LARGE` |
| `wait_ms > 0` 但缺少 `request_id` | 400 | `MISSING_REQUEST_ID` |
| 同一拓展、同一窗口已有相同 `request_id` 在等待 | 409 | `DUPLICATE_REQUEST_ID` |
| 全局已有 32 个同步命令在等待 | 429 | `TOO_MANY_PENDING_COMMANDS` |

阅读器侧的命令回执示例（WS 事件 `reader:command:result`）：

```json
{
  "event": "reader:command:result",
  "timestamp": 1719777601000,
  "data": {
    "request_id": "ext-abc-123",
    "command": "go_to_fraction",
    "success": true,
    "result": { "fraction": 0.42 }
  }
}
```

失败时 `success` 为 `false`，并带 `error` 字段说明原因（如 `No active reader view`）。

### WebSocket 事件 — 会话级随机回环端口

端口由 `MOKE_WS_PORT` 环境变量传入拓展后端。不要硬编码端口。

**连接流程:**

1. WebSocket 连接建立后，发送单条握手消息（同时认证 + 订阅）:
```json
{
  "type": "hello",
  "extension": "my-extension",
  "token": "{token}",
  "events": ["reader:book:opened", "reader:page:changed", "reader:book:closed"]
}
```

2. 接收事件推送:
```json
{
  "event": "reader:page:changed",
  "timestamp": 1719777601000,
  "data": {
    "book_id": "abc123",
    "page": 42,
    "total_pages": 100,
    "progress": 42,
    "chapter": "第二章"
  }
}
```

**可用事件:**

| 事件 | 触发时机 |
|---|---|
| `reader:book:opened` | 打开一本书 |
| `reader:book:closed` | 关闭一本书 |
| `reader:page:changed` | 翻页 |
| `reader:highlight:created` | 创建划线 |
| `reader:annotation:created` | 创建笔记 |
| `reader:command:result` | `/command` 命令的执行回执（`data.request_id` 关联请求） |

## 三种拓展类型

### 纯前端拓展

只有 `manifest.json` + `ui/index.html`，适合不需要宿主 API 的静态页面。浏览器 UI 不会收到宿主 token，也不能直接调用宿主 REST/WS；需要宿主数据时必须增加后端，由同源 UI 调用自己的后端，再由后端使用环境变量中的会话凭据访问宿主。

### 带后端的拓展

声明 `entry.backend`，主程序启动时自动运行后端程序。
后端程序绑定分配的端口，serve 自己的 UI 和 API。
适合：复杂数据处理、AI 集成、外部服务对接。

### 无头拓展

不声明 `entry`，没有 UI。仅通过 WebSocket 订阅事件做后台处理。
适合：自动同步标注、阅读数据上报、系统钩子。

## 安全迁移（会话端口与凭据）

- 已经从 `MOKE_API_PORT`、`MOKE_WS_PORT` 和 `MOKE_EXT_TOKEN` 读取配置的后端无需改调用格式；端口和 token 现在每次 Moke 启动都会更新。
- 硬编码 `19555` / `19556` 的后端必须改读对应端口环境变量。
- 旧版直接在 UI 中获取 token、连接宿主 REST/WS 的拓展必须迁移为「UI → 同源拓展后端 → 宿主」；不得用扩大 CORS 或把 token 返回给 UI 的方式兼容。
- Moke 首次读取旧 `runtime.json` 时会忽略其中的 token、生成新会话 token，并立即重写文件移除明文凭据；启用状态和拓展端口保持不变。

## 分发

### 打包为 NSIS 安装器

1. 将拓展文件放入 `dist/` 目录
2. 复制 `installer-template.nsi` 并修改顶部 `EXT_*` 常量
3. 用 NSIS 编译: `makensis my-extension.nsi`
4. 生成的 `setup.exe` 即安装包

安装器会自动：
- 检测 Moke 主程序是否已安装（未安装则拒绝）
- 将文件复制到 `%APPDATA%\com.moke.client\extensions\{name}\`
- 写入注册表

### 手动安装（开发调试）

直接将拓展文件夹复制到:
```
%APPDATA%\com.moke.client\extensions\my-extension\
```

然后打开 Moke → 设置 → 拓展管理 → 启用。

## 安全注意事项

1. **token 仅限后端环境变量**：只从 `MOKE_EXT_TOKEN` 读取，不得写入文件、日志、HTML、浏览器响应或前端脚本
2. **后端程序只用纯文件名**：manifest 中 `executable` 不能包含路径，防止路径穿越攻击
3. **端口使用环境变量**：从 `MOKE_API_PORT` / `MOKE_WS_PORT` 读取本次会话随机端口；浏览器 UI 只调用自己的同源后端
4. **权限最小化**：只声明拓展真正需要的权限
5. **iframe sandbox**：拓展 UI 运行在 `<iframe sandbox="allow-scripts allow-forms">` 中，能力受限

## 调试

1. 打开 Moke 开发者选项（关于页连点版本号 8 次）
2. 开启调试面板（查看实时日志）
3. 在拓展后端日志中确认已读取有效的 `MOKE_API_PORT` / `MOKE_WS_PORT`（不要记录 token）
4. 检查拓展目录: `%APPDATA%\com.moke.client\extensions\`
