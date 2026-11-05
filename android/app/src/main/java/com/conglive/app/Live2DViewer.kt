package com.conglive.app

import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import java.io.File

/**
 * Lightweight WebView wrapper for the Live2D 看板娘 page.
 *
 * The page itself is a local asset (`assets/live2d/viewer.html`) that pulls
 * pixi.js + pixi-live2d-display + Cubism Core + JSZip from their CDNs. No model
 * files are bundled: the user either pastes a public `.model3.json` URL or picks
 * a local `.zip` model package (v0.8.2), which MainActivity copies into
 * cacheDir and this class hands to the page as `?zip=<file:// URL>`.
 *
 * The WebView is only a UI companion. It is deliberately NOT composited into
 * the WebRTC camera/screen track — the live stream pipeline is untouched.
 */
class Live2DViewer(
    context: Context,
    lang: Lang = L10n.read(context),
    private val onStatus: (String) -> Unit,
    private val onError: (String) -> Unit
) {
    companion object {
        private const val ASSET_URL = "file:///android_asset/live2d/viewer.html"
        private const val BRIDGE_NAME = "AndroidLive2D"

        /** v0.8.2: query parameter that carries an encoded local zip `file://` URL. */
        private const val ZIP_QUERY = "zip"
    }

    /** v0.7.7: current UI language; can be changed without recreating the WebView. */
    @Volatile private var language: Lang = lang

    private fun tr(key: String, vararg args: Any?): String = L10n.t(language, key, *args)

    val webView: WebView = WebView(context)
    private var pageReady = false
    private var pendingModelUrl: String? = null

    /** v0.8.2: last picked local zip, kept so reload()/language keeps the package. */
    private var localZipUrl: String? = null

    init {
        webView.setBackgroundColor(Color.rgb(10, 15, 30))
        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // The page is a local asset but its scripts come from https CDNs.
            allowFileAccess = true
            allowContentAccess = true
            // v0.8.2: the local page (file:///android_asset) must be able to read
            // the picked model zip from cacheDir (file:///data/...). Both switches
            // are required by the WebView file-origin security model.
            enableLocalFileAccess(this)
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            loadsImagesAutomatically = true
        }
        webView.addJavascriptInterface(Bridge(), BRIDGE_NAME)
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                pushLanguageToPage()
                pendingModelUrl?.let { pending ->
                    pendingModelUrl = null
                    loadModel(pending)
                }
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError
            ) {
                if (request.isForMainFrame) {
                    onError(tr("live2d.pageFailed", error.description))
                }
            }
        }
        webView.loadUrl(ASSET_URL)
    }

    /** v0.8.2: lets the local viewer page read the model zip copied into cacheDir. */
    @Suppress("DEPRECATION")
    private fun enableLocalFileAccess(settings: WebSettings) {
        settings.allowFileAccess = true
        settings.allowFileAccessFromFileURLs = true
        settings.allowUniversalAccessFromFileURLs = true
    }

    /** v0.7.7: switches the WebView's own status/errors without reloading the page. */
    fun setLanguage(newLang: Lang) {
        language = newLang
        pushLanguageToPage()
    }

    /** Tells the local page which dictionary to use for its status lines. */
    private fun pushLanguageToPage() {
        runScript("window.setLive2DLanguage(" + JSONObject.quote(language.code) + ");")
    }

    /** Loads a public .model3.json URL, queuing it until the local page is ready. */
    fun loadModel(rawUrl: String) {
        val url = rawUrl.trim()
        if (url.isEmpty()) {
            onError(tr("live2d.urlEmpty"))
            return
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            onError(tr("live2d.urlScheme"))
            return
        }
        if (!url.contains(".model3.json")) {
            onError(tr("live2d.urlNotModel"))
            return
        }
        if (!pageReady) {
            pendingModelUrl = url
            onStatus(tr("live2d.pageInitializing"))
            return
        }
        onStatus(tr("live2d.loading"))
        runScript("window.loadLive2DModel(" + JSONObject.quote(url) + ");")
    }

    /**
     * v0.8.2: loads a local `.zip` Live2D model package picked by the user.
     *
     * MainActivity already copied the content URI into cacheDir (the WebView
     * cannot read `content://` directly), so `file` is a readable file. The page
     * is (re)loaded with `?zip=<encoded file URL>`; viewer.html unzips it with
     * JSZip and maps every model reference to a blob URL before loading it.
     */
    fun loadLocalZip(file: File) {
        if (!file.exists() || file.length() <= 0L) {
            onError(tr("live2d.zipEmpty"))
            return
        }
        val fileUrl = Uri.fromFile(file).toString()
        localZipUrl = fileUrl
        pendingModelUrl = null
        pageReady = false
        onStatus(tr("live2d.zipLoading"))
        webView.loadUrl(pageUrlWithZip(fileUrl))
    }

    /** The local page URL, with the picked zip appended when there is one. */
    private fun pageUrlWithZip(fileUrl: String): String =
        ASSET_URL + "?" + ZIP_QUERY + "=" + Uri.encode(fileUrl)

    /** Reloads the local page (e.g. after a CDN hiccup), keeping the picked zip. */
    fun reload() {
        pageReady = false
        pendingModelUrl = null
        val zipUrl = localZipUrl
        webView.loadUrl(if (zipUrl == null) ASSET_URL else pageUrlWithZip(zipUrl))
        onStatus(tr("live2d.reloading"))
    }

    fun showModel() = runScript("window.showLive2D();")

    fun hideModel() = runScript("window.hideLive2D();")

    /** Stops the PIXI ticker while the tab is not visible. */
    fun setPaused(paused: Boolean) = runScript("window.setLive2DPaused($paused);")

    fun destroy() {
        try {
            webView.removeJavascriptInterface(BRIDGE_NAME)
            webView.stopLoading()
            webView.loadUrl("about:blank")
            webView.destroy()
        } catch (_: Exception) {
        }
    }

    private fun runScript(script: String) {
        webView.post {
            if (pageReady) {
                webView.evaluateJavascript(script, null)
            }
        }
    }

    private inner class Bridge {
        @JavascriptInterface
        fun onStatus(message: String?) {
            onStatus(message ?: tr("live2d.statusUpdated"))
        }

        @JavascriptInterface
        fun onError(message: String?) {
            onError(message ?: tr("live2d.loadFailed"))
        }
    }
}
