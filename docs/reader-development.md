# Reader 开发与构建

返回 [Moke README](../README.md#本地开发)。

Reader 是独立递归子模块。全新检出或从旧 Readest 子模块迁移后，在 Moke 仓库根目录执行：

```bash
git submodule sync --recursive
git submodule update --init --recursive
pnpm install --frozen-lockfile
cd readest
pnpm install --frozen-lockfile
pnpm setup:vendors
cd ..
```

`.env.moke-reader` 已随 Reader 仓库提交，无需本地创建。`pnpm setup:vendors` 会转调 Reader app 的 `setup-vendors` 子脚本，生成 PDF.js、SimpleCC 和 Jieba 资源。只启动开发服务器时也需要完成这一步。

## 开发与打包

```bash
pnpm tauri dev       # 启动原生应用与两个前端开发服务
pnpm dev:reader      # 单独启动 Reader 前端
pnpm build:reader    # 单独构建 Reader 前端
pnpm tauri build     # 构建完整应用安装包
```

`pnpm build:reader` 会自动执行资源生成步骤，产物位于 `readest/out/readest`。Moke 打包时通过 `pnpm copy:reader` 复制到 `out/readest`，以 `/readest` 路径提供服务；`pnpm tauri build` 已配置自动构建 Moke、构建 Reader 和复制资源，无需重复手动构建。

Reader 开发服务位于 <http://localhost:3001/readest/reader>。`pnpm tauri dev` 会同时启动该服务与端口 3000 的 Moke 前端。协议、鉴权、错误和版本兼容说明见当前子模块版本的 [`docs/MOKE_CONTRACT.md`](https://github.com/hehetoshang/readest-reader/blob/4b3db91bd1d94e5e9063639964f95a407334e81f/docs/MOKE_CONTRACT.md)；`mokeServerUrl` 始终是开发者配置的 Talebook 地址，不是 Reader 服务地址。

## 在线阅读兼容性

在线阅读要求 Talebook 提供 `talebook.reader.bootstrap.v1` 与逐书授权的 `/read/resource/<id>.epub?revision=...` 接口。Moke 会拒绝跨服务器资源、重定向、异常 MIME、缺失 Range/ETag 及资源版本变化，不会把 Cookie 或 Token 放入书籍 URL。

在线 EPUB 按需读取当前页面所需字节，不写入离线书库。服务器不支持安全 Range 接口、权限失效或网络异常时，可以重试或明确改为下载后阅读。

## 原生联调

真实桌面联调可使用 `pnpm tauri:reader-e2e` 启用仅绑定 `127.0.0.1` 的可选 WebDriver 插件。`reader-e2e` 与 release profile 同时启用会编译失败，不能进入发布产物。经过脱敏的环境、命令轮廓与实测结果见当前子模块版本的 [`docs/E2E_EVIDENCE.md`](https://github.com/hehetoshang/readest-reader/blob/4b3db91bd1d94e5e9063639964f95a407334e81f/docs/E2E_EVIDENCE.md)。

## 安全边界与回归检查

Reader 原生命令仅授予顶层 Reader UI；书稿必须保持在 Foliate 的 sandbox iframe 内，不能接触顶层 Tauri IPC bridge。桌面 `allow_paths_in_scopes` 只能复用宿主已授权的 `fs_scope`，Moke 的 `open_reader` 也只为 AppData 书籍或文件选择器已授权路径扩展 scope。

升级 Foliate、Reader 命令或 capability 时必须保留这些边界并运行：

```bash
node --test tests/reader-only-build.test.mjs
```

Reader 实现变更应先通过 readest-reader 仓库的 PR，再在 Moke 中更新子模块版本。

## 服务器会话与阅读器返回

桌面 `open_reader` 的 IPC 成功只表示已排入 UI 线程，不表示窗口已经创建。Moke 在窗口尚未确认时保留原请求的来源；超时、IPC 回执丢失后也不能切服务器、登录、进入离线或重复打开。迟到窗口仍归属原请求，全部关闭并 flush 后可以继续。如果窗口始终没有出现，或无法确认创建与取消结果，应退出并重启应用；不要用另一个等待时长推断请求已取消。已关闭的窗口 label 不再接受进度，也不能被下一请求认领。

打开后的窗口确认采用渐进等待（100 毫秒至 1 秒，最多观察 5 秒）。未确认或回执丢失会显示「阅读器打开请求尚未确认」及等待/重启说明，不映射为网络失败，也不写入打开成功的阅读记录。这个观察期限只结束前台等待，不释放来源保护。

Reader 窗口按 `reader-` 前缀识别，不要求纯数字后缀。Reader 内置书库（`moke-home-*`）自行创建的窗口没有 Moke 来源绑定，暂不向 Talebook 同步进度；宿主会记录无法归属的窗口 label 与 bookId，不能用当前服务器猜测归属。补齐这个入口需要协调 Reader 的显式来源契约。`moke:reader:event` 是发往 `main` 的宿主旁路事件，发送失败只记日志，不改变原 Reader/扩展事件命令的成功语义。桌面、移动和平板宿主窗口均显式使用 `main` label。

扩展寻址只枚举 `reader-*`，不把 `moke-home-*` 书库首页当作已打开的书籍阅读窗口。连接/登录/离线变更以及 Moke 再次打开书籍的会话保护则同时检查两类窗口：书库首页仍保留旧来源上下文且可以打开书籍，必须先关闭它再继续。

单 WebView 阅读会替换 Moke 文档。打开前将最小返回信息保存在本标签的 `sessionStorage`，并用 `window.name` 绑定一次性 nonce 和来源，沿用 Reader 的 `/library` 返回契约。返回信息不包含用户、密码、访问码、token 或能力缓存，也不写入服务器列表或 URL。返回时核对已保存服务器的 id/地址；在线连接最多确认 20 秒，离线返回不发网络请求，并进入 `/shelf`。返回记录最多有效 12 小时，消费后立即清除；切服务器、登录、退出登录、断开或切离线都会失效旧记录。

单 WebView 的进度保存由 Reader 文档负责，Moke 的 `ReaderProgressProvider` 已随原文档卸载。在线阅读及下载书籍的启动 URL 携带来源 `mokeServerUrl` 和 `mokeBookId`；Reader 按当前固定版本的 [HTTP 契约](https://github.com/hehetoshang/readest-reader/blob/4b3db91bd1d94e5e9063639964f95a407334e81f/docs/MOKE_CONTRACT.md) 直接 POST 到该来源的 `/api/book/{id}/progress`，合并页码更新并在关闭前 flush。示例书不携带服务器地址。宿主的窗口来源 Map 用于桌面 `reader-*`，无需把移动端 `main` 绑定到已卸载的 Moke Provider。

服务器列表读取超时的“先使用离线书库”出口使用同文档导航进入 `/library`，以便查看本地下载，包括未加入书架的书籍；打开书籍并关闭单 WebView Reader 后，仍按上述离线返回约定转到 `/shelf`。示例书开发者入口的 `offline-library` intent 只授权首次跨文档进入 `/library`，在到达时消费，后续开书会生成新的 Reader 返回凭据，不继承该入口 intent。离线阅读不恢复之前的书库筛选或详情页。

冷启动、新 WebView、刷新/历史重放、过期、缺失或被改动的来源均不会凭此自动连接，仍回服务器列表。若运行时不允许会话存储或设置返回标记，打开操作会保留当前连接并报错。原生平台是否保持同源文档间的 `window.name` 和会话存储，需在对应设备验证；Chromium 返回辅助模块测试不能替代原生 EPUB、实际 Moke 页面或 Cookie 回写验收。

返回 nonce 使用 `crypto.randomUUID`，缺失时使用 `crypto.getRandomValues` 生成 UUID；两者都不可用时清除返回授权并报错。服务器条目 ID、备份/临时文件名等本地标识可以使用非安全回退，但不得用于返回授权。
