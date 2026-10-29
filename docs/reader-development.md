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

PDF.js 的脚本、Worker、WASM、CMap 和标准字体由 Reader 的 `public/vendor/pdfjs` 统一提供。嵌入 Moke 后路径为 `/readest/vendor/pdfjs/`；Moke 主应用不需要单独的 PDF.js 副本或 `@pdfjs/*` 别名，避免在根目录 `public/` 重复打包。

## 开发与打包

```bash
pnpm tauri dev       # 启动原生应用与两个前端开发服务
pnpm dev:reader      # 单独启动 Reader 前端
pnpm build:reader    # 单独构建 Reader 前端
pnpm tauri build     # 构建完整应用安装包
```

`pnpm build:reader` 会自动执行资源生成步骤，产物位于 `readest/out/readest`。Moke 打包时通过 `pnpm copy:reader` 复制到 `out/readest`，以 `/readest` 路径提供服务；`pnpm tauri build` 已配置自动构建 Moke、构建 Reader 和复制资源，无需重复手动构建。

Reader 开发服务位于 <http://localhost:3001/readest/reader>。`pnpm tauri dev` 会同时启动该服务与端口 3000 的 Moke 前端。协议、鉴权、错误和版本兼容说明见当前子模块版本的 [`docs/MOKE_CONTRACT.md`](https://github.com/hehetoshang/readest-reader/blob/dbddfab6765abf69e6f1b9a4d466ed9e0a0a74d9/docs/MOKE_CONTRACT.md)；`mokeServerUrl` 始终是开发者配置的 Talebook 地址，不是 Reader 服务地址。

## 在线阅读兼容性

在线阅读要求 Talebook 提供 `talebook.reader.bootstrap.v1` 与逐书授权的 `/read/resource/<id>.epub?revision=...` 接口。Moke 会拒绝跨服务器资源、重定向、异常 MIME、缺失 Range/ETag 及资源版本变化，不会把 Cookie 或 Token 放入书籍 URL。

在线 EPUB 按需读取当前页面所需字节，不写入离线书库。服务器不支持安全 Range 接口、权限失效或网络异常时，可以重试或明确改为下载后阅读。

## 原生联调

真实桌面联调可使用 `pnpm tauri:reader-e2e` 启用仅绑定 `127.0.0.1` 的可选 WebDriver 插件。`reader-e2e` 与 release profile 同时启用会编译失败，不能进入发布产物。Reader 仓库保留的历史桌面联调环境、命令与结果见当前子模块版本的 [`docs/E2E_EVIDENCE.md`](https://github.com/hehetoshang/readest-reader/blob/dbddfab6765abf69e6f1b9a4d466ed9e0a0a74d9/docs/E2E_EVIDENCE.md)。该记录对应文中注明的历史提交，不代表本次鸿蒙适配已经完成设备或安装包验收。

## 安全边界与回归检查

Reader 原生命令仅授予顶层 Reader UI；书稿必须保持在 Foliate 的 sandbox iframe 内，不能接触顶层 Tauri IPC bridge。桌面 `allow_paths_in_scopes` 只能复用宿主已授权的 `fs_scope`，Moke 的 `open_reader` 也只为 AppData 书籍或文件选择器已授权路径扩展 scope。

升级 Foliate、Reader 命令或 capability 时必须保留这些边界并运行：

```bash
node --test tests/reader-only-build.test.mjs
```

Reader 实现变更应先通过 readest-reader 仓库的 PR，再在 Moke 中更新子模块版本。

当前 Reader 固定为 `dbddfab6765abf69e6f1b9a4d466ed9e0a0a74d9`，本次兼容性改动已先通过 Reader [PR #6](https://github.com/hehetoshang/readest-reader/pull/6) 和 [PR #7](https://github.com/hehetoshang/readest-reader/pull/7) 合并，包含 OHOS 插件降级、Chrome 96 兼容、字体资源路径及菜单清理。Moke 通过子模块更新接入。

Reader [PR #8](https://github.com/hehetoshang/readest-reader/pull/8) 补齐开书失败与空加载页的返回入口。Android/OHOS 使用固定的原生 `/library` 返回路径，失败时完整文档跳转；错误恢复的清理最多等待 1.5 秒，正常阅读退出仍等待进度保存。

生产静态集成回归：先执行 `pnpm build && pnpm build:reader && pnpm copy:reader`，启动 `node scripts/serve-static-tests.mjs`，再运行 `pnpm exec playwright test tests/reader-open-recovery.spec.mjs --workers=1`。测试使用实际 Reader 产物与模拟原生 IPC，不能替代设备验收。
