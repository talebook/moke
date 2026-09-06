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
