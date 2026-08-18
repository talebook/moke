// Moke 自定义 Android MainActivity。
//
// 标准 Tauri 模板的 MainActivity 不实现 native-bridge 插件要求的
// KeyDownInterceptor 接口，导致 intercept_keys 命令静默失败，音量键翻页无效
// （talebook/moke#17）。此文件在 CI（build-release.yml）中于 `tauri android init`
// 之后覆盖到 src-tauri/gen/android 生成的 MainActivity。
//
// 音量键翻页链路：readest 前端 acquireVolumeKeyInterception() →
// interceptKeys({ volumeKeys: true }) → NativeBridgePlugin.intercept_keys →
// 本 Activity 的 dispatchKeyEvent 拦截音量键 → wv.evaluateJavascript(
// "window.onNativeKeyDown('VolumeUp'/'VolumeDown')") → 前端 native-key-down
// 事件翻页。所有拦截均由前端 acquire/release 的 flag 控制，默认关闭，因此
// Moke 主界面（非阅读器页面）的音量键/返回键行为保持不变。

package org.houheya.moke

import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.view.KeyEvent
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.enableEdgeToEdge
import com.readest.native_bridge.KeyDownInterceptor

class MainActivity : TauriActivity(), KeyDownInterceptor {
    private var wv: WebView? = null
    private var interceptVolumeKeysEnabled = false
    private var interceptBackKeyEnabled = false
    private var interceptPageTurnerKeysEnabled = false
    private var keyLearnModeEnabled = false
    private var lastExitBackPressedAt = 0L

    companion object {
        private const val EXIT_CONFIRM_WINDOW_MS = 2_000L
        private val APP_EXIT_ROUTES = setOf("/", "/welcome", "/shelf")
    }

    // DOWN 已被本 Activity 消费（并转发到 webview）的按键集合。被拦截的按键
    // 必须把配套的 ACTION_UP 也一并消费，否则按键组合会泄漏到
    // 系统默认处理。用集合而非单个 keyCode 以容忍快速连按/按键回滚。
    private val interceptedKeyCodes = mutableSetOf<Int>()

    private val keyEventMap = mapOf(
        KeyEvent.KEYCODE_BACK to "Back",
        KeyEvent.KEYCODE_VOLUME_DOWN to "VolumeDown",
        KeyEvent.KEYCODE_VOLUME_UP to "VolumeUp",
    )

    private val mediaKeyMap = mapOf(
        KeyEvent.KEYCODE_MEDIA_NEXT to "MediaNext",
        KeyEvent.KEYCODE_MEDIA_PREVIOUS to "MediaPrevious",
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE to "MediaPlayPause",
        KeyEvent.KEYCODE_MEDIA_FAST_FORWARD to "MediaFastForward",
        KeyEvent.KEYCODE_MEDIA_REWIND to "MediaRewind",
    )

    private fun keyNameFor(keyCode: Int): String =
        keyEventMap[keyCode] ?: mediaKeyMap[keyCode] ?: "Keycode$keyCode"

    // 转发按键到 webview。webview 尚未创建（onWebViewCreate 未调用）时返回
    // false，调用方必须放行 super 而不是消费按键，避免"拦截但不转发"导致按键丢失。
    private fun forwardKeyToWebView(keyName: String, keyCode: Int): Boolean {
        val webView = wv ?: return false
        webView.evaluateJavascript(
            """try { window.onNativeKeyDown("$keyName", $keyCode); } catch (_) {}""",
            null,
        )
        return true
    }

    /**
     * Tauri's default Android BACK handling delegates to WebView history. In a
     * statically-exported Next app that can perform a document reload instead
     * of a client-side route transition. Non-root Moke pages therefore send a
     * dedicated event to AppShell, which calls Next's router.back().
     */
    private fun forwardAppBackToWebView(): Boolean {
        val webView = wv ?: return false
        webView.evaluateJavascript(
            """window.dispatchEvent(new Event("moke:native-back"));""",
            null,
        )
        return true
    }

    private fun currentAppPath(): String {
        val rawPath = wv?.url?.let { Uri.parse(it).path }.orEmpty()
        val withoutDocument = when {
            rawPath.endsWith("/index.html") -> rawPath.removeSuffix("/index.html")
            rawPath.endsWith(".html") -> rawPath.removeSuffix(".html")
            else -> rawPath
        }
        return withoutDocument.trimEnd('/').ifEmpty { "/" }
    }

    private fun isAppExitRoute(): Boolean = currentAppPath() in APP_EXIT_ROUTES

    private fun isEmbeddedReaderRoute(): Boolean =
        currentAppPath() == "/readest" || currentAppPath().startsWith("/readest/")

    private fun handleExitBack(): Boolean {
        val now = SystemClock.elapsedRealtime()
        if (lastExitBackPressedAt != 0L && now - lastExitBackPressedAt <= EXIT_CONFIRM_WINDOW_MS) {
            finishAndRemoveTask()
        } else {
            lastExitBackPressedAt = now
            Toast.makeText(this, "再按一次退出应用", Toast.LENGTH_SHORT).show()
        }
        return true
    }

    override fun onWebViewCreate(webView: WebView) {
        wv = webView
    }

    override fun interceptVolumeKeys(enabled: Boolean) {
        interceptVolumeKeysEnabled = enabled
    }

    override fun interceptBackKey(enabled: Boolean) {
        interceptBackKeyEnabled = enabled
    }

    override fun interceptPageTurnerKeys(enabled: Boolean) {
        interceptPageTurnerKeysEnabled = enabled
    }

    override fun setKeyLearnMode(enabled: Boolean) {
        keyLearnModeEnabled = enabled
    }

    // 判断某个按键当前是否应被本 Activity 拦截（与按键方向无关）。
    private fun shouldIntercept(keyCode: Int): Boolean {
        // Learn mode: forward and consume every key except BACK so the settings
        // UI can capture whatever the remote sends. BACK stays excluded to match
        // the reader: PageTurnerSettings explicitly does not allow binding Back
        // (it is reserved for back navigation, and dialogs must still receive
        // BACK to cancel their onCancel handler).
        if (keyLearnModeEnabled && keyCode != KeyEvent.KEYCODE_BACK) return true

        // Hardware page turner: intercept media keys when enabled.
        if (interceptPageTurnerKeysEnabled && mediaKeyMap.containsKey(keyCode)) return true

        return when (keyCode) {
            KeyEvent.KEYCODE_BACK -> interceptBackKeyEnabled
            KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.KEYCODE_VOLUME_DOWN ->
                interceptVolumeKeysEnabled
            else -> false
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        when (event.action) {
            KeyEvent.ACTION_DOWN -> {
                // The embedded reader owns BACK while its interception flag is
                // enabled. Everywhere else, keep root-page exit behavior
                // native and route nested pages through Next's client router.
                if (event.keyCode == KeyEvent.KEYCODE_BACK && !interceptBackKeyEnabled) {
                    if (event.repeatCount > 0) return true
                    // Android uses an in-place Readest WebView. During its
                    // startup there is a short interval before Readest enables
                    // interception; never interpret BACK in that interval as a
                    // Moke root-page exit.
                    if (isEmbeddedReaderRoute()) {
                        return super.dispatchKeyEvent(event)
                    }
                    val handled = if (isAppExitRoute()) {
                        handleExitBack()
                    } else {
                        lastExitBackPressedAt = 0L
                        forwardAppBackToWebView()
                    }
                    if (!handled) return super.dispatchKeyEvent(event)
                    interceptedKeyCodes.add(event.keyCode)
                    return true
                }
                if (!shouldIntercept(event.keyCode)) {
                    return super.dispatchKeyEvent(event)
                }
                // 只消费真正转发成功的按键；webview 未就绪时放行默认处理，
                // 避免拦截到但转发不出去的按键被吞掉。
                if (!forwardKeyToWebView(keyNameFor(event.keyCode), event.keyCode)) {
                    return super.dispatchKeyEvent(event)
                }
                interceptedKeyCodes.add(event.keyCode)
                return true
            }
            // 配套的 UP 也要消费（KeyEvent 没有 CANCEL；CANCEL 属 MotionEvent），
            // 保证被拦截的按键组合不会泄漏到系统默认处理（例如 BACK 的 UP 落到默认行为）。
            KeyEvent.ACTION_UP -> {
                if (interceptedKeyCodes.remove(event.keyCode)) return true
                return super.dispatchKeyEvent(event)
            }
            else -> return super.dispatchKeyEvent(event)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
    }
}
