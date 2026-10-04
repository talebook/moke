# README 应用截图

这些图片展示 Moke 当前前端的实际渲染结果，使用虚构书库与原创几何封面。书名、作者、出版社和简介均为演示数据，不来自真实账号或私人藏书。

| 文件 | 页面 | 视口 |
|---|---|---|
| `library-desktop.png` | `/library`，桌面封面网格 | 1440 × 960 |
| `book-detail-desktop.png` | `/detail?id=1`，展开出版信息 | 1440 × 960 |
| `library-mobile.png` | `/library`，移动端双列网格 | 390 × 844 |

截图日期：2026-10-04。应用版本：1.1.5。前端源代码基于 `29b8cb7f24ffa23a1e6fd1a47405ce0ae2ff2382`，本次文档改动未修改应用界面代码。

截图来自 Web 开发预览，不能作为原生桌面窗口、移动设备、真实 Talebook 服务、下载或 Reader 阅读流程的验收证据。详情页中的原生功能提示也是 Web 预览的真实行为。

## 更新截图

在仓库根目录安装依赖和截图所需的 Chromium：

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

在一个终端启动预览服务：

```bash
pnpm dev-web --hostname 127.0.0.1 --port 3100
```

如果当前设备上的 Turbopack 编译无法完成，可以使用 Webpack 启动相同的 Web 界面：

```bash
pnpm exec dotenv -e .env.web -- next dev --webpack --hostname 127.0.0.1 --port 3100
```

服务就绪后，在另一个终端执行：

```bash
node scripts/capture-readme-screenshots.mjs
```

脚本创建 headless、独立的临时浏览器上下文，在浏览器中拦截 `https://readme-library.invalid` 的请求并返回固定示例数据；无需启动或登录真实 Talebook 服务器。未知外部请求会被阻止并报告。脚本不会修改应用 DOM 或样式，会等待字体与可见封面加载，检查视口横向溢出、视图切换和键盘进入详情页，再保存 PNG。结束时自动关闭浏览器；预览服务需在启动它的终端按 `Ctrl+C` 停止。

本次也通过 Playwright MCP 在 headless、独立临时 profile 中验证了相同的界面流程。上述 CLI 脚本用于复现和更新截图。

更新后请检查替代文字和 README 引用，按新截图填写日期、版本及前端源代码 SHA。
