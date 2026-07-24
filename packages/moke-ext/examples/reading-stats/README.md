# 阅读统计 — 示例拓展

演示 Moke 拓展系统的完整示例。实时显示翻页次数、阅读时长、当前进度。

## 快速打包（一键生成安装器）

```bash
build.bat
```

脚本自动执行：编译 Rust 后端 → 收集文件到 dist/ → 调用 NSIS 生成 `reading-stats-setup.exe`。

**前提条件:**
- [Rust](https://rustup.rs/)（编译后端）
- [NSIS](https://nsis.sourceforge.io/Download)（打包安装器，`makensis` 需在 PATH 中）

## 手动步骤

### 1. 编译后端

```bash
cd backend
cargo build --release
# → target/release/server.exe
```

### 2. 准备打包文件

```
dist/
├── manifest.json        ← 从本目录复制
├── server.exe           ← 从 backend/target/release/ 复制
└── ui/
    └── index.html       ← 从本目录复制
```

### 3. 生成安装器

```bash
makensis installer.nsi
# → reading-stats-setup.exe
```

### 4. 安装 & 启用

1. 双击 `reading-stats-setup.exe` 安装
2. 打开 Moke → 设置 → 拓展管理 → 找到「阅读统计」→ 启用
3. 打开一本书开始阅读，侧边栏「拓展 → 阅读统计」查看实时统计

## 开发调试（跳过安装器）

直接将文件复制到拓展目录：

```
%APPDATA%\com.moke.client\extensions\reading-stats\
├── manifest.json
├── server.exe
└── ui/index.html
```

然后在 Moke 中启用即可。

## 架构

```
manifest.json → 主程序: 分配端口 19557+, 启动 server.exe (注入 MOKE_EXT_TOKEN)
server.exe    → 静态文件服务 + /api/token 端点
ui/index.html → fetch(/api/token) → WS(19556) 认证 → 订阅 reader:* 事件
```
