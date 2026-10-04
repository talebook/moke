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
