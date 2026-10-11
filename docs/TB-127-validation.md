# TB-127 验证与交付记录

已实现桌面 ZIP 导入、内容绑定确认、安装/升级事务及安全阻碍修复。无合并、发布或部署操作；代码交付不等于 TB-125 整体安全复测通过。

## 联合基线

- main：`326881943b785ebbe2264fd9bf149ddec095b6da`，交付前重新 fetch 确认未变化。
- #111：`7530567aab7f1654986bbd93460a38b0c35302f6`。
- #115：`310c9b2177d16020904ebcbd74d09055d462bd42`。
- 当前 Reader gitlink：`78cec4eb56455a018bbcf5bd6bce530a5fa9d8db`，保持不变。
- 在独立分支整合上述两个 PR，解决 events/lifecycle 的交互冲突，同时保留权限快照与 token 比较。不修改/关闭原 PR，不解除 #111“暂不合并”。新 PR 承接两个 PR 的实现；评审合入时应避免再次机械叠加旧分支。

## 本地验证

| 验证 | 结果 |
|---|---|
| `pnpm install --frozen-lockfile` | 通过，根与 moke-ext 两个 workspace；Reader 仍为独立 workspace |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 0 errors、23 条既有 warnings |
| `pnpm test` | 415 passed |
| `node --test tests/extension-signing.test.mjs tests/extension-zip.test.mjs` | 最终 CLI 修改后 4 passed |
| `CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --lib extensions:: --quiet` | 61 passed；本次同时设置 `MOKE_TEST_IMPORT_ZIP` 为实际生成 ZIP 的绝对路径 |
| `cargo test`（reading-stats/backend，关闭测试调试符号） | 4 passed |
| `pnpm exec playwright test --config tests/extension-import.config.mjs` | 1 passed；真实 Chromium 页面，Tauri IPC/文件选择结果使用 mock |
| CLI reading-stats 构建、签名、打包 → Rust 导入 → 显式启用 | Linux x86_64 通过；导入保持未启用，单独授权后启动真实后端，测试结束清理子进程 |

Rust 回归覆盖有效签名/篡改/密钥轮换/降级、Node 签名 golden fixture、跨语言摘要与 Windows 分隔符向量、危险路径/链接/重复条目/中央目录炸弹/实际解压字节限额、取消/失效票据/确认后变化、权限增加、升级注入失败回滚与旧启用恢复、同目录跨实例锁、状态替换失败不删除旧文件、旧 token 清理且保留期望启用、真实 socket 慢头/慢 body/拒绝不排空/48 连接限制与恢复、WS 绝对握手截止时间和凭据校验。

第一次完整 Rust 测试因带调试符号的 Readest 静态库耗尽磁盘失败；清理本次 checkout 的生成产物，禁用调试符号后完整重跑上述扩展测试通过。CLI 实际 ZIP 启用测试曾因测试夹具 WS 端口为 0 而失败，改为测试专用隔离监听端口后通过。Node 源码形状断言已随两个 PR 整合更新；UI 测试显式等待隐私确认渲染后再操作。

未在原生 GUI 中操作 OS 文件选择器，未在 Windows/macOS/ARM 真机执行导入，也未验证断电、杀软占用、进程内存攻击。Windows sharing violation 回归已提供但本机 Linux 不执行该条件用例。CI 由推送触发，本任务未要求等待结果。

## 示例附件

`reading-stats-1.1.0-linux-x86_64-test.zip`：606342 字节，SHA-256 `1541a34fdb226c2719cb2d204b03a1c040c5cf3dd94ea6461c3d9196a83db84b`。这是本地测试签名，发布者 `org.example.tb127`，不是官方发布；私钥已删除。用于评审导入流程，仅适用于 Linux x86_64。普通作者的构建、签名、导入与迁移步骤见 `docs/extension-zip.md`。

## DeepSec Shield

- DeepSec **0.2.0**，来源提交 `fff031fc01fb36b95348214c8ee359f6ede8aa8b`。
- 最终命令（仓库根目录）：`/opt/deepsec/fff031fc01fb36b95348214c8ee359f6ede8aa8b/venv/bin/deepsec shield scan . --layer l1,l2 --include-tests --format json --output -`。
- stdout：`.deepsec/deepsec-report.json`；stderr：`.deepsec/deepsec-stderr.txt`；退出码：`.deepsec/deepsec-exit-code.txt`。
- 最终扫描 **2456 文件，L1 + L2，退出码 2，43 findings（16 critical / 20 high / 7 medium）**。退出码来自有效报告的高危发现，不是参数错误；最终 stderr 为空。没有启用 L3/Spear 或上传源码到 LLM。
- 以 main 基线核对已提交、暂存、工作树及新增文件。扫描范围为整个当前 checkout（含测试、示例、未修改 Reader 和部分生成元数据）；候选文件无越出仓库的符号链接。**本次改动文件上 0 findings；全仓扫描不算通过。**
- 第一轮曾因 UI runner 正好清理 test-results 导致目录遍历失败（退出 1、空报告），随后在测试结束后的稳定目录上重扫；最终报告为最新代码对应的有效报告。
- 扫描器不支持 TOML、BAT、HTML、CSS、Markdown、lockfile 语义等。此任务的 Cargo 配置与 10 份自动生成的命令 ACL TOML、build.bat 已人工核对；依赖锁通过安装/编译检查，fixture 数据由跨语言/真实导入测试验证。L2 使用正则/Python AST，不等同完整 Rust/TypeScript 语义安全分析。
- 附件报告把路径改为仓库相对路径，并隐藏 critical 项的字面量 evidence；原始本地报告保留原发现。下表记录全部 findings 的处理，未修改无关/已取消任务范围。

## Findings 处置

| 位置 | 级别 | 处理 |
|---|---|---|
| `readest/apps/readest-app/src/__tests__/components/debug-log-integration.test.tsx:64` | high | 既有测试夹具/静态测试 HTML，非产品新增秘密或 sink。 |
| `readest/apps/readest-app/src/__tests__/components/debug-log-integration.test.tsx:93` | high | 既有测试夹具/静态测试 HTML，非产品新增秘密或 sink。 |
| `readest/apps/readest-app/src/components/metadata/BookDetailView.tsx:452` | high | 既有 Reader HTML sink/消毒识别告警，需结合来源和 sanitizer 独立复核；本任务未修复。 |
| `readest/apps/readest-app/src/app/reader/components/TableViewer.tsx:224` | high | 既有 Reader HTML sink/消毒识别告警，需结合来源和 sanitizer 独立复核；本任务未修复。 |
| `readest/apps/readest-app/src/app/reader/components/annotator/AnnotationNoteItem.tsx:124` | high | 既有 Reader HTML sink/消毒识别告警，需结合来源和 sanitizer 独立复核；本任务未修复。 |
| `readest/apps/readest-app/src/app/reader/components/sidebar/BooknoteItem.tsx:252` | high | 既有 Reader HTML sink/消毒识别告警，需结合来源和 sanitizer 独立复核；本任务未修复。 |
| `readest/apps/readest-app/src/app/reader/components/paragraph/ParagraphOverlay.tsx:79` | high | 既有 Reader HTML sink/消毒识别告警，需结合来源和 sanitizer 独立复核；本任务未修复。 |
| `readest/apps/readest-app/src/utils/warichu.ts:325` | high | 既有 Reader HTML sink/消毒识别告警，需结合来源和 sanitizer 独立复核；本任务未修复。 |
| `readest/apps/readest-app/src/utils/warichu.ts:335` | high | 既有 Reader HTML sink/消毒识别告警，需结合来源和 sanitizer 独立复核；本任务未修复。 |
| `readest/apps/readest-app/src/libs/edgeTTS.ts:35` | critical | 未修改 Reader 中的协议常量/标识/示例等字面量告警；不将全部告警认定为真实秘密，也不宣称已消除；留独立复核。 |
| `readest/apps/readest-app/src/libs/share.ts:73` | medium | 既有 Reader 错误详情透传告警；本任务未修改，留独立复核。 |
| `readest/apps/readest-app/src/services/mokeBridge.ts:337` | medium | 既有 Reader 错误详情透传告警；本任务未修改，留独立复核。 |
| `readest/apps/readest-app/src/services/ai/adapters/TauriChatAdapter.ts:48` | medium | 既有 Reader 错误详情透传告警；本任务未修改，留独立复核。 |
| `readest/apps/readest-app/src/services/ai/providers/AIGatewayProvider.ts:70` | medium | 既有 Reader 错误详情透传告警；本任务未修改，留独立复核。 |
| `readest/apps/readest-app/src/services/ai/providers/ProxiedGatewayEmbedding.ts:30` | medium | 既有 Reader 错误详情透传告警；本任务未修改，留独立复核。 |
| `readest/apps/readest-app/src/services/sync/providers/oauth/tokenEndpoint.ts:37` | critical | 未修改 Reader 中的协议常量/标识/示例等字面量告警；不将全部告警认定为真实秘密，也不宣称已消除；留独立复核。 |
| `readest/apps/readest-app/src/services/sync/providers/oauth/tokenEndpoint.ts:43` | critical | 未修改 Reader 中的协议常量/标识/示例等字面量告警；不将全部告警认定为真实秘密，也不宣称已消除；留独立复核。 |
| `readest/apps/readest-app/src/services/sync/providers/oauth/tokenEndpoint.ts:129` | medium | 既有 Reader 错误详情透传告警；本任务未修改，留独立复核。 |
| `readest/apps/readest-app/src/services/sync/providers/onedrive/OneDriveProvider.ts:163` | medium | 既有 Reader 错误详情透传告警；本任务未修改，留独立复核。 |
| `readest/apps/readest-app/src/services/sync/providers/onedrive/onedriveTokenStore.ts:8` | critical | 未修改 Reader 中的协议常量/标识/示例等字面量告警；不将全部告警认定为真实秘密，也不宣称已消除；留独立复核。 |
| `readest/apps/readest-app/src/services/sync/providers/onedrive/webAuthCodeFlow.ts:35` | critical | 未修改 Reader 中的协议常量/标识/示例等字面量告警；不将全部告警认定为真实秘密，也不宣称已消除；留独立复核。 |
| `readest/apps/readest-app/src/services/sync/providers/onedrive/microsoftOAuthConfig.ts:13` | critical | 未修改 Reader 中的协议常量/标识/示例等字面量告警；不将全部告警认定为真实秘密，也不宣称已消除；留独立复核。 |
| `readest/apps/readest-app/src/services/sync/providers/gdrive/googleOAuthConfig.ts:16` | critical | 未修改 Reader 中的协议常量/标识/示例等字面量告警；不将全部告警认定为真实秘密，也不宣称已消除；留独立复核。 |
| `readest/apps/readest-app/src/services/sync/providers/gdrive/driveTokenStore.ts:8` | critical | 未修改 Reader 中的协议常量/标识/示例等字面量告警；不将全部告警认定为真实秘密，也不宣称已消除；留独立复核。 |
| `readest/apps/readest-app/src/services/sync/providers/gdrive/auth/webTokenStore.ts:14` | critical | 未修改 Reader 中的协议常量/标识/示例等字面量告警；不将全部告警认定为真实秘密，也不宣称已消除；留独立复核。 |
| `readest/apps/readest-app/src/services/dictionaries/providers/wikipediaProvider.ts:52` | high | 既有 Reader HTML sink/消毒识别告警，需结合来源和 sanitizer 独立复核；本任务未修复。 |
| `readest/apps/readest-app/src/services/dictionaries/providers/wikipediaProvider.ts:67` | high | 既有 Reader HTML sink/消毒识别告警，需结合来源和 sanitizer 独立复核；本任务未修复。 |
| `readest/apps/readest-app/src/services/dictionaries/providers/mdictProvider.ts:547` | high | 既有 Reader HTML sink/消毒识别告警，需结合来源和 sanitizer 独立复核；本任务未修复。 |
| `readest/apps/readest-app/src/services/dictionaries/providers/mdictProvider.ts:588` | high | 既有 Reader HTML sink/消毒识别告警，需结合来源和 sanitizer 独立复核；本任务未修复。 |
| `readest/apps/readest-app/src/services/dictionaries/providers/wiktionaryProvider.ts:39` | high | 既有 Reader HTML sink/消毒识别告警，需结合来源和 sanitizer 独立复核；本任务未修复。 |
| `readest/apps/readest-app/src/services/dictionaries/providers/wiktionaryProvider.ts:148` | high | 既有 Reader HTML sink/消毒识别告警，需结合来源和 sanitizer 独立复核；本任务未修复。 |
| `readest/apps/readest-app/src/services/dictionaries/providers/bglProvider.ts:77` | high | 既有 Reader HTML sink/消毒识别告警，需结合来源和 sanitizer 独立复核；本任务未修复。 |
| `readest/apps/readest-app/src/services/dictionaries/providers/starDictProvider.ts:58` | high | 既有 Reader HTML sink/消毒识别告警，需结合来源和 sanitizer 独立复核；本任务未修复。 |
| `readest/apps/readest-app/src/services/dictionaries/providers/slobProvider.ts:38` | high | 既有 Reader HTML sink/消毒识别告警，需结合来源和 sanitizer 独立复核；本任务未修复。 |
| `readest/apps/readest-app/src/services/transformers/warichu.ts:55` | high | 既有 Reader HTML sink/消毒识别告警，需结合来源和 sanitizer 独立复核；本任务未修复。 |
| `readest/apps/readest-app/src-tauri/plugins/tauri-plugin-turso/guest-js/index.ts:202` | critical | 未修改 Reader 中的协议常量/标识/示例等字面量告警；不将全部告警认定为真实秘密，也不宣称已消除；留独立复核。 |
| `src/app/layout.tsx:101` | high | 既有固定宿主脚本常量注入；不是此任务引入的不可信 HTML。 |
| `.github/workflows/build-release.yml:303` | critical | 既有 shell 环境变量引用被判为常量秘密；未新增实际凭据，保留规则报告。 |
| `.github/workflows/build-release.yml:331` | critical | 既有 shell 环境变量引用被判为常量秘密；未新增实际凭据，保留规则报告。 |
| `.github/workflows/build-release.yml:332` | critical | 既有 shell 环境变量引用被判为常量秘密；未新增实际凭据，保留规则报告。 |
| `.github/workflows/build-release.yml:334` | critical | 既有 shell 环境变量引用被判为常量秘密；未新增实际凭据，保留规则报告。 |
| `tests/captcha-sandbox.spec.mjs:110` | critical | 既有测试夹具/静态测试 HTML，非产品新增秘密或 sink。 |
| `tests/captcha-sandbox.spec.mjs:153` | critical | 既有测试夹具/静态测试 HTML，非产品新增秘密或 sink。 |

## 保留的边界

同用户恶意进程可忽略 advisory lock、修改 AppData 或干预 OS loader，因此最后一次哈希到执行之间仍有竞态；没有声称通过重复哈希彻底解决。原生后端也不是沙箱。升级保留完整旧目录和宿主 storage，新私有数据使用 DATA_DIR；旧目录会占用磁盘，不自动删除。REST 现在要求 Content-Length、每连接一个请求，拒绝 chunked/Expect，迁移已说明。正式根密钥、在线撤销、token TTL 刷新与独立整体复测仍是后续范围。

## 2026-09-06 界面反馈调整

- 导入按钮移至页面标题右侧；空状态保留原有灰色拼图图标及提示样式，在标题下方剩余内容区域居中。恢复“管理已安装的拓展程序”副标题。
- `pnpm typecheck`、`pnpm exec eslint src/app/extensions/page.tsx` 通过。复用现有 Playwright 导入验证场景做临时截图运行：1 passed，覆盖预览、取消、提交及导入后从空状态进入列表；检查 1280×720 桌面和 390×844 窄屏截图。截图使用模拟 Tauri IPC，不代表原生文件选择器或移动设备实测。
- 最终 DeepSec 0.2.0（来源 `fff031fc01fb36b95348214c8ee359f6ede8aa8b`），仓库根命令：`/opt/deepsec/fff031fc01fb36b95348214c8ee359f6ede8aa8b/venv/bin/deepsec shield scan . --layer l1,l2 --include-tests --format json --output -`。
- 覆盖全仓 2457 文件（含测试及本地测试结果元数据），L1/L2，退出码 2；stderr 为空。候选路径已检查，无越出仓库的符号链接。43 条发现（16 critical / 20 high / 7 medium）的位置、规则及证据与调整前一致，处置沿用上表；本任务改动文件仍无 findings，全仓不能称安全通过。TSX 已覆盖，其余格式限制沿用前述说明。
- stdout、stderr、退出码保留在 `.deepsec/`；脱敏报告及空状态桌面/窄屏、已安装列表截图附在 issue 回复中。未启用远程 LLM、L3 或 Spear。

## 2026-10-11 PR #131 冲突整合

开发者明确要求解决 #131 冲突，并将依赖 PR 的改动收拢到 #131 后关闭依赖 PR。本轮授权替代首次交付时“不关闭 #111/#115”的操作安排，目标仍为更新 #131 的工作分支。

- 合入 main `05f5d145096b6fa1c015a87333d71ae89e5e1a44`。#111 `7530567aab7f1654986bbd93460a38b0c35302f6` 和 #115 `310c9b2177d16020904ebcbd74d09055d462bd42` 已经是原 #131 head 的祖先，保留完整提交历史，无需再次 cherry-pick。
- 解决 Cargo、build.rs、主 WebView capability、生成 ACL 数据及 extensions API/events/mod 冲突。REST 复用 main 的有界 `http_transport`，保留 #131 的随机会话端口、Host/Origin/token 与权限快照检查；保留 main 的 POST/PUT Content-Length 和完整正文检查。连接上限采用 main 的 32，认证后支持合法 Expect: 100-continue，同步作者文档。
- WebSocket 共用 main 的 DeadlineStream，保留 #131 更严格的 8 个待认证连接、32 个客户端、128 KiB 握手预算和 Origin/订阅权限门禁。合并并适配 main 的慢 Upgrade、Ping/慢认证帧、容量回收与事件重放真实 socket 回归，补充 Host/Origin/权限联合回归。移除被统一传输替代的旧 transport 模块。
- Reader gitlink 随本次 main 合入更新为 `4b3db91bd1d94e5e9063639964f95a407334e81f`；本轮没有修改 Reader 代码。
- 使用仓库固定 Tauri fork 的 tauri-build 编译并执行真实 `src-tauri/build.rs`，以 main 已生成的插件权限作为输入重新生成 app ACL、capability 及 schema。逐项比对插件 manifest 与 main 完全一致；Reader capability 不含 ZIP 管理权限。该构建脚本验证不等同完整原生编译。

| 本轮检查 | 结果 |
|---|---|
| `pnpm install --frozen-lockfile` | 通过，pnpm 9.15.9、Node 24.21.0 |
| `pnpm test` | 491 passed |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 0 errors / 23 warnings |
| `cargo test --manifest-path tests/extension-transport/Cargo.toml --locked --offline` | 19 passed；编译实际生产 HTTP/WS/安全模块，目标目录与调试信息采用本轮临时配置 |
| `cargo test --manifest-path packages/moke-ext/examples/reading-stats/backend/Cargo.toml --locked` | 4 passed |
| `pnpm exec playwright test --config tests/extension-import.config.mjs` | 1 passed，IPC mock |
| 官方 Playwright MCP，`http://127.0.0.1:32131/extensions` | 独立临时 context；1280×900 和 390×844，发布者/升级/权限 diff 展示、取消不提交、确认绑定 ticket/digest 均通过 |
| Tauri build.rs / ACL 重新生成 | 退出 0，插件权限未变化，扩展管理只授予 main |
| `git diff --check` | 通过 |

MCP 首轮桌面控制台出现一条资源 404，未捕获失败请求；随后单独复查该页面无 >=400 响应或控制台错误。窄屏轮无控制台错误或失败请求。浏览器和本轮 Next 测试服务均已关闭。执行者为 Codex 当前 GPT-6 会话；数据为虚构扩展，Tauri IPC 使用 mock。

完整 `cargo check --manifest-path src-tauri/Cargo.toml --lib --locked --offline` 未完成：缺少 vendor/openharmony-ability 等原生子模块，当前磁盘空间不足以继续完整构建。本轮没有重新运行完整 ZIP 原生安装/回滚验收、原生 OS 文件选择器、跨平台真机或 DeepSec 全仓扫描。历史自测/安全扫描不能代表本轮固定 head 的独立 QA 结论；新 head 与本轮证据交回 TB-127，由 Mika 安排现有 Sol/Grok 独立复核。


## #131 review 修复

重新 fetch main 与 PR 分支，main 仍为 `05f5d145096b6fa1c015a87333d71ae89e5e1a44`，已是 #131 的祖先，因此本次 `git merge origin/main` 返回 Already up to date，不创建空合并。#111 / #115 的完整 head 仍是祖先；两个依赖 PR 保持关闭。

- WS 在包装 DeadlineStream / HTTP Upgrade 前显式恢复阻塞模式。新增真实 TCP 回归，主动把 accept socket 设为 nonblocking 并分两段发送 Upgrade，验证认证成功；绝对截止时间、预算及权限校验保持不变。
- 启用、禁用、卸载、取消导入均改为 async + spawn_blocking，操作锁在阻塞线程中获取，磁盘读取、等待进程、目录删除不占 IPC 主线程。
- 列表仅在轻量发现和状态快照时持操作锁，验签及完整摘要在释放锁后执行。内存展示缓存按 manifest、包文件/签名/trust.json 的路径、大小、修改时间失效；卸载条目被清除。缓存不是安全授权依据：启用、恢复和提交仍做完整新校验。回归明确演示“同大小且恢复 mtime 的篡改可能保留展示摘要，但启用仍拒绝”。
- `pnpm test:e2e:extensions` 接入独立 CI job，专用 Tauri-mode Next 服务运行 extension-import、comic-reader、detail-actions 三份 spec。与原 Web job 分开，避免并行使用同一 Next 输出目录。首次运行暴露窄屏末页恢复时的上游中心选页行为：短末页没有足够底部滚动空间，切换长条模式把进度回写为上一页。Moke 的宿主 CSS 增加半屏尾部空间，保留固定的第三方产物；既有 390px/1280px 末页恢复回归验证该修复。
- reading-stats 静态路径按组件拒绝根路径、父路径、反斜杠、Windows 驱动器和控制字符；增加 `%2F`、编码遍历、UNC/驱动器及正常资源路径用例。注释明确 `/api/stats` 为严格 Host、无 CORS 的回环同源只读服务，同用户进程仍可读取；不向浏览器下发宿主 token。
- 保留未知签名发布者每次启用确认策略，在 trust.rs 和作者文档说明空内置根、再次启用与重启待恢复行为。回归验证历史 grant 不能授权无确认启动，同一摘要再次显式确认仍可通过。

验证结果在本轮提交前记录；临时无 GUI 核心 harness 通过 path 引用生产 discovery/installer/lifecycle/trust/package_path/events/deadline_stream/security/http_transport/permissions/storage 模块，逐字提取 runtime 数据结构和 activate/start/stop/list helpers，以 url crate 提供 URL 类型、空 PendingCommands 替代 API 注册表。它验证核心 Rust 行为，但不编译 Tauri IPC commands/宏、完整 REST 路由或 Reader。可选实际 CLI ZIP 用例本轮没有 MOKE_TEST_IMPORT_ZIP 输入，提前返回，不能据此声称重做真实 CLI 包启用验收。


| 本轮验证 | 结果 |
|---|---|
| `pnpm test` | 491 passed |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 0 errors / 23 条既有 warnings |
| `cargo test --manifest-path tests/extension-transport/Cargo.toml --locked --offline -- --test-threads=1` | 20 passed |
| 核心 Rust 临时无 GUI harness（上述边界） | 59 passed，含 1 条无外部 ZIP 输入时提前返回的可选用例 |
| `cargo test --manifest-path packages/moke-ext/examples/reading-stats/backend/Cargo.toml --locked --offline` | 5 passed |
| `pnpm test:e2e:extensions` | 最终完整重跑 38 passed；真实 Chromium，Tauri/HTTP mock |
| `node --test --experimental-strip-types tests/comic-reader.test.mjs` | 尾部样式修复后 6 passed |
| CI YAML 解析、`git diff --check`、main/#111/#115 ancestry 核对 | 通过 |

Rust target 与本轮 Next 输出放在 tmpfs 以避免磁盘耗尽。首次浏览器启动因临时迁移 Next 缓存导致 tailwind 模块解析失败，修复本机模块解析后重跑；首次 WS 夹具过早发送认证帧，被 HTTP Upgrade 正确拒绝，改为先读响应后完整重跑通过。typecheck 首次与缓存迁移冲突，稳定缓存后重跑通过。这些失败未算作通过证据。

完整 `cargo check --manifest-path src-tauri/Cargo.toml --lib --locked --offline` 仍在解析依赖时因缺失 `vendor/openharmony-ability/crates/ability/Cargo.toml` 停止。未执行原生 GUI、OS 文件选择器、macOS/Windows 真机、真实 CLI ZIP 后端启动或本轮全仓安全扫描。所有本轮测试服务已关闭；CI 由推送触发，本轮不等待外部结果。
