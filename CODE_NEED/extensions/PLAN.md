# Moke 拓展系统 — 架构方案

## 一、概述

拓展是**独立的程序**，通过 NSIS 安装器安装到用户电脑，与 Moke 主程序通过**本地 HTTP + WebSocket API Server** 进行通信。拓展可以使用任意编程语言和框架开发——只需要能发 HTTP 请求和解析 JSON 即可。

拓展系统**仅支持桌面端**（Tauri）。

### 拓展能做什么

| 能力 | 说明 |
|---|---|
| **对接阅读器** | 订阅阅读事件（翻页、划线、笔记）；发送指令（跳页、切换主题） |
| **注入侧边栏** | 注册新的侧边栏项，包含标签、图标、排序位置 |
| **自定义页面** | 提供自己的前端 UI（任意框架），在主窗口内渲染 |
| **服务器访问** | 通过主程序代理访问 Talebook 服务器（书库、用户信息等） |
| **持久化存储** | 每个拓展独立的键值存储，由主程序持久化 |
| **原生后端** | 运行一个原生后端程序，用于数据处理、AI、同步等 |
| **宿主事件** | 订阅应用生命周期事件（服务器连接、登录、登出等） |
| **连接其他服务器** | 拓展的后端可以自行连接任意外部服务 |

### 拓展不能做什么（安全边界）

- 访问拓展自身存储目录以外的文件
- 访问其他拓展的数据或存储
- 修改 Moke 核心 UI（只能通过注册的拓展点接入）
- 未经代理直接访问 Talebook 服务器（必须通过主程序 API）
- 获取用户的登录凭证或 token

---

## 二、架构

```
┌──────────────────────────────────────────────────────────────────┐
│                     Moke 进程（单一二进制）                         │
│                                                                  │
│  ┌───────────┐   Tauri events    ┌───────────┐                  │
│  │ 主窗口     │◄────────────────►│ 阅读器窗口  │                  │
│  │ (main)    │  reader:*  events │ (reader-N) │                  │
│  └─────┬─────┘                   └───────────┘                  │
│        │                                                         │
│  ┌─────▼──────────────────────────────────────────┐             │
│  │           拓展 API Server                        │             │
│  │           (127.0.0.1:{port})                     │             │
│  │                                                  │             │
│  │  REST API（拓展 → 主程序）:                        │             │
│  │   /api/v1/info          — 宿主和服务器信息         │             │
│  │   /api/v1/books/*       — 书库数据（代理）         │             │
│  │   /api/v1/user/*        — 当前用户                │             │
│  │   /api/v1/server/*      — 服务器信息              │             │
│  │   /api/v1/reader/*      — 阅读器状态和控制         │             │
│  │   /api/v1/extension/*   — 拓展注册和管理           │             │
│  │                                                  │             │
│  │  WebSocket /events（主程序 → 拓展 事件推送）:       │             │
│  │   reader:book:opened        打开书籍              │             │
│  │   reader:page:changed       翻页                  │             │
│  │   reader:highlight:created  创建划线              │             │
│  │   reader:annotation:created 创建笔记              │             │
│  │   reader:book:closed        关闭书籍              │             │
│  │   host:server:connected     连接服务器            │             │
│  │   host:server:disconnected  断开服务器            │             │
│  │   host:user:login           用户登录              │             │
│  │   host:user:logout          用户登出              │             │
│  └──────────┬───────────────────────────────────────┘             │
│             │                                                     │
│  ┌──────────┼─────────────────────────────────────┐              │
│  │  Rust 拓展后端 (`src-tauri/src/extensions/`)      │             │
│  │  - api_server.rs    HTTP + WS 服务器             │             │
│  │  - discovery.rs     扫描并校验拓展                │             │
│  │  - lifecycle.rs     启动/停止拓展进程             │             │
│  │  - storage.rs       按拓展隔离的键值存储          │             │
│  │  - permissions.rs   权限白名单校验                │             │
│  │  - events.rs        Tauri event ↔ WS 桥接       │             │
│  └─────────────────────────────────────────────────┘             │
└──────────────────────────────────────────────────────────────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
     ┌────▼────┐       ┌────▼────┐       ┌────▼────┐
     │ 拓展 A   │       │ 拓展 B   │       │ 拓展 C   │
     │          │       │          │       │          │
     │ 前端 UI  │       │ 前端 UI  │       │ 后端程序 │
     │ (Next.js)│       │ (Vue/   │       │ (Go/Rust)│
     │          │       │  Svelte) │       │          │
     │ 后端 .exe│       │ (纯前端)  │       │ (无 UI)  │
     └──────────┘       └──────────┘       └──────────┘
```

### 为什么用本地 HTTP + WebSocket（而不是 Tauri commands）

- Tauri commands 需要通过 `invoke()` 调用，只能在 Tauri webview 内使用
- 拓展是**外部进程**，需要一种通用的通信协议
- HTTP/WebSocket 是标准协议，任意语言都能对接
- 主程序已通过 readest 间接依赖了 `tauri-plugin-websocket` 和 `reqwest`

### 为什么用 Tauri events 做内部通信（主程序 ↔ 阅读器）

- 阅读器现在是**进程内嵌入**（通过 `WebviewWindowBuilder`）
- `app.emit()` / `window.listen()` 零开销，不需要网络序列化
- API Server 负责将内部 Tauri events 桥接为外部 WebSocket 消息

---

## 三、拓展包格式

每个拓展是一个目录，安装到 `%APPDATA%/com.moke.client/extensions/{name}/`：

```
reading-stats/
├── manifest.json        # 元数据 + 权限 + 入口声明
├── icon.png             # 128×128，用于侧边栏和管理界面
├── server.exe           # （可选）原生后端程序
└── ui/                  # 前端静态文件，由拓展自己的 HTTP 服务器托管
    └── index.html
```

### manifest.json 规范

```json
{
  "name": "reading-stats",
  "version": "1.0.0",
  "api_version": "1",
  "display_name": "阅读统计",
  "description": "展示阅读时长、进度和统计图表",
  "author": "某开发者",

  "entry": {
    "ui_port": 0,
    "backend": {
      "executable": "server.exe",
      "args": ["--ext-port", "{EXT_PORT}"]
    }
  },

  "sidebar": {
    "label": "阅读统计",
    "icon": "chart-line",
    "order": 100
  },

  "permissions": [
    "books.read",
    "user.profile",
    "reader.events.subscribe",
    "reader.command.send",
    "storage"
  ],

  "lucide_icons": ["chart-line", "bar-chart-3", "clock"]
}
```

### entry 字段说明

| 配置 | 说明 |
|---|---|
| `ui_port: 0` | 由主程序自动分配端口，拓展在该端口上 serve 自己的 UI |
| `ui_port: 3000` | 拓展使用固定端口 serve UI |
| `backend` | 可选的原生后端程序。主程序启动它时将 `{EXT_PORT}` 替换为实际分配的端口号，拓展后端即可绑定该端口 |
| 无 entry | 无头拓展，仅通过 WebSocket 订阅事件，没有 UI |

### 权限定义

| 权限 | 授予的能力 |
|---|---|
| `books.read` | 读取连接服务器上的书库数据 |
| `books.download` | 下载书籍文件 |
| `user.profile` | 读取当前用户信息 |
| `server.info` | 读取连接服务器的信息 |
| `reader.events.subscribe` | 通过 WebSocket 订阅阅读器事件 |
| `reader.command.send` | 向阅读器发送指令（跳页等） |
| `reader.state.read` | 查询阅读器当前状态 |
| `storage` | 读写自己的持久化键值存储 |
| `sidebar.add` | 注册侧边栏项 |
| `page.register` | 注册自定义页面（需配合 sidebar 配置使用） |

---

## 四、拓展 API 接口参考

### 4.1 REST 接口

所有请求需携带请求头：
```
X-Extension-Name: reading-stats
X-Extension-Token: {token}
```

Token 在拓展被激活时由主程序分配。

#### 宿主与服务器信息

```
GET /api/v1/info
→ {
    "host_version": "0.1.4",
    "server_url": "http://192.168.1.100:8080",
    "server_title": "我的书库",
    "user": { "name": "张三", "admin": false } | null,
    "reader_windows": ["reader-0", "reader-1"]
  }
```

#### 书库（代理 Talebook 服务器）

```
POST /api/v1/books
  请求体: { "page": 1, "limit": 20, "search": "关键词", "sort": "title" }
→ { "books": [...], "total": 100 }

GET /api/v1/books/{id}
→ { "id": "...", "title": "...", "author": "...", "cover": "...", ... }

GET /api/v1/books/{id}/download?format=epub
→ 二进制文件流
```

#### 用户

```
GET /api/v1/user
→ { "user": { "name": "张三", "admin": false, ... } }
```

#### 服务器

```
GET /api/v1/server
→ { "url": "http://...", "title": "...", "version": "..." }
```

#### 阅读器

```
GET /api/v1/reader/windows
→ ["reader-0", "reader-1"]

GET /api/v1/reader/{window_label}/state
→ {
    "book": { "id": "abc123", "title": "三体", "author": "刘慈欣" },
    "progress": 0.42,
    "current_page": 42,
    "total_pages": 100,
    "chapter": "第二章 射手与农场主"
  }

POST /api/v1/reader/{window_label}/command
  请求体: { "command": "jump_to_page", "page": 50 }
  请求体: { "command": "next_page" }
  请求体: { "command": "prev_page" }
  请求体: { "command": "toggle_theme", "theme": "dark" }
```

#### 拓展自管理

```
POST /api/v1/extension/sidebar/add
  请求体: { "label": "阅读统计", "icon": "chart-line", "path": "/ext-view/reading-stats" }

POST /api/v1/extension/page/register
  请求体: { "path": "/ext-view/reading-stats", "ui_url": "http://127.0.0.1:19556" }

GET /api/v1/extension/storage/{key}
→ { "key": "last_page", "value": "42" }

PUT /api/v1/extension/storage/{key}
  请求体: { "value": "42" }
```

### 4.2 WebSocket 事件

连接地址: `ws://127.0.0.1:{port}/events`

#### 订阅消息（拓展 → 主程序）

```json
{
  "type": "subscribe",
  "extension": "reading-stats",
  "token": "{token}",
  "events": [
    "reader:book:opened",
    "reader:page:changed",
    "reader:highlight:created",
    "reader:annotation:created",
    "reader:book:closed",
    "host:server:connected",
    "host:server:disconnected",
    "host:user:login",
    "host:user:logout"
  ]
}
```

#### 事件消息（主程序 → 拓展）

```json
// reader:book:opened — 打开一本书
{
  "event": "reader:book:opened",
  "window": "reader-0",
  "timestamp": 1719777600000,
  "data": {
    "book_id": "abc123",
    "title": "三体",
    "author": "刘慈欣",
    "format": "epub"
  }
}

// reader:page:changed — 翻页
{
  "event": "reader:page:changed",
  "window": "reader-0",
  "timestamp": 1719777601000,
  "data": {
    "book_id": "abc123",
    "page": 42,
    "total_pages": 100,
    "progress": 0.42,
    "chapter": "第二章 射手与农场主"
  }
}

// reader:highlight:created — 创建划线
{
  "event": "reader:highlight:created",
  "window": "reader-0",
  "timestamp": 1719777602000,
  "data": {
    "book_id": "abc123",
    "cfi": "epubcfi(/6/4!...）",
    "text": "在中国，任何超脱飞扬的思想都会砰然坠地...",
    "color": "yellow",
    "note": ""
  }
}
```

### 4.3 内部 Tauri Events（阅读器 → 主程序桥接）

API Server 内部监听以下 Tauri events，并将其转发给 WebSocket 订阅者：

| Tauri Event | 由谁发出 | 说明 |
|---|---|---|
| `reader:book:opened` | 阅读器前端 | 打开一本书 |
| `reader:book:closed` | 阅读器前端 | 关闭一本书/窗口 |
| `reader:page:changed` | 阅读器前端 | 翻页 |
| `reader:highlight:created` | 阅读器前端 | 创建划线 |
| `reader:annotation:created` | 阅读器前端 | 创建笔记 |
| `reader:state:updated` | 阅读器前端 | 状态心跳更新 |

需要在 moke 的 Rust 层新增一个 Tauri command，供阅读器前端调用：

```rust
/// 阅读器前端调用此命令向主程序上报事件。
/// 主程序将事件转发给 WebSocket 订阅者（拓展）。
#[tauri::command]
fn ext_reader_event(app: AppHandle, event: String, data: serde_json::Value) {
    app.emit(&format!("reader:{}", event), data).ok();
}
```

---

## 五、Rust 后端实现 (`src-tauri/src/extensions/`)

```
src-tauri/src/extensions/
├── mod.rs           # 模块入口，注册 Tauri commands
├── discovery.rs     # 扫描拓展目录，解析 manifest.json，校验
├── lifecycle.rs     # 启动/停止拓展后端进程
├── api_server.rs    # HTTP + WebSocket 服务器（对外拓展 API）
├── storage.rs       # 按拓展隔离的 JSON 文件存储
├── permissions.rs   # 根据 manifest 做权限白名单校验
└── events.rs        # Tauri event 监听 → WS 广播桥接
```

### mod.rs — 注册的 Tauri Commands

以下 commands 供 Moke 自身前端（管理界面）调用：

```rust
ext_list_extensions()         → Vec<ExtensionInfo>     // 列出已安装拓展
ext_enable_extension(name)    → Result<()>             // 启用拓展
ext_disable_extension(name)   → Result<()>             // 禁用拓展
ext_uninstall_extension(name) → Result<()>             // 卸载拓展
ext_get_api_port()            → u16                    // 获取 API Server 端口
ext_reader_event(event, data) → ()                     // 阅读器前端上报事件
```

### api_server.rs — API Server

基于 `tiny_http`（同步、最小依赖）或 `warp`（异步）：

```
127.0.0.1:{port}
├── GET  /api/v1/info
├── POST /api/v1/books
├── GET  /api/v1/books/{id}
├── GET  /api/v1/user
├── GET  /api/v1/server
├── GET  /api/v1/reader/windows
├── GET  /api/v1/reader/{label}/state
├── POST /api/v1/reader/{label}/command
├── POST /api/v1/extension/sidebar/add
├── POST /api/v1/extension/page/register
├── GET  /api/v1/extension/storage/{key}
├── PUT  /api/v1/extension/storage/{key}
└── WS   /events
```

Token 认证中间件：每个请求对 `HashMap<String, String>`（拓展名 → token）进行校验，该映射由 lifecycle.rs 管理。

### events.rs — 事件桥接

```rust
/// 桥接：Tauri events → WebSocket 广播
pub fn start_event_bridge(app: AppHandle, ws_broadcast: Sender<WsMessage>) {
    let events = [
        "reader:book:opened",
        "reader:book:closed",
        "reader:page:changed",
        "reader:highlight:created",
        "reader:annotation:created",
    ];
    for event in events {
        let tx = ws_broadcast.clone();
        app.listen(event, move |payload| {
            let _ = tx.send(WsMessage { event, data: payload });
        });
    }
}
```

### storage.rs — 拓展持久化存储

```rust
/// 按拓展隔离的键值存储，底层为 JSON 文件。
/// 路径: %APPDATA%/com.moke.client/extensions/{name}/storage.json
pub fn ext_storage_get(name: &str, key: &str) -> Option<String>
pub fn ext_storage_set(name: &str, key: &str, value: &str)
```

---

## 六、前端实现

### 6.1 拓展 Zustand Store (`src/lib/store/extensions.ts`)

```ts
interface ExtensionInfo {
  name: string;
  version: string;
  displayName: string;
  description: string;
  author: string;
  enabled: boolean;
  permissions: string[];
  sidebar?: { label: string; icon: string; order: number };
  uiUrl?: string;  // 启用后填充
}

interface ExtensionStore {
  extensions: ExtensionInfo[];
  loaded: boolean;
  apiPort: number;
  loadExtensions: () => Promise<void>;
  enableExtension: (name: string) => Promise<void>;
  disableExtension: (name: string) => Promise<void>;
  uninstallExtension: (name: string) => Promise<void>;
}
```

### 6.2 侧边栏动态注入 (`src/components/layout/Sidebar.tsx`)

```tsx
// 在 Sidebar 中，静态 navItems 之后追加：
const { extensions } = useExtensionStore();
const extNavItems = extensions
  .filter(ext => ext.enabled && ext.sidebar)
  .sort((a, b) => (a.sidebar!.order ?? 100) - (b.sidebar!.order ?? 100))
  .map(ext => ({
    href: `/extensions/view?name=${ext.name}`,
    icon: getLucideIcon(ext.sidebar!.icon),
    label: ext.sidebar!.label,
  }));
```

### 6.3 拓展视图容器 (`src/app/extensions/view/page.tsx`)

拓展的 UI 运行在自己的 localhost 服务器上，主程序通过 iframe 加载：

```tsx
// URL: /extensions/view?name=reading-stats
export default function ExtensionViewPage() {
  const name = searchParams.get('name');
  const ext = useExtensionStore(s => s.extensions.find(e => e.name === name));

  if (!ext?.uiUrl) return <div>拓展未启动</div>;

  return (
    <iframe
      src={ext.uiUrl}
      sandbox="allow-scripts allow-forms"
      className="w-full h-full border-0"
    />
  );
}
```

### 6.4 拓展管理页面

- `src/app/extensions/page.tsx` — 已安装拓展列表，启用/禁用/卸载
- `src/app/extensions/[name]/page.tsx` — 拓展详情（权限、版本、操作）

### 6.5 设置页集成

在设置页「应用」section 中添加「拓展管理」入口：

```tsx
<SettingsLinkRow
  icon={Package}
  label="拓展管理"
  description="查看、启用或卸载已安装的拓展"
  href="/extensions"
/>
```

### 6.6 阅读器事件转发（readest 前端）

阅读器前端需要在关键节点调用 `invoke('ext_reader_event', ...)`。这需要少量修改 readest 的阅读器 hooks/store：

```ts
// 在阅读器 store 中，打开书籍时：
if (window.__MOKE_EMBEDDED) {
  invoke('ext_reader_event', {
    event: 'book:opened',
    data: { book_id, title, author, format }
  });
}

// 翻页时：
invoke('ext_reader_event', {
  event: 'page:changed',
  data: { book_id, page, totalPages, progress, chapter }
});
```

`window.__MOKE_EMBEDDED` 由 `open_reader_window` 在创建阅读器窗口时注入的初始化脚本设置（已实现），用于区分独立运行和嵌入模式。

---

## 七、拓展开发与分发

### 7.1 纯前端拓展（最简单）

```
my-extension/
├── manifest.json
├── icon.png
└── ui/
    └── index.html     ← 任意 HTML，通过 fetch 调用主程序 API
```

主程序分配端口后，拓展的 `ui/` 由一个简易静态文件服务器托管（或拓展自行 serve）。

### 7.2 完整拓展（Next.js + Rust 后端）

```
my-extension/
├── manifest.json
├── icon.png
├── server.exe              ← Rust/Go/Node 编译的二进制
└── ui/                     ← Next.js 静态导出
    └── index.html
```

主程序启动 `server.exe` 并分配端口，拓展后端在该端口上同时 serve UI 和 API。主程序通过 iframe 加载 `http://127.0.0.1:{port}`。

### 7.3 无头拓展（纯后端，无 UI）

```
my-extension/
├── manifest.json
└── server.exe              ← 仅后端逻辑，通过 WS 订阅事件
```

manifest 中不声明 `entry.ui_port`，不声明 `sidebar`。这类拓展仅通过 WebSocket 订阅事件并执行后台逻辑（如自动同步标注到 Notion、阅读数据上报等）。

### 7.4 NSIS 安装器模板

```nsis
!define EXT_NAME "reading-stats"
!define EXT_DISPLAY_NAME "阅读统计"

OutFile "${EXT_NAME}-setup.exe"
InstallDir "$APPDATA\com.moke.client\extensions\${EXT_NAME}"

Section "安装"
  SetOutPath "$INSTDIR"
  File /r "dist\*"
  WriteRegStr HKCU "Software\Moke\Extensions\${EXT_NAME}" "Installed" "1"
  WriteRegStr HKCU "Software\Moke\Extensions\${EXT_NAME}" "Path" "$INSTDIR"
SectionEnd

Section "卸载"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Moke\Extensions\${EXT_NAME}"
SectionEnd
```

---

## 八、安全模型

| 层 | 机制 |
|---|---|
| **网络隔离** | API Server 仅绑定 `127.0.0.1`，外部网络不可达 |
| **身份认证** | 每个拓展激活时分配独立 token，每次请求校验 |
| **权限控制** | 根据 manifest 中的 `permissions` 白名单，每次 API 调用检查 |
| **UI 沙箱** | 拓展通过 `<iframe sandbox="allow-scripts allow-forms">` 渲染 |
| **进程隔离** | 拓展后端是独立进程，崩溃不影响主程序 |
| **存储隔离** | 每个拓展有自己独立的 `storage.json`，拓展间不可互相访问 |
| **服务器代理** | 拓展不直接接触 Talebook 服务器的 session/cookie，全部由主程序代理 |
| **用户知情** | 首次启用拓展时弹出权限列表，用户确认后才能激活 |

---

## 九、实施路线

### 第一阶段 — Rust 基础设施（约 400 行）

文件：`src-tauri/src/extensions/{mod, discovery, lifecycle, storage}.rs`

- 拓展目录扫描
- manifest.json 解析与校验
- 启用/禁用生命周期（启动后端进程、分配端口、生成 token）
- 按拓展隔离的持久化存储
- Tauri commands：`ext_list_extensions`、`ext_enable_extension`、`ext_disable_extension`、`ext_uninstall_extension`、`ext_get_api_port`

### 第二阶段 — API Server（约 500 行）

文件：`src-tauri/src/extensions/{api_server, permissions, events}.rs`

- HTTP 服务器（tiny_http）
- Token 认证中间件
- REST 路由实现（代理 Talebook 服务器、阅读器状态查询、拓展自管理）
- WebSocket `/events` 端点
- Tauri event → WS 广播桥接
- Tauri command：`ext_reader_event`（阅读器前端调用）

### 第三阶段 — 前端管理界面（约 600 行）

文件：`src/app/extensions/*`、`src/lib/store/extensions.ts`

- 拓展 zustand store
- 拓展列表页
- 拓展详情页（权限查看、启用/禁用）
- 拓展视图容器（iframe）
- 侧边栏动态注入
- 设置页集成
- 首次启用权限确认弹窗

### 第四阶段 — 阅读器事件转发（约 100 行）

文件：readest 前端阅读器 hooks/store

- 在关键阅读器事件节点调用 `invoke('ext_reader_event', ...)`
- 阅读器状态变更时上报
- `window.__MOKE_EMBEDDED` 守卫（仅在嵌入模式下生效）

### 第五阶段 — 工具链与示例（约 200 行）

- NSIS 安装器模板
- 示例拓展：「阅读统计」
- 拓展开发指南（存于仓库文档中）
- 可选的 `moke-ext` CLI 脚手架工具

---

## 十、关键设计决策

| 决策 | 原因 |
|---|---|
| 本地 HTTP + WS 作为拓展接口 | 通用协议，任意语言可对接。拓展是外部进程，无法直接调 Tauri invoke |
| Tauri events 做主程序 ↔ 阅读器通信 | 阅读器已嵌入同一进程。事件零开销，无需额外依赖 |
| iframe 加载拓展 UI | Next.js 静态导出无法做动态路由。iframe 提供天然沙箱隔离，拓展可用任意框架 |
| 拓展后端作为独立进程 | 进程隔离保证拓展崩溃不影响主程序。拓展可以用任意语言写后端 |
| NSIS 安装器分发 | 用户双击安装，符合桌面软件的常规分发习惯 |
| manifest 声明权限 | 用户安装前知道拓展要什么权限，安全边界清晰 |
| 通过主程序代理访问 Talebook 服务器 | 拓展永远不会接触到 session cookie 或登录凭证 |
