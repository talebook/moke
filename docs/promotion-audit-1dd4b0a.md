# 非 Preview 改动移植审计

来源：`hehetoshang/moke`，截止 `1dd4b0aa908a4e935fc10dc434c1631519de4a64`（包含该提交）。
稳定基线：`talebook/moke:main` / `484475e`；共同祖先：`29b8cb7`。

共核对 37 个源提交（含合并节点）。按文件及具体行为人工分类，未依据 commit 前缀自动选取。未合并整个 fork，未修改版本号，未引入 Preview 授权、控制平面、设备凭据、签名分发或 CI 豁免。Reader 和 vendor gitlink 均不变。

## 逐提交清单

| 源提交 | 原始标题 | 处置 | 理由与提取范围 |
|---|---|---|---|
| [`9bdbe95`](https://github.com/hehetoshang/moke/commit/9bdbe955ea95f4f26f6c3aea95584d77dba189b0) | feat: establish preview build foundation | 排除 | Preview 构建通道、feature、配置及能力清单；通用路径里的变更也是该通道的接线。 |
| [`5632db6`](https://github.com/hehetoshang/moke/commit/5632db6be3d7fb1a2611fb8fe5194b94d4552a2e) | feat: add Preview device entitlement client | 排除 | 设备授权客户端、激活门禁、IPC 权限及授权依赖。 |
| [`d357d4e`](https://github.com/hehetoshang/moke/commit/d357d4e27841e8ea2094ad6275820ccd06d5b01b) | ci: skip unavailable preview checks | 排除 | 私有 fork 的 CI 可用性豁免；不降低稳定版 PR 构建或 CodeQL 门禁。 |
| [`cfff24f`](https://github.com/hehetoshang/moke/commit/cfff24f5b2350e5cfdcfc9ab8ab28fae56aad8b0) | Merge branch 'preview/foundation' into preview/entitlement | 不重复移植 | 合并节点；实际内容在源提交逐项分类。 |
| [`d104aac`](https://github.com/hehetoshang/moke/commit/d104aac0fe3d81b721db692b91da83b8279e1417) | fix: harden preview entitlement checks | 排除 | 授权完整性检查及仅供 preview-lock 的 CSS。 |
| [`2668dd9`](https://github.com/hehetoshang/moke/commit/2668dd9c4896f232b3f8d2b97a9d9dc780e15622) | Merge pull request #3 from hehetoshang/preview/entitlement | 不重复移植 | 授权分支合并节点；不整体合并。 |
| [`4087624`](https://github.com/hehetoshang/moke/commit/4087624bb0146318b576d9aebf4bd0f3ed354cdf) | fix: enforce preview entitlement at runtime | 排除 | Preview feature/前端/包名一致性校验与授权命令包装。 |
| [`f570a45`](https://github.com/hehetoshang/moke/commit/f570a45245c48d7e167755abf3faac8eba5ce0df) | fix: isolate preview authorization lifecycle | 排除 | 授权撤销时关闭扩展进程和 pending commands；这些接口仅供 Preview 生命周期使用。 |
| [`375109b`](https://github.com/hehetoshang/moke/commit/375109ba32a79b93f890b0065413fc286888bf80) | feat: harden preview release distribution | 手动提取 | 仅提取 updater 清单的通用生成、版本/URL 校验、平台优先级及参数化；排除受控分发工作流、签名器配置及更新授权。 |
| [`5a33e4b`](https://github.com/hehetoshang/moke/commit/5a33e4b98a0d922d71842e1bf98a812c294cb583) | fix: close preview security review gaps | 手动提取 | 提取扩展 REST 并发/正文限制和 WS 握手并发、超时、消息大小限制及原有 Rust 测试；提取通用 updater 签名/重复资产校验；排除授权安全存储及 Preview release 修复。 |
| [`fcbcb09`](https://github.com/hehetoshang/moke/commit/fcbcb09c4d6b668118307954b31c4bfc358f46c0) | fix: skip macOS preview auto-updates | 排除 | 仅供 Preview 的 macOS 自动更新排除选项；稳定 updater 保留 Darwin 平台。 |
| [`ab75093`](https://github.com/hehetoshang/moke/commit/ab75093cc811f4fc4d7c8a0a7dc94ba4c7749088) | feat: add preview entitlement control plane | 排除 | Preview 控制平面、数据库、部署、配置与测试。 |
| [`eba003b`](https://github.com/hehetoshang/moke/commit/eba003bcefaa8bd7c8202e899b6aaaac8a1978a4) | ci: test preview control plane | 排除 | Preview 控制平面 CI。 |
| [`77a0cd2`](https://github.com/hehetoshang/moke/commit/77a0cd2bd0fc15d48280c811f91e0ece83f0358b) | feat: allow loopback entitlement service in debug builds | 排除 | 仅允许开发态 loopback 授权服务。 |
| [`ba5a9fe`](https://github.com/hehetoshang/moke/commit/ba5a9fe0bd6ac2c1be073c5693c24cddb83258ab) | fix: remove desktop window minimum size | 手动提取 | 仅移除稳定桌面四份配置的 minWidth/minHeight，并保留 resize 测试；排除 Preview 窗口配置和运行时。 |
| [`956653a`](https://github.com/hehetoshang/moke/commit/956653a65f7e7094690f0f384f46e04341ccaed1) | fix: allow retrying preview entitlement refresh | 排除 | 授权刷新重试 UI。 |
| [`d0e35d7`](https://github.com/hehetoshang/moke/commit/d0e35d784e869b37966d9b77e6246c7ee2989444) | chore: move Preview control plane to private repository | 排除 | 将 Preview 控制平面移入私有仓库。 |
| [`ae0d4da`](https://github.com/hehetoshang/moke/commit/ae0d4da7eef9dd1fa7172269d235d7394f307761) | feat: support secure preview device transfer | 排除 | 授权租约的安全换机协议。 |
| [`2c1c081`](https://github.com/hehetoshang/moke/commit/2c1c081176bdbf9cbfab25681c77a0540b3311e1) | Merge pull request #6 from hehetoshang/preview/control-plane | 不重复移植 | 合并节点；窗口调整在 ba5a9fe 单独提取。 |
| [`4b8c9e4`](https://github.com/hehetoshang/moke/commit/4b8c9e405cb7288044386884a8beb4942d4d762b) | fix: expose preview startup retry | 排除 | Preview 授权启动重试。 |
| [`fe1ce69`](https://github.com/hehetoshang/moke/commit/fe1ce69569e80ac607650efe01197af5045b1a34) | Merge pull request #2 from hehetoshang/preview/foundation | 不重复移植 | Preview foundation 的累计合并节点；没有直接合并分支。 |
| [`c4ba391`](https://github.com/hehetoshang/moke/commit/c4ba391819fc76694f2e4d1aba54e4625fb32e27) | chore: merge talebook main into fork | 已在 upstream | 同步 talebook/main；提交的 issue forms 与 promote 规范已在稳定版历史中。 |
| [`886e68b`](https://github.com/hehetoshang/moke/commit/886e68b5311610337c73607d4694a59005ec2aee) | Merge pull request #13 from hehetoshang/sync/talebook-main-20260926 | 不重复移植 | 同步分支合并节点，无额外稳定功能。 |
| [`979eddb`](https://github.com/hehetoshang/moke/commit/979eddb5bbaa06683d6876fea5493d201db80684) | fix(ohos): use Huawei profile bundle identifier (#17) | cherry-pick -x | 源码 diff 不含 Preview 接线：OHOS 华为 Profile 包名、严格单一包名的 CLI 例外、显式 OHOS 配置、HAP 身份断言和测试。不会引入签名器。包名变化及设备兼容性仍需原生验证。 |
| [`cc61033`](https://github.com/hehetoshang/moke/commit/cc61033be01c40afdc462994c2ac514c0ad24ec2) | chore: bump version to 1.1.6 for Preview | 排除 | Preview 版本号。 |
| [`c26221e`](https://github.com/hehetoshang/moke/commit/c26221e2a08f857927db84c7edfa721ff04741c5) | preview: bump version to 1.1.7 | 排除 | Preview 版本号。 |
| [`08ba4ec`](https://github.com/hehetoshang/moke/commit/08ba4ecaea3b1421a93f8ada2bfeb4e47a7fd6a7) | preview: sign and verify OHOS release packages | 排除 | fork/Preview 签名发布基础设施及原生身份转换；依赖 Actions secrets，改变稳定版未签名产物契约。 |
| [`f009848`](https://github.com/hehetoshang/moke/commit/f009848fe0346a0738a90e70db8e1555d8ef8887) | preview: document upstream-aligned four-part version policy | 排除 | 仅供 Preview 的四段版本策略。 |
| [`8490772`](https://github.com/hehetoshang/moke/commit/8490772037faba3e6a09a1fe435c8778646ed287) | preview: align mobile build identity and name validation [skip ci] | 手动提取 | 仅提取 iOS 名称校验对显式构建配置的支持及测试，测试改用普通 Custom 配置；排除 Preview 包名/feature 一致性及 OHOS 签名身份转换。 |
| [`cd15198`](https://github.com/hehetoshang/moke/commit/cd15198c43de98d474d861a635d73789877fc1ed) | preview: fix OHOS capabilities and iOS protected keychain [skip ci] | 排除 | Preview OHOS bootstrap 权限及授权设备密钥的受保护 iOS Keychain。 |
| [`2659c9a`](https://github.com/hehetoshang/moke/commit/2659c9aab0288e584be42cb78d3c359c19c89c2d) | preview: set internal version for 1.1.5.1 [skip ci] | 排除 | Preview 内部版本号。 |
| [`1d8edb3`](https://github.com/hehetoshang/moke/commit/1d8edb3959eac7acd0ffb7448ac9416f0b14bef8) | preview: use MSI-compatible numeric revision [skip ci] | 排除 | Preview MSI 数字修订号策略及版本。 |
| [`3ace410`](https://github.com/hehetoshang/moke/commit/3ace4106feddc6eab4d7a392342ed56e90de5f50) | preview: document latest release publishing policy [skip ci] | 排除 | Preview 发布规范。 |
| [`dc66f77`](https://github.com/hehetoshang/moke/commit/dc66f77781952e211773f21d6f6a5e200d8dace6) | preview: sign and verify Android release APKs [skip ci] | 排除 | Preview APK 签名/发布脚本及专属发布规范。 |
| [`78560fe`](https://github.com/hehetoshang/moke/commit/78560fe11a592c50cb415a366bc1ac902fc1f078) | preview: use native mobile device credential stores [skip ci] | 排除 | Preview 设备身份凭据的 Android Keystore / OHOS Asset Store；stable 没有对应授权功能。 |
| [`66f37f9`](https://github.com/hehetoshang/moke/commit/66f37f911ae1f7bafd6221dafe371669762bae4c) | preview: prepare 1.1.5.3 release [skip ci] | 排除 | Preview 发布版本。 |
| [`1dd4b0a`](https://github.com/hehetoshang/moke/commit/1dd4b0aa908a4e935fc10dc434c1631519de4a64) | promote: add opt-in developer sample book [skip ci] | cherry-pick -x，文档适配 | 默认不导入的原创示例 EPUB、开发者导入/删除、本地书架与进度隔离及测试；README 适配新的 upstream 结构，保留最新漫画阅读器逻辑。 |

## 稳定版适配与兼容性

- OHOS `identifier` 从 `org.houheya.moke` 改为 Profile 绑定的 `org.houheya.moke_openharmony`。这会改变应用身份，旧稳定包的直接升级、数据迁移以及与 Preview 共存均未验证；不引入 Profile 或签名密钥。合并前需 QA 对这一兼容性给出明确结论。
- 扩展资源限制与已有 [PR #115](https://github.com/talebook/moke/pull/115) 重叠。这里仅移植源提交中的资源限制，不替代 #115 的 Host/Origin、CORS、token 等更完整加固；后续合并需去重。
- updater 默认仍使用稳定 tag 及 `talebook/moke/releases/download`，继续支持 macOS，签名缺失时仍成功跳过；不接入 Preview tag 解析或 Darwin 排除选项。重复资产、无效签名与无效版本现在会失败，新增测试覆盖这些行为。
- 示例书使用已有离线存储和阅读器契约；Web 验证仅覆盖导入/删除、离线书库和本地书架。原生阅读器打开、退出、设备文件释放需桌面/移动原生环境验证。
- iOS 名称校验默认路径不变；可明确指定其他构建配置，既有产品名不匹配校验继续生效。
