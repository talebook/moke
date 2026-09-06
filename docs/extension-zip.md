# ZIP 扩展安装与迁移

Moke 桌面版的“扩展 → 导入扩展”使用系统文件选择器。选择作者提供的 `.zip`，核对名称、版本、发布者、来源、签名状态及全部申请权限，再确认安装；同 ID 新版本显示升级前版本、新增/移除权限。取消不改变已安装内容。新安装保持禁用；已启用扩展升级后恢复启用，启动失败则回滚旧包并重试旧后端。

支持 Windows、macOS、Linux 的 x86_64/aarch64 桌面目标；移动端不提供原生扩展导入。原生包必须同时通过签名、`entry.backend.targets` 和 PE/ELF/Mach-O 架构检查。不支持脚本解释器入口。架构检测只识别文件容器，不代替完整 OS loader 校验；加载失败仍走回滚。

## 作者操作

在仓库根目录运行 `pnpm install --frozen-lockfile`，以下从扩展项目目录运行（可将 CLI 注册到 PATH，或使用 `node /path/to/moke/packages/moke-ext/bin/moke-ext.js`）：

```sh
moke-ext validate
moke-ext build
moke-ext sign --key /path/outside/package/publisher.pem --key-id your-key-id
moke-ext package
# 当前目录生成 <name>-<version>.zip
```

作者自行保管 Ed25519 私钥；例如首次本地测试可在项目外执行 `openssl genpkey -algorithm Ed25519 -out publisher.pem`。不要把私钥放进源代码、dist、ZIP 或提交记录。无需 Moke 官方发布密钥：第三方签名有效时显示“未知发布者”，需要显式确认；这不是官方认证，重启后再次启用仍需确认。无原生后端的包可以不签名。

`build` 编译本机 Rust 后端并写入准确的单目标 `targets`。例如：

```json
"backend": {
  "executable": "server.exe",
  "args": ["--ext-port", "{EXT_PORT}"],
  "targets": ["windows-x86_64"]
}
```

跨平台发布时在各目标机器/CI 分别构建、签名、打包，发布时给 ZIP 加上平台后缀。同一 ID 同版本只能安装一份内容；更换架构/文件/来源需提升版本。预编译的非 Rust 后端可手动放进干净的 dist，填写匹配的 targets，再签名、打包。工具不会替作者猜测交叉编译目标。

## 包格式 v1

ZIP 根目录直接包含 `manifest.json`、可选 `signature.json`、后端纯文件名、`ui/` 等资源，不套顶层扩展名目录。仅支持普通文件和目录；不支持加密、链接/特殊文件、未知 ZIP 扩展元数据、绝对/盘符/UNC 路径、反斜杠、`..`、Windows 保留名称、大小写碰撞、NFD 名称和重复条目。

名称使用 **NFC UTF-8**，分隔符为 `/`。摘要在规范化后按完整路径 UTF-8 字节排序（不是 Rust PathBuf 组件序，也不是 JS localeCompare），每个文件写入 `path + NUL + SHA256(bytes) + LF`，前缀为 `moke-extension-package-v1\0`。共享向量在 `tests/fixtures/extension-digest-v1.json`，覆盖 Linux 目录/文件排序及 Windows 分隔符。

最多 10000 条目、单文件 256 MiB、总解压 1 GiB、ZIP 输入 512 MiB；解压逐块计数，不信任 header 的声明尺寸。目录深度最多 32、完整路径 1024 UTF-8 字节、单段 240 字节。`signature.json` 不进入自身摘要；根 `storage.json` 为宿主保留。ZIP 禁止携带宿主状态、点目录及旧 NSIS 文件（`runtime.json`、`trust.json`、`storage.json`、`uninstall.exe`、`installer.nsi`、`*-setup.exe` 等）。旧目录摘要仍保留原格式的可变文件排除规则，不能把这些文件作为入口。

## 事务、数据与失败恢复

包先解压到宿主私有 `.staging`，校验前不运行包内程序。确认票据仅对应本次 staging 内容与已安装摘要，10 分钟过期；同一应用只保留一份待确认包。宿主持有扩展根目录的 OS advisory lock，第二个 Moke 实例会暂停扩展管理并提示关闭旧实例；同一实例内同 ID（以及其他扩展）的安装/启用/禁用/卸载由操作锁串行执行，宿主 storage 路由也与安装互斥。

安装使用 `.transaction` 日志、完整目录 rename 和状态文件原子替换。Windows 文件占用导致 rename 失败时保留旧文件，绝不通过“先删 trust/runtime 再 rename”回退。正式提交标记前失败/重启恢复旧目录和状态；提交后保留新目录。恢复失败停止扩展启动并显示错误，保留日志供恢复。该方案是有崩溃恢复的事务，不是跨多个文件的单次原子系统调用；断电及损坏磁盘的恢复受文件系统持久化保证约束。

宿主 `storage.json` 自动保留。其他旧文件整体保留在 `extensions/.previous/<id>/<transaction-id>/`，不会静默删除，也不会执行旧卸载器。作者的新可变数据应写到 `MOKE_EXT_DATA_DIR`，不要改包内资源。后端启动时可从 `MOKE_EXT_LEGACY_DIR` 读取旧私有数据，首次迁移完成后存入 DATA_DIR；不要缓存这个旧路径，它可能在事务提交时移动。阅读统计示例会迁移旧 stats.json。大型旧包会占用保留空间，应在确认数据已迁移后由开发者自行归档清理。

旧 NSIS 扩展迁移：从作者的干净构建目录重新生成包，添加 publisher/targets，补权限并提升版本，签名后导入。不要直接压缩 AppData 安装目录（含宿主状态和个人数据），不要运行旧卸载器清理。Moke 应用自身的 MSI/NSIS 安装方式不受影响。

后台暂时启动失败或未知发布者在重启时未确认，不删除“期望启用”记录，也不把失败实例放进 API 已启用映射。管理页显示待恢复提示，可重新确认/重试或禁用。

## 旧权限与连接兼容

| 操作 | manifest 权限 |
|---|---|
| `/api/v1/info` | `server.info` |
| 阅读器窗口/状态 | `reader.state.read` |
| 阅读器控制 | `reader.command.send` |
| WebSocket 阅读事件 | `reader.events.subscribe` |
| 添加侧栏 / 注册页面 | `sidebar.add` / `page.register` |
| 宿主键值存储 | `storage` |

旧 manifest 不自动获得额外权限。缺权限响应为 403 / PERMISSION_REQUIRED，说明需更新 manifest、提升版本、重签、导入、重新确认。token 只通过后端环境传递，不提供给 iframe。

REST/WS 使用本次会话 OS 分配的 loopback 端口，保持 Host/Origin/token 门禁。REST 在解析前限制 48 连接，16 KiB/64 请求头、1 MiB body、从接受连接起 5 秒总读取截止时间；拒绝后真正 shutdown，不排空 body。每连接一次请求；要求 HTTP/1.1，拒绝 Transfer-Encoding 和 Expect，请发送 Content-Length。SDK 的 JSON fetch 和常规 HTTP 客户端兼容，手动 chunked 流上传应改为有界 JSON。WS 最多 8 个待认证连接、32 客户端，HTTP upgrade 和 hello 共用 5 秒绝对截止时间与 128 KiB 总读取预算。

## 安全保障边界

隔离 staging、摘要绑定、签名、版本/权限确认与目录事务，防护不可信 ZIP、服务器包内容及宿主自身操作间的替换。Unix 目录 0700、状态临时文件 0600 限制其他账户访问；Windows 使用应用数据目录的继承 ACL。安装目录不是强制只读或 OS 级不可变存储。

**不能防御拥有同一用户权限、可任意写 AppData/操纵进程的恶意本地进程。** 它可能在最后一次验证与 OS loader 打开文件之间替换后端/依赖/UI，或修改宿主授权记录。再次哈希只拒绝已观察到的变化，不消除最终路径重开竞态。原生后端不是沙箱，也无法把权限声明当作其 OS 权限限制。更强保证需要独立账户/受保护安装服务、OS 代码签名/不可变映像和平台专属加载方案；本实现不声称具备这些能力。
