package app.tauri.share

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.webkit.WebView
import android.net.Uri
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

@InvokeArg
class ShareTextOptions {
    lateinit var text: String
    var mimeType: String = "text/plain"
    var title: String? = null
}

@InvokeArg
class ShareFileOptions {
    lateinit var url: String
    var mimeType: String = "*/*"
    var title: String? = null
}

@TauriPlugin
class SharePlugin(private val activity: Activity): Plugin(activity) {
    /**
     * Open the native sharing interface to share some text
     */
    @Command
    fun shareText(invoke: Invoke) {
        val args = invoke.parseArgs(ShareTextOptions::class.java)

        val sendIntent = Intent().apply {
            this.action = Intent.ACTION_SEND
            this.type = args.mimeType
            this.putExtra(Intent.EXTRA_TEXT, args.text)
            this.putExtra(Intent.EXTRA_TITLE, args.title)
        }

        val shareIntent = Intent.createChooser(sendIntent, null)
        startActivityForResult(invoke, shareIntent, "shareTextResult")
    }

    @ActivityCallback
    private fun shareTextResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode == Activity.RESULT_CANCELED) {
            invoke.reject("Share cancelled")
            return
        }
        invoke.resolve()
    }

    /**
     * Open the native sharing interface to share a file
     */
    @Command
    fun shareFile(invoke: Invoke) {
        val args = invoke.parseArgs(ShareFileOptions::class.java)
        
        // Get the source file from the URL
        val sourceFile = if (args.url.startsWith("file://")) {
            File(Uri.parse(args.url).path!!)
        } else {
            File(args.url)
        }
        
        // Create a temporary file to store the data
        val tempFile = File(activity.cacheDir, sourceFile.name)
        
        // Copy the source file to the temporary file
        sourceFile.inputStream().use { input ->
            tempFile.outputStream().use { output ->
                input.copyTo(output)
            }
        }

        // Get the authority from the app's manifest
        val authority = "${activity.packageName}.fileprovider"

        // Create a content URI for the file
        val contentUri = FileProvider.getUriForFile(activity, authority, tempFile)

        val sendIntent = Intent().apply {
            this.action = Intent.ACTION_SEND
            this.type = args.mimeType
            this.putExtra(Intent.EXTRA_STREAM, contentUri)
            this.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            this.putExtra(Intent.EXTRA_TITLE, args.title)
        }

        val shareIntent = Intent.createChooser(sendIntent, args.title)
        startActivityForResult(invoke, shareIntent, "shareFileResult")
    }

    @ActivityCallback
    private fun shareFileResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode == Activity.RESULT_CANCELED) {
            invoke.reject("Share cancelled")
            return
        }
        invoke.resolve()
    }
}
