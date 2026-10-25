# 浏览器兼容目标

Moke 的构建目标为 Chrome 96 及更新版本（`.browserslistrc`）。这是兼容目标，
不是已完成所有功能的旧浏览器验收；Next.js 和 PDF.js 的上游支持范围更高。
修改构建目标只能处理语法和 CSS 前缀，无法补齐浏览器运行时 API。

主界面使用 `vh` 作为视口高度回退，支持 `dvh` 时才启用动态视口高度。
下拉列表会按可用空间翻转和滚动，全部标签弹窗保留键盘焦点并在关闭后归还。
Reader 的版本由 `readest` gitlink 固定，其运行时 API 兼容修改需要独立评审、
先合入 Reader 仓库再更新 gitlink，不能仅凭主界面构建目标声明兼容。

## 验证

运行 `pnpm lint`、`pnpm typecheck`、`pnpm test` 和 `pnpm build-web`。
启动 `pnpm dev-web` 后，运行
`pnpm exec playwright test tests/chrome96-layout.spec.mjs tests/library-header-layout.spec.mjs`。
独立服务地址可通过 `PLAYWRIGHT_BASE_URL` 指定。

布局回归在现代浏览器中移除动态视口单位声明，验证长设置页内部滚动、移动视口、
键盘导航及隐私政策操作。这些能力限制测试不能替代真实 Chrome 96。

发布支持声明前还需在实际 Chrome 96 / 对应 WebView 上验证：首次启动与认证、
书库搜索与下载、离线 EPUB/PDF 阅读、翻页和目录、备份与翻译取消，以及错误恢复。
浏览器版本、页面地址、视口、控制台和网络错误应记录在验收证据中。
