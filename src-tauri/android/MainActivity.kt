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

import android.os.Bundle
import android.view.KeyEvent
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import com.readest.native_bridge.KeyDownInterceptor

class MainActivity : TauriActivity(), KeyDownInterceptor {
    private var wv: WebView? = null
    private var interceptVolumeKeysEnabled = false
    private var interceptBackKeyEnabled = false
    private var interceptPageTurnerKeysEnabled = false
    private var keyLearnModeEnabled = false

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

    private fun forwardKeyToWebView(keyName: String, keyCode: Int) {
        wv?.evaluateJavascript(
            """try { window.onNativeKeyDown("$keyName", $keyCode); } catch (_) {}""",
            null,
        )
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

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN) {
            val keyCode = event.keyCode

            // Learn mode: forward and consume every key so the settings UI
            // can capture whatever the remote sends.
            if (keyLearnModeEnabled && keyCode != KeyEvent.KEYCODE_BACK) {
                forwardKeyToWebView(keyNameFor(keyCode), keyCode)
                return true
            }

            // Hardware page turner: intercept media keys when enabled.
            if (interceptPageTurnerKeysEnabled && mediaKeyMap.containsKey(keyCode)) {
                forwardKeyToWebView(mediaKeyMap[keyCode]!!, keyCode)
                return true
            }

            val keyName = keyEventMap[keyCode]
            if (keyName != null) {
                val shouldIntercept = when (keyCode) {
                    KeyEvent.KEYCODE_BACK -> interceptBackKeyEnabled
                    KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.KEYCODE_VOLUME_DOWN ->
                        interceptVolumeKeysEnabled
                    else -> false
                }

                if (shouldIntercept) {
                    forwardKeyToWebView(keyName, keyCode)
                    return true
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
    }
}
