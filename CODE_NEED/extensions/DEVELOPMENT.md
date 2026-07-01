# Moke 拓展开发指南

## 概述

Moke 拓展是安装在 `%APPDATA%\com.moke.client\extensions\{name}\` 下的独立程序，
通过主程序提供的 **本地 HTTP API**（REST + WebSocket）与主程序交互。

拓展可以使用**任意编程语言**开发——只要它能发送 HTTP 请求。

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

### REST API — `http://127.0.0.1:19555`

所有请求需携带：
```
X-Extension-Name: my-extension
X-Extension-Token: {token}    // 启用拓展时由主程序分配
```

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/v1/info` | GET | 宿主和服务器信息 |
| `/api/v1/books` | POST | 查询书库（分页/搜索） |
| `/api/v1/books/{id}` | GET | 书籍详情 |
| `/api/v1/user` | GET | 当前用户 |
| `/api/v1/server` | GET | 服务器信息 |
| `/api/v1/reader/windows` | GET | 活跃的阅读器窗口列表 |
| `/api/v1/reader/{label}/state` | GET | 阅读器状态 |
| `/api/v1/reader/{label}/command` | POST | 向阅读器发指令 |
| `/api/v1/extension/sidebar/add` | POST | 动态添加侧边栏 |
| `/api/v1/extension/page/register` | POST | 注册自定义页面 |
| `/api/v1/extension/storage/{key}` | GET/PUT/DELETE | 持久化存储 |

### WebSocket 事件 — `ws://127.0.0.1:19556`

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

## 三种拓展类型

### 纯前端拓展

最简单的类型，只有一个 `manifest.json` + `ui/index.html`。
前端通过 fetch/WebSocket 调用主程序 API。
适合：仪表盘、统计面板、简单工具。

### 带后端的拓展

声明 `entry.backend`，主程序启动时自动运行后端程序。
后端程序绑定分配的端口，serve 自己的 UI 和 API。
适合：复杂数据处理、AI 集成、外部服务对接。

### 无头拓展

不声明 `entry`，没有 UI。仅通过 WebSocket 订阅事件做后台处理。
适合：自动同步标注、阅读数据上报、系统钩子。

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

1. **不要硬编码 token**：token 由主程序在启用时分配，应通过环境变量或文件读取
2. **后端程序只用纯文件名**：manifest 中 `executable` 不能包含路径，防止路径穿越攻击
3. **网络请求走主程序代理**：不要直接连接 Talebook 服务器，通过 API Server 代理以确保认证
4. **权限最小化**：只声明拓展真正需要的权限
5. **iframe sandbox**：拓展 UI 运行在 `<iframe sandbox="allow-scripts allow-forms">` 中，能力受限

## 调试

1. 打开 Moke 开发者选项（关于页连点版本号 8 次）
2. 开启调试面板（查看实时日志）
3. 检查 API Server 是否运行: `curl http://127.0.0.1:19555/api/v1/info`
4. 检查拓展目录: `%APPDATA%\com.moke.client\extensions\`
