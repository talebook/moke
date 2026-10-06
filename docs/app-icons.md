## 平台图标

原始品牌图保留在 `public/logo/logo.png`。安装包使用 `src-tauri/icons/` 下已裁剪、检查并提交的各平台资源，构建过程中不再运行 `tauri icon`，也不缩放或重绘这些资源。

| 平台 | 资源 | 裁剪与留白 |
|---|---|---|
| Windows | `icon.ico`、`Square*Logo.png`、`StoreLogo.png` | 透明圆角；四边各留 4%，圆角半径为色块边长的 22%；ICO 包含 16、24、32、48、64、256px |
| Linux | `32x32.png`、`64x64.png`、`128x128.png`、`128x128@2x.png`、`icon.png` | 与 Windows 相同的透明圆角 |
| macOS | `icon.icns` | 相同裁剪，包含普通和 Retina 尺寸 |
| Android | `android/mipmap-*`、`mipmap-anydpi-v26`、`mipmap-anydpi-v33` | 五档密度；旧版圆角图标采用 Windows 相同裁剪比例，自适应、圆形和单色保留原有比例 |
| OHOS | `ohos/{foreground,background,startIcon}.png`、`layered_image.json` | 前景/背景 1024px，启动图标 144px；书本主体与 Android 独立圆角图标相同比例，约占画布宽度 55% |

底色统一为原图的 `#B8956A`。手机前景只保留白色书本，底色放在背景层，避免系统裁切后出现额外色块。Android 圆形与自适应图标沿用原有 80% 原图缩放比例，原图中的书本宽约 60%，因此最终书本宽约为图标可视区的 48%。Android 独立圆角图标与 OHOS 的书本主体则采用 Windows 的约 55% 画布宽度比例。

Android 自适应前景画布为 108dp，静止可视区为中央 72dp。原图在前景画布中缩放为 `80% × 72 / 108 = 53.33%`，使系统裁切后的视觉比例与旧版 Android 圆形图标接近。书本整体处于中央 66dp 安全区内；不要再给图标添加 XML inset，否则会重复缩小。单色资源与前景使用相同的尺寸、透明度及位置，Android 13+ XML 显式引用单色层。

Android 独立的旧版圆角资源 `mipmap-*/ic_launcher.png` 使用 Windows 相同的图形比例和透明圆角（四边各 4% 留白），书本宽约占画布 55%。`ic_launcher_round.png`、自适应前景、单色层及 XML 保持原资源。Android 8+ 启动器通常使用同一自适应前景生成圆形和圆角遮罩，因此这次单独调整旧版圆角资源不会改变现代启动器的自适应显示比例。

OHOS 的 `foreground.png` 和 `startIcon.png` 中书本主体使用与 Android 独立圆角图标相同的 Windows 图形比例。前景保留透明画布和白色书本，背景与分层 JSON 保持原资源，系统负责启动器遮罩；不把桌面圆角色块直接写入前景层。

## 构建时复制资源

移动项目初始化时会产生模板默认图标。发布 workflow 在初始化后、打包前，使用复制脚本覆盖这些文件：

```bash
# Android 项目初始化后
node scripts/prepare-mobile-icons.mjs android

# OHOS 项目初始化后
node scripts/prepare-mobile-icons.mjs ohos
```

本地首次初始化或重新初始化项目时，也应运行对应命令。脚本仅复制提交的文件，不改变像素；Android 的名称、主题、快捷方式等其他资源不受影响。OHOS 的 AppScope 和 entry 两处都使用同一套分层图标，避免启动器与应用详情显示不同品牌图。

更新品牌图时，请在构建流程之外人工调整各平台资源，检查透明边缘、各密度尺寸、圆形/圆角系统遮罩和单色效果，再提交资源。不要从带桌面透明圆角的 `icons/icon.png` 自动派生手机自适应前景。
