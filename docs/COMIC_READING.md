# Moke 漫画阅读接入（TB-215）

Moke 将 Talebook 同款 komga-reader 的独立浏览器产物随应用打包，在书籍详情内挂载全屏阅读器。书架、书库及历史记录的“在读”入口均进入该详情页，使用同一类型判定。

## 来源与基线

- Moke 基线 `fb12b85b9229a8eaa5a0044c45843bdbe8e64105`。
- Talebook 参考基线 `ce9c33a4494d54e0d9777462f2f060a0d7825870`；`webserver/handlers/comic.py`、`webserver/services/comic_archive.py` 是接口依据。
- Talebook PR #1012（TB-129 / TB-131）已合并。komga-reader PR #1、#2 均已合并，静态产物固定在 Talebook 的 `komga-reader-version.txt` 所指 `d49a2e808601c7fc9b892a6c019a92eed017fd16`，并非追随上游最新版本。
- TB-200 的 Moke PR #127、#128 和 TB-205 的 #129 均已合并；平台 PR 缓存曾将 #128 标为 open，已通过 GitHub 实时状态及基线代码纠正。
- `public/vendor/komga-reader/` 的 UMD、CSS、LICENSE、NOTICE、THIRD_PARTY_NOTICES 原样取自该 Talebook 基线；UMD SHA-256：`d5a63c3cd75fcea2b668850d77ac4439699db4db0b74d6e9936066608627322f`。MIT，保留 Komga、独立提取项目及 Vue 等署名。本次不修改阅读器上游或 Readest 子模块。

## 类型与格式

| 元数据/格式 | 处理 |
| --- | --- |
| `media_type=comic` | 始终进入漫画流程，优先于默认阅读器及文件格式 |
| `media_type=ebook` | 始终使用点击时的默认阅读器，优先于混合容器格式 |
| 字段缺失、unknown 或未来未知类型 | 有 CBZ/ZIP/CBR/RAR 时进入漫画；其余使用默认阅读器 |
| 漫画 CBZ/ZIP/CBR/RAR | 通过服务端 manifest/page/progress 接口在线阅读；RAR 需要服务端已有解包依赖 |
| 漫画 EPUB/PDF，无图片归档副本 | 漫画流程内说明格式缺口；不会转交电子书阅读器 |
| 普通 EPUB/PDF | 不按标题或扩展名强行判断漫画；保持电子书行为 |

服务端目前在 `select_comic_container` 只选择 CBZ/ZIP/CBR/RAR。本次没有套用旧 Talebook“漫画 EPUB 仍用电子书阅读器”的例外。最小可用方案是在 Talebook 同一本书添加图片漫画容器；若未来直接支持漫画 EPUB，需要按 spine 提取图片并输出现有页面契约；漫画 PDF 则需增加受资源限制的服务端栅格化和 revision 缓存。这些后端格式扩展未在本 PR 实现。

系统默认阅读器需要本地文件：电子书主按钮显示“下载后阅读”或“阅读”，经已有下载管理完成后交给系统；内嵌选项保留现有在线 EPUB 和本地阅读。显式笔记定位沿用原有内嵌阅读器语义。漫画不修改默认偏好。

漫画下载文件继续保留；离线模式及右侧离线按钮只显示暂不支持本地解包的提示，不访问漫画 HTTP 接口。详情、批量下载及恢复下载保存 `media_type` 到 IndexedDB；在线查看详情也刷新旧下载分类。若旧记录从未携带分类，或 IndexedDB 被清空后仅从原生文件索引恢复，则应用格式兜底规则，无法离线推断 EPUB/PDF 内容类型。

## 请求与生命周期

- 使用现有 `api.request()`，Tauri 使用已有原生 cookie jar；不新增 Rust 命令、ACL、任意代理或文件权限。
- 仅构造当前书籍 `/api/book/<id>/comic/pages`、`pages/<index>?revision=...` 与 `progress` 路径。丢弃 manifest 中的签名 URL/token，禁止重定向并核对最终 URL。
- 仅接受契约 v1、连续页序、唯一页 ID、合法 revision 和栅格图片 MIME。拒绝 SVG/HTML、无效尺寸、单页大于 32 MiB / 4000 万像素、manifest JSON 大于 8 MiB。每次请求（含正文）限时 15 秒；显式重试，不自动重试鉴权失败。
- 固定版本 JS 只收到页面 ID、标题、尺寸和本地占位/Blob URL。宿主按可见页面及前后页预加载，最多 4 个并发请求；缓存保留当前可见页并清理超过 12 页 / 64 MiB 的非可见内容。退出中止请求、断开观察器、销毁阅读器并释放 Blob URL。
- 首张实际图片加载前显示加载状态；损坏图片、权限、接口缺失及文件更新有错误提示和重试/返回按钮。
- 进度采用 Talebook `kind=comic, version=1`，按 pageId 恢复，旧页序夹取至有效范围；350ms 合并翻页事件，单写入队列保证顺序。重载保留当前页。阅读器退出、Escape、原生 BACK 都先保存；失败可重试或明确“不保存退出”。强制杀进程/关闭 WebView 的最后未确认写入不保证送达。
- 使用安全区布局、键盘焦点约束及墨水屏高对比样式；不改变 Readest 窗口及在线 Range 实现。

## 验证与复现

1. `pnpm install --frozen-lockfile`，初始化仓库既有子模块以运行契约测试。
2. `pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm build`。
3. 前台启动 `pnpm dev --port 3000`，另一终端运行 `pnpm exec playwright test tests/comic-reader.spec.mjs tests/detail-actions.spec.mjs --workers=1 --reporter=line`。
4. 测试将 Tauri HTTP/IPC 替换为确定性本地 fixture，加载真实打包的 komga-reader JS/CSS 和 PNG 页面；390px/1280px 截图在 Playwright 输出目录。覆盖翻页/保存/恢复/退出、系统设置切换、书架及在读入口、漫画 EPUB/PDF、权限/页面失败、离线无请求及原按钮布局。
5. 真机验收：连接支持漫画接口的 Talebook 并登录；从书架打开漫画，翻页后退出并重开；切换默认阅读器后分别打开同一漫画和普通电子书；断网、撤销权限和重新加载时核对提示。漫画在线打开不应创建整本离线下载。

本轮验证为真实浏览器/真实阅读器产物 + 模拟 Talebook/Tauri 传输；未执行登录后的真实 Talebook + Tauri 二进制端到端，也未覆盖 Windows/macOS/Android/iOS/OHOS 实机和真实 CBR/RAR 解包。Readest 及 Tauri 原生源码没有修改，未重建完整原生安装包。不要把模拟 IPC 的成功表述为真机验收。

安全扫描结论见本事项附件的 DeepSec 复核报告；L1/L2 不支持 CSS，样式与固定供应链来源人工核对。已知存量告警不会因为本次新代码没有命中而视为消除。

## 本轮结果（2026-09-12）

- `pnpm test`：457 passed；最后一次离线分类原子写入调整后，26 项相关测试再次通过。
- `pnpm lint`：0 errors，23 条既有 warnings；新增漫画模块定向 lint 无告警。最终 typecheck 通过。
- `pnpm build`：静态生产导出通过；首屏加载提示调整后漫画 Playwright 12/12 再次通过，原详情布局 4/4 已通过，共覆盖 16 项。
- DeepSec 0.2.0：仓库 L1/L2 扫描 1294 文件、退出 2、47 条未修改路径的存量告警（critical 16 / high 20 / medium 11）；固定 UMD 显式补扫 1 文件、退出 2、1 条 high，人工确认是 Vue `innerHTML==null` 比较误报。18 个新增/修改 TS/TSX/MJS 文件均覆盖且无命中；2 份 CSS 不受支持，人工核对。报告和逐条保留结论随事项附件交付，不能称为安全完整通过。
