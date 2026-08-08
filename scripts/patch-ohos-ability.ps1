# Applies the local @ohos-rs/ability patches (back-key handling) to the
# ohpm-installed package inside the generated OpenHarmony project.
#
# Why: the ArkTS side of openharmony-ability ships as the ohpm package
# `@ohos-rs/ability` (registry version 0.4.0-beta.0), and a file: dependency
# on the vendored source is rejected by the ArkTS compiler
# (useNormalizedOHMUrl forbids relative imports inside external modules).
# So we patch the installed package in place. Run this after `ohpm install`
# (or after regenerating the project with `tauri ohos init`), then rebuild.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\patch-ohos-ability.ps1

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$patchDir = Join-Path $PSScriptRoot "ohos-ability-patch"
$targetBase = Join-Path $repoRoot "src-tauri\gen\ohos\entry\oh_modules\@ohos-rs\ability\src\main\ets"

if (-not (Test-Path $targetBase)) {
  Write-Error "Target package not found: $targetBase`nRun 'ohpm install' in src-tauri/gen/ohos/entry first."
  exit 1
}

$files = @(
  "webview\Utils.ets",
  "webview\DefaultWebview.ets",
  "components\DefaultXComponent.ets",
  "components\MainPage.ets"
)

foreach ($f in $files) {
  $src = Join-Path $patchDir $f
  $dst = Join-Path $targetBase $f
  if (-not (Test-Path $src)) {
    Write-Error "Patch file missing: $src"
    exit 1
  }
  Copy-Item $src $dst -Force
  Write-Host "patched: $f"
}

Write-Host "OK - @ohos-rs/ability back-key patches applied."
