## 平台图标

原始品牌图保留在 `public/logo/logo.png`，分辨率为 512×512。安装包使用 `src-tauri/icons/` 下已人工处理并提交的各平台资源，构建过程中不再运行 `tauri icon`，也不缩放或重绘这些资源。

| 平台 | 资源 | 裁剪与留白 |
|---|---|---|
| Windows | `icon.ico`、`Square*Logo.png`、`StoreLogo.png` | 透明圆角；四边各留 4%，圆角半径为色块边长的 22%；ICO 包含 16、24、32、48、64、256px |
| Linux | `32x32.png`、`64x64.png`、`128x128.png`、`128x128@2x.png`、`icon.png` | 与 Windows 相同的透明圆角 |
| macOS | `icon.icns` | 相同裁剪，包含普通和 Retina 尺寸 |
| Android | `android/mipmap-*`、`mipmap-anydpi-v26`、`mipmap-anydpi-v33` | 五档密度；常规圆角采用 100% 原图比例，圆形采用 90%；自适应和单色层分别使用对应比例 |
| OHOS | `ohos/app_icon.png`、`startIcon.png`、分层资源 | 均为原图分辨率 512×512；100% 原图比例，人工裁透明圆角；启动器与启动图使用同一高清图 |

这里的 100% 指整张原图的缩放比例，不是把书本主体放大到铺满图标。原图中的书本宽约 60%，因此常规圆角主体宽约 60%，略微缩小的圆形主体宽约 54%。品牌底色保留 `#B8956A`。

### OHOS 原图分辨率

`app_icon.png` 直接在 512×512 原图上裁透明圆角，不增加画布留白、不缩小书本，也不先从 32px/144px 图放大。`startIcon.png` 与其字节相同。分层后备资源的前景只含白色书本，背景保留品牌底色，尺寸同样是 512×512。

OHOS 专用配置显式使用 `bundle.icon: ["icons/ohos/app_icon.png"]`。当前 vendored CLI 会将此 PNG 原样复制至 AppScope，并把启动器、应用详情与启动窗口引用设为 `$media:app_icon`，避免继承桌面列表中的首张 32px PNG。复制脚本再将提交的高清资源覆盖到 AppScope 和 entry 两个作用域。

### Android 常规和圆形

独立旧版 `ic_launcher.png` 使用 100% 原图比例及透明圆角，圆角半径为画布边长的 22%；`ic_launcher_round.png` 使用 90% 原图比例和圆形遮罩。分别直接由 512px 原图处理，再按平台五档密度输出 48/72/96/144/192px。

自适应前景画布为 108dp，静止可视区为中央 72dp。常规前景中原图占 `100% × 72 / 108 = 66.67%` 的画布，圆形前景占 `90% × 72 / 108 = 60%`；书本完整位于中央 66dp 安全圆内，XML 不再叠加 inset。`ic_launcher_foreground.png` 与 `ic_launcher_round_foreground.png` 分别保存两种比例，Android 13+ 的单色层也分别对应。

准备脚本显式设置 `AndroidManifest.xml` 的 `android:roundIcon="@mipmap/ic_launcher_round"`，保留常规 `android:icon`、名称、主题和 Activity 配置，并在重复运行时保持幂等。支持 roundIcon 的启动器可以读取稍小的圆形前景；只读取常规 icon 的启动器仍会使用常规比例，实际选择需按启动器验证。

## 构建时复制资源

移动项目初始化时会产生模板默认图标。发布 workflow 在初始化后、打包前运行：

```bash
# Android 项目初始化后
node scripts/prepare-mobile-icons.mjs android

# OHOS 项目初始化后
node scripts/prepare-mobile-icons.mjs ohos
```

本地首次初始化或重新初始化项目时，也应运行对应命令。脚本仅复制提交的图标文件，不改变像素；Android 图标引用之外的应用资源保持原样，OHOS 双作用域使用同一套高清图。

更新品牌图时，请在构建流程之外人工处理各平台资源，检查透明边缘、各密度尺寸、系统遮罩和单色效果，再提交。不要从小尺寸桌面图标派生手机资源。
