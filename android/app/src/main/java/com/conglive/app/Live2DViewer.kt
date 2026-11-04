package com.conglive.app

import android.content.Context
import android.graphics.Color
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

/**
 * Lightweight WebView wrapper for the Live2D 看板娘 page.
 *
 * The page itself is a local asset (`assets/live2d/viewer.html`) that pulls
 * pixi.js + pixi-live2d-display + Cubism Core from their CDNs. No model files
 * are bundled: the user pastes a public `.model3.json` URL at runtime.
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
    }

    /** v0.7.7: current UI language; can be changed without recreating the WebView. */
    @Volatile private var language: Lang = lang

    private fun tr(key: String, vararg args: Any?): String = L10n.t(language, key, *args)

    val webView: WebView = WebView(context)
    private var pageReady = false
    private var pendingModelUrl: String? = null

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

    /** Reloads the local page (e.g. after a CDN hiccup). */
    fun reload() {
        pageReady = false
        pendingModelUrl = null
        webView.loadUrl(ASSET_URL)
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
