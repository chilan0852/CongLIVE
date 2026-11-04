package com.conglive.app

import android.Manifest
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Outline
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import org.webrtc.SurfaceViewRenderer
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

private data class ApiResult(
    val code: Int,
    val obj: JSONObject? = null,
    val array: JSONArray? = null,
    val raw: String = ""
)

private data class LiveStream(
    val id: Long,
    val title: String,
    val username: String,
    val isLive: Boolean,
    val whepPath: String,
    val coverUrl: String = ""
)

private data class Recording(
    val id: String,
    val name: String,
    val path: String,
    val size: Long,
    val modifiedAt: String,
    val playUrl: String
)

private data class ChatMessage(
    val id: String,
    val username: String,
    val content: String,
    val createdAt: String
)

class MainActivity : AppCompatActivity() {
    companion object {
        private const val PREFS = "conglive"
        private const val DEFAULT_API = "http://10.0.2.2:3000"
        private const val COVER_PREF_PREFIX = "cover_"

        // v0.7.6 dark gradient theme.
        private val BG_TOP = 0xFF060A14.toInt()
        private val BG_MID = 0xFF0C1428.toInt()
        private val BG_BOTTOM = 0xFF171033.toInt()
        private val BG = BG_TOP
        private val PANEL = 0xFF111A2E.toInt()
        private val PANEL_ALT = 0xFF1A2440.toInt()
        private val PANEL_DEEP = 0xFF0C1324.toInt()
        private val EDGE = 0x1FFFFFFF
        private val PURPLE = 0xFF8B72FF.toInt()
        private val PURPLE_DEEP = 0xFF5B3DF5.toInt()
        private val TEAL = 0xFF3FE0C5.toInt()
        private val TEXT = 0xFFF4F6FC.toInt()
        private val MUTED = 0xFF9AA6BF.toInt()
        private val GREEN = 0xFF54E0A8.toInt()
        private val RED = 0xFFFF8093.toInt()
        private val AMBER = 0xFFFFC46B.toInt()
    }

    private val executor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private lateinit var root: LinearLayout
    private lateinit var content: LinearLayout
    private lateinit var statusView: TextView
    private lateinit var apiAddressInput: EditText

    private var apiBase: String = DEFAULT_API
    private var token: String? = null
    private var currentUsername: String = ""
    private var currentTab = 0
    private var streams: List<LiveStream> = emptyList()
    private var myStreams: JSONArray = JSONArray()
    private var recordings: List<Recording> = emptyList()
    private var selectedStream: LiveStream? = null
    private var selectedRecording: Recording? = null
    private var createdPublishPath: String = ""
    private var createdStreamId: Long = 0
    private var createdCoverUrl: String = ""
    /** v0.7.7: user-visible UI language, persisted under SharedPreferences `app_language`. */
    private var lang: Lang = Lang.fromSystem()
    /** Last top-bar status message; re-applied when the shell is rebuilt after a language switch. */
    private var statusMessage: String = ""
    /** Stream title as typed by the user; empty means the localized default title is shown. */
    private var draftTitle: String = ""
    private var chatMessages: MutableList<ChatMessage> = mutableListOf()
    private var chatSocket: WebSocket? = null
    private var player: ExoPlayer? = null
    private var playerView: PlayerView? = null
    private var livePlaybackClient: WebRtcPlaybackClient? = null
    private var livePlaybackStreamId: Long = 0L
    private var liveRenderer: SurfaceViewRenderer? = null
    private var bannedNotice = false
    /** Empty means the localized idle text from [renderBroadcast] is shown. */
    private var liveStatusMessage = ""
    private var videoSourceMode = "screen"
    private var cameraFacingFront = true
    private var cameraStreamingActive = false
    private var broadcastActive = false
    private var cameraPreviewRenderer: SurfaceViewRenderer? = null
    private var videoResolution = VideoSettings.defaultResolution()
    private var videoFps = VideoSettings.DEFAULT_FPS

    private var navButtons: MutableList<LinearLayout> = mutableListOf()
    private var pendingCoverStreamId: Long = 0L
    private var coverUploading = false
    private var live2DViewer: Live2DViewer? = null
    private var live2DStateView: TextView? = null
    private var live2DModelUrl = ""
    private var live2DStatusMessage = ""

    /** Convenience accessor for the zh/en dictionary used by every visible string. */
    private fun tr(key: String, vararg args: Any?): String = L10n.t(lang, key, *args)

    private val capture = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            startWhipService(result.data, useCamera = false)
        } else setStatus(tr("status.screenPermissionCancelled"))
    }

    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) beginSelectedCapture() else setStatus(tr("status.micDenied"))
    }

    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startCameraStreaming() else setStatus(tr("status.cameraDenied"))
    }

    /**
     * ACTION_OPEN_DOCUMENT：让系统相册/文件选择器返回图片 Uri，不需要任何存储权限，
     * 也不需要向用户申请 READ_MEDIA_IMAGES。
     */
    private val coverPicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val streamId = pendingCoverStreamId
        pendingCoverStreamId = 0L
        if (uri == null) {
            setStatus(tr("status.coverCancelled"))
        } else if (streamId <= 0L) {
            setStatus(tr("status.coverCreateFirst"))
        } else {
            setStatus(tr("status.coverCompressing"))
            executor.execute {
                val prepared = try {
                    CoverSupport.prepare(contentResolver, uri)
                } catch (_: Exception) {
                    null
                }
                runOnUiThread {
                    if (prepared == null) {
                        setStatus(tr("status.coverReadFailed"))
                    } else {
                        uploadCover(streamId, prepared)
                    }
                }
            }
        }
    }

    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val message = intent?.getStringExtra(ScreenStreamService.EXTRA_MESSAGE) ?: tr("status.updated")
            val code = intent?.getStringExtra(ScreenStreamService.EXTRA_STATUS_CODE).orEmpty()
            val wasCameraStreamingActive = cameraStreamingActive
            liveStatusMessage = message
            when (code) {
                ScreenStreamService.STATUS_CAMERA_STARTED -> cameraStreamingActive = true
                ScreenStreamService.STATUS_CAMERA_FRONT -> cameraFacingFront = true
                ScreenStreamService.STATUS_CAMERA_BACK -> cameraFacingFront = false
                ScreenStreamService.STATUS_PUSH_OK,
                ScreenStreamService.STATUS_CONNECTING -> broadcastActive = true
                ScreenStreamService.STATUS_STOPPED,
                ScreenStreamService.STATUS_FAILED -> {
                    cameraStreamingActive = false
                    broadcastActive = false
                }
            }
            setStatus(message)
            when (code) {
                ScreenStreamService.STATUS_PUSH_OK -> {
                    liveStatusMessage = tr("status.liveConfirming")
                    setStatus(liveStatusMessage)
                    refreshStreams()
                    confirmCreatedStreamLive()
                }
                ScreenStreamService.STATUS_STOPPED,
                ScreenStreamService.STATUS_FAILED -> {
                    refreshStreams()
                    loadMyStreams()
                }
            }
            // 只在摄像头预览的显示状态真正变化时重建视图，避免每次状态广播
            // 都 release/init SurfaceViewRenderer 造成黑屏或闪烁。
            if (currentTab == 1 && cameraStreamingActive != wasCameraStreamingActive) render()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = BG
        window.navigationBarColor = BG
        window.decorView.systemUiVisibility = 0

        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        apiBase = prefs.getString("api", DEFAULT_API) ?: DEFAULT_API
        token = prefs.getString("token", null)
        currentUsername = prefs.getString("username", "") ?: ""
        videoResolution = VideoSettings.resolution(prefs.getString(VideoSettings.KEY_RESOLUTION, VideoSettings.DEFAULT_RESOLUTION_ID))
        videoFps = VideoSettings.normalizedFps(prefs.getInt(VideoSettings.KEY_FPS, VideoSettings.DEFAULT_FPS))
        // v0.7.7: the dictionary language defaults to the system language.
        lang = L10n.read(this)
        CameraPreviewBridge.setLanguage(lang)
        // Camera preview first-frame notices are localized by the bridge itself.
        CameraPreviewBridge.onStatus = { message -> runOnUiThread { setStatus(message) } }
        statusMessage = tr("shell.statusReady")

        buildShell()
        registerStatusReceiver(IntentFilter(ScreenStreamService.ACTION_STATUS))
        render()
        if (!token.isNullOrBlank()) {
            refreshStreams()
            loadMyStreams()
        }
    }

    /** The user-visible default stream title for the active source, in the current language. */
    private fun defaultDraftTitle(): String = tr(
        if (videoSourceMode == "camera") "broadcast.defaultCameraTitle" else "broadcast.defaultScreenTitle"
    )

    private fun draftTitleValue(): String = draftTitle.ifBlank { defaultDraftTitle() }

    /** The current status line shown on the broadcast page, in the current language. */
    private fun broadcastStatusText(): String =
        liveStatusMessage.ifBlank { tr("broadcast.idle") }

    /** The Live2D hint shown below the WebView, in the current language. */
    private fun live2DStatusText(): String =
        live2DStatusMessage.ifBlank { tr("live2d.waiting") }

    /**
     * Applies a new UI language, persists it and rebuilds the whole view hierarchy so
     * every label, dialog, empty state and page is re-rendered immediately.
     */
    private fun switchLanguage(newLang: Lang) {
        if (newLang == this.lang) return
        this.lang = newLang
        L10n.write(this, newLang)
        CameraPreviewBridge.setLanguage(newLang)
        live2DViewer?.setLanguage(newLang)
        // Reset transient status lines so they are rebuilt from the new dictionary.
        liveStatusMessage = if (broadcastActive) tr("status.liveConfirmed") else ""
        live2DStatusMessage = ""
        chatSocketState = if (chatSocket != null) tr("chat.connected") else tr("chat.disconnected")
        statusMessage = tr("status.languageChanged")
        buildShell()
        render()
        setStatus(statusMessage)
    }

    // ---------------------------------------------------------------------
    // Shell / theme
    // ---------------------------------------------------------------------

    private fun buildShell() {
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                intArrayOf(BG_TOP, BG_MID, BG_BOTTOM)
            )
            setPadding(dp(16), dp(8), dp(16), dp(6))
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(10), 0, dp(10))
        }
        val brand = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val brandTitle = TextView(this).apply {
            text = tr("brand.app")
            textSize = 24f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(TEXT)
            paint.shader = LinearGradient(
                0f, 0f, 0f, textSize * 1.1f,
                intArrayOf(0xFFFFFFFF.toInt(), 0xFFC5B6FF.toInt()),
                null,
                Shader.TileMode.CLAMP
            )
        }
        brand.addView(brandTitle)
        brand.addView(TextView(this).apply {
            text = tr("brand.subtitle")
            textSize = 9.5f
            setTextColor(MUTED)
            letterSpacing = 0.18f
        })
        header.addView(brand, LinearLayout.LayoutParams(0, -2, 1f))
        header.addView(TextView(this).apply {
            text = "v0.7.7"
            textSize = 10.5f
            setTextColor(0xFFD9CEFF.toInt())
            gravity = Gravity.CENTER
            setPadding(dp(11), dp(6), dp(11), dp(6))
            background = rounded(0x338B72FF, 12)
        })
        root.addView(header)

        val statusRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(13), dp(11), dp(13), dp(11))
            background = rounded(PANEL_ALT, 14, stroke = true)
            elevation = dp(2).toFloat()
        }
        statusRow.addView(View(this).apply {
            background = rounded(TEAL, 4)
        }, LinearLayout.LayoutParams(dp(8), dp(8)).apply { marginEnd = dp(9) })
        statusView = TextView(this).apply {
            text = statusMessage.ifBlank { tr("shell.statusReady") }
            textSize = 12f
            setTextColor(MUTED)
            setLineSpacing(0f, 1.15f)
        }
        statusRow.addView(statusView, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(statusRow, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(10) })

        val scroll = ScrollView(this).apply {
            isFillViewport = true
            clipToPadding = false
            isVerticalScrollBarEnabled = false
            setPadding(0, dp(2), 0, dp(10))
        }
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        scroll.addView(content)
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))

        val nav = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(dp(4), dp(4), dp(4), dp(4))
            background = rounded(PANEL, 24, stroke = true)
            elevation = dp(10).toFloat()
        }
        navButtons = mutableListOf()
        listOf(
            "🏠" to "nav.lobby",
            "🎥" to "nav.broadcast",
            "🎞" to "nav.recordings",
            "👤" to "nav.profile",
            "✨" to "nav.live2d"
        ).forEachIndexed { index, (icon, labelKey) ->
            val item = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setPadding(0, dp(6), 0, dp(5))
                isClickable = true
                isFocusable = true
                background = navItemBackground(index == currentTab)
                setOnClickListener { selectTab(index) }
            }
            item.addView(TextView(this).apply {
                text = icon
                textSize = 15f
                gravity = Gravity.CENTER
            })
            item.addView(TextView(this).apply {
                text = tr(labelKey)
                textSize = 10f
                gravity = Gravity.CENTER
                letterSpacing = 0.02f
                setTextColor(if (index == currentTab) TEXT else MUTED)
            })
            nav.addView(item, LinearLayout.LayoutParams(0, dp(52), 1f).apply {
                marginStart = dp(2)
                marginEnd = dp(2)
            })
            navButtons.add(item)
        }
        root.addView(nav, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
        setContentView(root)
    }

    private fun selectTab(index: Int) {
        currentTab = index
        if (index != 0) {
            selectedStream = null
            stopLivePlayback()
        }
        if (index == 0) refreshStreams()
        if (index == 2) loadRecordings()
        if (index == 3) loadMyStreams()
        render()
    }

    private fun paintNav() {
        navButtons.forEachIndexed { index, item ->
            val selected = index == currentTab
            item.background = navItemBackground(selected)
            (item.getChildAt(1) as? TextView)?.setTextColor(if (selected) TEXT else MUTED)
        }
    }

    private fun render() {
        if (!::content.isInitialized) return
        // Detach the preview from the window before the bridge releases its EGL surface.
        cameraPreviewRenderer?.let { preview ->
            (preview.parent as? ViewGroup)?.removeView(preview)
            CameraPreviewBridge.detach(preview)
        }
        cameraPreviewRenderer = null
        paintNav()
        if (currentTab == 4) live2DViewer?.setPaused(false) else live2DViewer?.setPaused(true)
        content.removeAllViews()
        if (token.isNullOrBlank()) renderAuthCard()
        when (currentTab) {
            0 -> renderLobby()
            1 -> renderBroadcast()
            2 -> renderRecordings()
            3 -> renderProfile()
            else -> renderLive2D()
        }
    }

    private fun renderAuthCard() {
        val card = panel()
        card.addView(heading(tr("auth.welcome")))
        card.addView(body(tr("auth.body")))
        val userInput = input(tr("auth.username"))
        val passInput = input(tr("auth.password"), true)
        card.addView(userInput, fieldParams())
        card.addView(passInput, fieldParams())
        val actions = horizontal()
        actions.addView(actionButton(tr("auth.login"), true) {
            val u = userInput.text.toString().trim()
            val p = passInput.text.toString()
            auth("login", u, p)
        }, weighted())
        actions.addView(actionButton(tr("auth.register"), false) {
            auth("register", userInput.text.toString().trim(), passInput.text.toString())
        }, weighted())
        card.addView(actions)
        card.addView(body(tr("auth.serverHint")))
        val serverInput = input(tr("auth.serverPlaceholder"), false).apply { setText(apiBase) }
        card.addView(serverInput, fieldParams())
        card.addView(actionButton(tr("auth.saveServer"), false) {
            saveAndCheckServer(serverInput.text.toString())
        })
        content.addView(card, cardParams())
    }

    // ---------------------------------------------------------------------
    // Lobby
    // ---------------------------------------------------------------------

    private fun renderLobby() {
        val top = panel()
        val row = horizontal()
        row.addView(heading(tr("lobby.title")), LinearLayout.LayoutParams(0, -2, 1f))
        row.addView(actionButton(tr("lobby.refresh"), false) { refreshStreams() })
        top.addView(row)
        top.addView(body(tr("lobby.body")))
        if (streams.isEmpty()) {
            top.addView(body(tr("lobby.empty")))
        } else {
            streams.forEach { stream ->
                val item = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(10), dp(10), dp(10), dp(12))
                    background = rounded(PANEL_ALT, 18, stroke = true)
                    elevation = dp(3).toFloat()
                }
                item.addView(coverFrame(stream.title, stream.coverUrl, large = true), LinearLayout.LayoutParams(-1, dp(148)))
                val line = horizontal()
                line.setPadding(0, dp(10), 0, 0)
                val detail = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
                detail.addView(TextView(this).apply {
                    text = stream.title
                    textSize = 15f
                    setTextColor(TEXT)
                    setTypeface(typeface, Typeface.BOLD)
                })
                detail.addView(body(tr("lobby.host", stream.username)))
                line.addView(detail, LinearLayout.LayoutParams(0, -2, 1f))
                line.addView(TextView(this).apply {
                    text = if (stream.isLive) tr("lobby.live") else tr("lobby.offline")
                    textSize = 11f
                    setTextColor(if (stream.isLive) GREEN else MUTED)
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(9), dp(3), dp(9), dp(3))
                    background = rounded(if (stream.isLive) 0x2254E0A8 else 0x11FFFFFF, 10)
                })
                item.addView(line)
                item.addView(actionButton(if (selectedStream?.id == stream.id) tr("lobby.currentRoom") else tr("lobby.watch"), true) {
                    if (!stream.isLive) {
                        setStatus(tr("status.notLive"))
                    } else {
                        selectedStream = stream
                        selectedRecording = null
                        stopPlayback()
                        connectChat(stream.id)
                        render()
                    }
                }.apply { isEnabled = stream.isLive })
                top.addView(item, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(10) })
            }
        }
        content.addView(top, cardParams())

        selectedStream?.let { stream ->
            val playback = panel()
            playback.addView(heading(tr("lobby.watching", stream.title)))
            playback.addView(body(tr("lobby.host", stream.username)))
            attachLiveRenderer(playback, 210, stream)
            val chatCard = panel()
            chatCard.addView(heading(tr("chat.title")))
            chatCard.addView(body(if (token.isNullOrBlank()) tr("status.needLoginComments") else tr("chat.connection", chatSocketText())))
            val messagesBox = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(10), dp(8), dp(10), dp(8))
                background = rounded(PANEL_ALT, 14, stroke = true)
            }
            if (chatMessages.isEmpty()) messagesBox.addView(body(tr("chat.empty")))
            chatMessages.takeLast(60).forEach { message ->
                val line = horizontal()
                line.addView(TextView(this).apply {
                    text = message.username
                    textSize = 12f
                    setTextColor(PURPLE)
                    setTypeface(typeface, Typeface.BOLD)
                })
                line.addView(TextView(this).apply {
                    text = "  ${message.content}"
                    textSize = 13f
                    setTextColor(TEXT)
                }, LinearLayout.LayoutParams(0, -2, 1f))
                messagesBox.addView(line)
            }
            chatCard.addView(messagesBox, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
            val chatInput = input(tr("chat.placeholder")).apply { filters = arrayOf(InputFilter.LengthFilter(500)) }
            val send = actionButton(tr("chat.send"), true) { sendChat(chatInput.text.toString()); chatInput.setText("") }
            val chatRow = horizontal()
            chatRow.addView(chatInput, LinearLayout.LayoutParams(0, dp(50), 1f).apply { marginEnd = dp(8) })
            chatRow.addView(send)
            chatCard.addView(chatRow)
            chatCard.addView(actionButton(tr("chat.leave"), false) {
                disconnectChat()
                selectedStream = null
                stopPlayback()
                render()
            })
            content.addView(playback, cardParams())
            content.addView(chatCard, cardParams())
        }
    }

    private var chatSocketState = ""

    /** Chat connection state; falls back to the localized "disconnected" label. */
    private fun chatSocketText(): String =
        chatSocketState.ifBlank { tr("chat.disconnected") }

    // ---------------------------------------------------------------------
    // Broadcast
    // ---------------------------------------------------------------------

    private fun renderBroadcast() {
        val card = panel()
        card.addView(heading(tr("broadcast.title")))
        card.addView(body(tr("broadcast.body")))
        val statusLine = body(tr("broadcast.currentStatus", broadcastStatusText()))
        card.addView(statusLine)
        val sourceRow = horizontal()
        sourceRow.addView(actionButton(tr("broadcast.screen"), videoSourceMode == "screen") {
            if (broadcastActive) setStatus(tr("broadcast.stopFirstToSwitch")) else {
                videoSourceMode = "screen"
                draftTitle = ""
                render()
            }
        }.apply { isEnabled = !broadcastActive }, weighted())
        sourceRow.addView(actionButton(tr("broadcast.camera"), videoSourceMode == "camera") {
            if (broadcastActive) setStatus(tr("broadcast.stopFirstToSwitch")) else {
                videoSourceMode = "camera"
                draftTitle = ""
                render()
            }
        }.apply { isEnabled = !broadcastActive }, weighted())
        card.addView(sourceRow)

        // 画质设置：分辨率 + 帧率。选择后立即写入 SharedPreferences，并在下一次
        // 开播时通过 Intent extras 交给 ScreenStreamService。
        val qualitySummary = body("")
        val resolutionButtons = mutableMapOf<String, Button>()
        val fpsButtons = mutableMapOf<Int, Button>()
        fun paintQualitySelection() {
            qualitySummary.text = videoQualitySummary()
            resolutionButtons.forEach { (id, button) ->
                button.background = selectionButtonBackground(id == videoResolution.id)
            }
            fpsButtons.forEach { (fps, button) ->
                button.background = selectionButtonBackground(fps == videoFps)
            }
        }
        card.addView(sectionLabel(tr("broadcast.qualityTitle")))
        val resolutionRow = horizontal()
        VideoSettings.RESOLUTIONS.forEach { option ->
            val button = actionButton(option.label, false) {
                if (videoResolution.id != option.id) {
                    videoResolution = option
                    persistVideoSettings()
                    paintQualitySelection()
                    setStatus(
                        tr(
                            "broadcast.resolutionSaved",
                            option.label,
                            option.width,
                            option.height,
                            bitrateLabel(option.bitrateBps)
                        )
                    )
                }
            }
            resolutionButtons[option.id] = button
            resolutionRow.addView(button, weighted())
        }
        card.addView(resolutionRow)
        val fpsRow = horizontal()
        VideoSettings.FPS_OPTIONS.forEach { fps ->
            val button = actionButton("$fps fps", false) {
                if (videoFps != fps) {
                    videoFps = fps
                    persistVideoSettings()
                    paintQualitySelection()
                    setStatus(tr("broadcast.fpsSaved", fps))
                }
            }
            fpsButtons[fps] = button
            fpsRow.addView(button, weighted())
        }
        card.addView(fpsRow)
        paintQualitySelection()
        card.addView(qualitySummary)

        if (videoSourceMode == "camera") {
            card.addView(body(tr("broadcast.cameraBody")))
            if (cameraStreamingActive) {
                val preview = SurfaceViewRenderer(this).apply {
                    layoutParams = LinearLayout.LayoutParams(-1, dp(220)).apply { topMargin = dp(8); bottomMargin = dp(8) }
                    setBackgroundColor(Color.BLACK)
                    // 放到窗口之上，避免部分机型把 SurfaceView 压在 Activity 窗口后面，只剩黑块。
                    setZOrderOnTop(true)
                }
                cameraPreviewRenderer = preview
                // SurfaceViewRenderer 必须先 init（创建 EGL surface）再加入窗口，
                // 否则部分机型不会再回调 surfaceCreated，预览会一直黑屏。
                if (!CameraPreviewBridge.attach(preview)) setStatus(tr("broadcast.previewUnavailable"))
                card.addView(preview)
                card.addView(actionButton(tr("broadcast.switchCamera"), false) {
                    startService(
                        Intent(this, ScreenStreamService::class.java)
                            .setAction(ScreenStreamService.ACTION_SWITCH_CAMERA)
                            .putExtra(ScreenStreamService.EXTRA_LANGUAGE, lang.code)
                    )
                })
            }
        } else {
            card.addView(body(tr("broadcast.screenPermissionBody")))
        }
        val titleInput = input(tr("broadcast.titleHint")).apply { setText(draftTitleValue()) }
        titleInput.addTextChangedListener(SimpleTextWatcher { draftTitle = it })
        card.addView(titleInput, fieldParams())
        card.addView(actionButton(tr("broadcast.create"), true) { createLive() })
        if (createdPublishPath.isNotBlank()) {
            card.addView(infoRow(tr("broadcast.protocol"), "WebRTC / WHIP"))
            card.addView(
                infoRow(
                    tr("broadcast.source"),
                    if (videoSourceMode == "camera") tr("broadcast.sourceCamera") else tr("broadcast.sourceScreen")
                )
            )
            card.addView(infoRow(tr("broadcast.qualityLabel"), "${videoResolution.label} · ${bitrateLabel(videoResolution.bitrateBps)} · $videoFps fps"))
            card.addView(infoRow(tr("broadcast.publishPath"), createdPublishPath))
            if (createdStreamId > 0L) {
                card.addView(sectionLabel(tr("broadcast.coverTitle")))
                card.addView(
                    coverFrame(draftTitleValue(), createdCoverUrl, large = true),
                    LinearLayout.LayoutParams(-1, dp(164)).apply { topMargin = dp(8) }
                )
                card.addView(actionButton(if (coverUploading) tr("broadcast.coverUploading") else tr("broadcast.chooseCover"), false) {
                    pickCover(createdStreamId)
                }.apply { isEnabled = !coverUploading })
            }
            card.addView(
                actionButton(
                    if (videoSourceMode == "camera") tr("broadcast.startCamera") else tr("broadcast.startScreen"),
                    true
                ) { startCapture() }
            )
        } else {
            card.addView(body(tr("broadcast.createdHint")))
        }
        card.addView(actionButton(tr("broadcast.stop"), false) {
            liveStatusMessage = tr("broadcast.stopping")
            startService(
                Intent(this, ScreenStreamService::class.java)
                    .setAction(ScreenStreamService.ACTION_STOP)
                    .putExtra(ScreenStreamService.EXTRA_LANGUAGE, lang.code)
            )
            setStatus(liveStatusMessage)
            render()
        })
        content.addView(card, cardParams())

        val own = panel()
        own.addView(heading(tr("broadcast.myStreams")))
        if (myStreams.length() == 0) own.addView(body(tr("broadcast.myStreamsEmpty")))
        for (i in 0 until myStreams.length()) {
            val item = myStreams.optJSONObject(i) ?: continue
            val streamId = item.optLong("id")
            val title = item.optString("title", tr("broadcast.untitled"))
            val isLive = item.optBooleanCompat("is_live")
            val coverUrl = myStreamCoverUrl(streamId, item)
            val row = horizontal()
            row.setPadding(0, dp(9), 0, 0)
            row.addView(
                coverFrame(title, coverUrl, large = false),
                LinearLayout.LayoutParams(dp(62), dp(62)).apply { marginEnd = dp(12) }
            )
            val detail = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            detail.addView(TextView(this).apply {
                text = title
                textSize = 14f
                setTextColor(TEXT)
                setTypeface(typeface, Typeface.BOLD)
            })
            detail.addView(body(
                "${if (isLive) tr("lobby.live") else tr("lobby.offline")}  ·  " +
                    (if (coverUrl.isNotBlank()) tr("broadcast.hasCover") else tr("broadcast.noCover"))
            ))
            detail.addView(chipButton(if (coverUploading) tr("broadcast.uploadingShort") else tr("broadcast.chooseCoverShort"), false) {
                pickCover(streamId)
            }.apply { isEnabled = !coverUploading })
            row.addView(detail, LinearLayout.LayoutParams(0, -2, 1f))
            own.addView(row)
        }
        content.addView(own, cardParams())
    }

    private fun renderRecordings() {
        val card = panel()
        val row = horizontal()
        row.addView(heading(tr("recordings.title")), LinearLayout.LayoutParams(0, -2, 1f))
        row.addView(actionButton(tr("recordings.refresh"), false) { loadRecordings() })
        card.addView(row)
        card.addView(body(tr("recordings.body")))
        if (token.isNullOrBlank()) {
            card.addView(body(tr("recordings.needLogin")))
        } else if (recordings.isEmpty()) {
            card.addView(body(tr("recordings.empty")))
        } else {
            recordings.forEach { recording ->
                val item = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(12), dp(12), dp(12), dp(12))
                    background = rounded(PANEL_ALT, 16, stroke = true)
                }
                item.addView(TextView(this).apply {
                    text = recording.name
                    textSize = 14f
                    setTextColor(TEXT)
                    setTypeface(typeface, Typeface.BOLD)
                })
                item.addView(body("${formatBytes(recording.size)}  ·  ${recording.modifiedAt.replace('T', ' ').take(16)}"))
                item.addView(actionButton(if (selectedRecording?.id == recording.id) tr("recordings.playing") else tr("recordings.play"), true) {
                    selectedRecording = recording
                    selectedStream = null
                    stopLivePlayback()
                    disconnectChat()
                    playMedia(recording.playUrl)
                    render()
                })
                item.addView(body(recording.path))
                card.addView(item, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(9) })
            }
        }
        content.addView(card, cardParams())
        selectedRecording?.let { recording ->
            val playCard = panel()
            playCard.addView(heading(tr("recordings.playTitle", recording.name)))
            attachPlayer(playCard, 220)
            content.addView(playCard, cardParams())
        }
    }

    private fun renderProfile() {
        val card = panel()
        card.addView(heading(tr("profile.title")))
        if (token.isNullOrBlank()) {
            card.addView(body(tr("profile.bodyGuest")))
        } else {
            card.addView(TextView(this).apply {
                text = "👤  $currentUsername"
                textSize = 18f
                setTextColor(TEXT)
                setTypeface(typeface, Typeface.BOLD)
                setPadding(0, dp(2), 0, dp(4))
            })
            card.addView(body(if (bannedNotice) tr("profile.banned") else tr("profile.statusOk")))
            card.addView(actionButton(tr("profile.checkStatus"), true) { loadMyStreams() })
            card.addView(actionButton(tr("profile.logout"), false) {
                disconnectChat()
                token = null
                currentUsername = ""
                bannedNotice = false
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove("token").remove("username").apply()
                setStatus(tr("status.loggedOut"))
                render()
            })
        }
        content.addView(card, cardParams())

        // v0.7.7: 中文 / English switch. Rebuilds the whole UI immediately and persists
        // the choice in SharedPreferences `app_language`.
        val language = panel()
        language.addView(heading(tr("profile.language")))
        language.addView(body(tr("profile.languageBody")))
        val languageRow = horizontal()
        val zhButton = actionButton(tr("lang.zh"), false) { switchLanguage(Lang.ZH) }
        zhButton.background = selectionButtonBackground(lang == Lang.ZH)
        val enButton = actionButton(tr("lang.en"), false) { switchLanguage(Lang.EN) }
        enButton.background = selectionButtonBackground(lang == Lang.EN)
        languageRow.addView(zhButton, weighted())
        languageRow.addView(enButton, weighted())
        language.addView(languageRow)
        content.addView(language, cardParams())

        val settings = panel()
        settings.addView(heading(tr("profile.settings")))
        settings.addView(body(tr("profile.serverBody")))
        apiAddressInput = input(tr("profile.apiHint"), false).apply { setText(apiBase) }
        settings.addView(apiAddressInput, fieldParams())
        settings.addView(actionButton(tr("profile.saveServer"), true) {
            saveAndCheckServer(apiAddressInput.text.toString())
        })
        content.addView(settings, cardParams())
    }

    // ---------------------------------------------------------------------
    // Live2D 看板娘 (UI only, never composited into WebRTC)
    // ---------------------------------------------------------------------

    private fun renderLive2D() {
        val card = panel()
        card.addView(heading(tr("live2d.title")))
        card.addView(body(tr("live2d.body")))
        card.addView(body(tr("live2d.body2")))

        val viewer = live2DViewer ?: Live2DViewer(
            this,
            lang,
            onStatus = { message ->
                runOnUiThread {
                    live2DStatusMessage = message
                    live2DStateView?.text = message
                    setStatus(message)
                }
            },
            onError = { message ->
                runOnUiThread {
                    live2DStatusMessage = message
                    live2DStateView?.text = message
                    setStatus(message)
                }
            }
        ).also { live2DViewer = it }

        val webBox = FrameLayout(this).apply {
            background = rounded(PANEL_DEEP, 18, stroke = true)
            clipToOutline = true
            outlineProvider = roundedOutline(18)
        }
        (viewer.webView.parent as? ViewGroup)?.removeView(viewer.webView)
        webBox.addView(viewer.webView, FrameLayout.LayoutParams(-1, -1))
        card.addView(webBox, LinearLayout.LayoutParams(-1, dp(340)).apply { topMargin = dp(10) })

        val urlInput = input(tr("live2d.urlHint"), false)
        if (live2DModelUrl.isNotBlank()) urlInput.setText(live2DModelUrl)
        card.addView(urlInput, fieldParams())
        val actions = horizontal()
        actions.addView(actionButton(tr("live2d.load"), true) {
            val url = urlInput.text.toString().trim()
            live2DModelUrl = url
            viewer.loadModel(url)
        }, weighted())
        actions.addView(actionButton(tr("live2d.show"), false) { viewer.showModel() }, weighted())
        actions.addView(actionButton(tr("live2d.hide"), false) { viewer.hideModel() }, weighted())
        card.addView(actions)
        val state = body(live2DStatusText())
        live2DStateView = state
        card.addView(state)
        card.addView(actionButton(tr("live2d.reload"), false) { viewer.reload() })
        content.addView(card, cardParams())
    }

    // ---------------------------------------------------------------------
    // Cover upload helpers
    // ---------------------------------------------------------------------

    private fun pickCover(streamId: Long) {
        if (token.isNullOrBlank()) {
            setStatus(tr("status.coverLogin"))
            return
        }
        if (streamId <= 0L) {
            setStatus(tr("status.coverCreateFirst"))
            return
        }
        if (coverUploading) {
            setStatus(tr("status.coverUploadingPrevious"))
            return
        }
        pendingCoverStreamId = streamId
        setStatus(tr("status.coverChoose"))
        coverPicker.launch(arrayOf("image/*"))
    }

    private fun uploadCover(streamId: Long, prepared: CoverSupport.PreparedCover) {
        coverUploading = true
        setStatus(tr("status.coverUploading", prepared.sizeLabel))
        render()
        apiRequest(
            "POST",
            "/api/streams/$streamId/cover",
            JSONObject().put("imageData", prepared.dataUrl),
            true,
            readTimeoutMs = 60_000
        ) { result ->
            coverUploading = false
            if (result.code in 200..299) {
                val coverUrl = resolveApiUrl(result.obj?.optString("coverUrl").orEmpty())
                if (coverUrl.isNotBlank()) {
                    CoverLoader.put(coverUrl, prepared.bitmap)
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                        .putString(COVER_PREF_PREFIX + streamId, coverUrl)
                        .apply()
                }
                if (streamId == createdStreamId) createdCoverUrl = coverUrl
                setStatus(tr("status.coverUpdated"))
                loadMyStreams()
                refreshStreams()
                render()
            } else {
                if (result.code == 413) setStatus(tr("status.coverTooLarge"))
                else handleApiError(result, tr("status.coverUploadFailed"))
            }
        }
    }

    private fun myStreamCoverUrl(streamId: Long, item: JSONObject): String {
        val fromServer = item.optString("coverUrl").ifBlank { item.optString("cover_url") }
        if (fromServer.isNotBlank()) return resolveApiUrl(fromServer)
        return getSharedPreferences(PREFS, MODE_PRIVATE).getString(COVER_PREF_PREFIX + streamId, "").orEmpty()
    }

    private fun resolveApiUrl(raw: String): String {
        val value = raw.trim()
        if (value.isEmpty()) return ""
        if (value.startsWith("http://") || value.startsWith("https://")) return value
        return apiBase.trimEnd('/') + if (value.startsWith("/")) value else "/$value"
    }

    // ---------------------------------------------------------------------
    // Networking / auth
    // ---------------------------------------------------------------------

    private fun saveAndCheckServer(rawValue: String) {
        val value = rawValue.trim().trimEnd('/')
        if (!value.startsWith("http://") && !value.startsWith("https://")) {
            setStatus(tr("status.serverInvalid"))
            return
        }
        if (value.endsWith("/api", ignoreCase = true)) {
            setStatus(tr("status.serverNoApiSuffix"))
            return
        }
        apiBase = value
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("api", apiBase).apply()
        setStatus(tr("status.serverChecking", apiBase))
        apiRequest("GET", "/api/health", null, false) { result ->
            if (result.code == 200 && result.obj?.optBoolean("ok") == true) {
                val dbStatus = result.obj.optString("database", "unknown")
                setStatus(tr("status.serverOk", dbStatus))
                refreshStreams()
            } else {
                val reason = result.obj?.optString("error")?.takeIf { it.isNotBlank() }
                    ?: result.raw.take(180).ifBlank { "HTTP ${result.code}" }
                setStatus(tr("status.serverFailed", L10n.serverError(lang, reason)))
            }
        }
    }

    private fun auth(path: String, username: String, password: String) {
        if (username.isBlank() || password.isBlank()) {
            setStatus(tr("status.authFields"))
            return
        }
        val usernameLength = username.codePointCount(0, username.length)
        if (usernameLength !in 3..40 || !username.matches(Regex("[\\p{L}\\p{N}_]+"))) {
            setStatus(tr("status.authUsername"))
            return
        }
        if (password.length !in 8..128) {
            setStatus(tr("status.authPassword"))
            return
        }
        apiRequest("POST", "/api/auth/$path", JSONObject().put("username", username).put("password", password), false) { result ->
            if (result.code in 200..299) {
                if (path == "login") {
                    token = result.obj?.optString("token")
                    currentUsername = result.obj?.optJSONObject("user")?.optString("username") ?: username
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                        .putString("token", token).putString("username", currentUsername).apply()
                    bannedNotice = false
                    setStatus(tr("status.loginOk", currentUsername))
                    refreshStreams()
                    loadMyStreams()
                    loadRecordings()
                } else {
                    setStatus(tr("status.registerOk"))
                }
                render()
            } else handleApiError(result, tr("status.authFailed"))
        }
    }

    private fun createLive() {
        if (token.isNullOrBlank()) {
            setStatus(tr("status.needLogin"))
            currentTab = 3
            render()
            return
        }
        apiRequest("POST", "/api/streams", JSONObject().put("title", draftTitleValue()), true) { result ->
            if (result.code in 200..299) {
                createdPublishPath = result.obj?.optString("publishPath").orEmpty()
                createdStreamId = result.obj?.optLong("id") ?: 0L
                createdCoverUrl = ""
                liveStatusMessage = tr("broadcast.roomCreated")
                setStatus(tr("status.created"))
                loadMyStreams()
                render()
            } else handleApiError(result, tr("status.createFailed"))
        }
    }

    private fun startCapture() {
        if (token.isNullOrBlank()) {
            setStatus(tr("status.needLoginCreate"))
            return
        }
        if (!createdPublishPath.startsWith("/api/streams/") || token.isNullOrBlank()) {
            setStatus(tr("status.needLoginValidStream"))
            return
        }
        liveStatusMessage = if (videoSourceMode == "camera") tr("status.waitCameraPermission") else tr("status.waitScreenPermission")
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            micPermission.launch(Manifest.permission.RECORD_AUDIO)
        } else beginSelectedCapture()
    }

    private fun beginSelectedCapture() {
        if (videoSourceMode == "camera") {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                cameraPermission.launch(Manifest.permission.CAMERA)
            } else startCameraStreaming()
        } else requestCapture()
    }

    private fun startCameraStreaming() {
        if (createdPublishPath.isBlank() || token.isNullOrBlank()) {
            setStatus(tr("status.needLoginStream"))
            return
        }
        val service = Intent(this, ScreenStreamService::class.java).apply {
            action = ScreenStreamService.ACTION_START
            putExtra(ScreenStreamService.EXTRA_CAMERA_MODE, true)
            putExtra(ScreenStreamService.EXTRA_FRONT_CAMERA, cameraFacingFront)
            putExtra(ScreenStreamService.EXTRA_SIGNAL_URL, apiBase.trimEnd('/') + createdPublishPath)
            putExtra(ScreenStreamService.EXTRA_AUTH_TOKEN, token.orEmpty())
            putExtra(ScreenStreamService.EXTRA_LANGUAGE, lang.code)
            putVideoExtras(this)
        }
        ContextCompat.startForegroundService(this, service)
        cameraStreamingActive = true
        broadcastActive = true
        liveStatusMessage = tr("status.openingCamera")
        setStatus(liveStatusMessage)
        if (currentTab == 1) render()
    }

    private fun startWhipService(projectionData: Intent?, useCamera: Boolean) {
        val service = Intent(this, ScreenStreamService::class.java).apply {
            action = ScreenStreamService.ACTION_START
            putExtra(ScreenStreamService.EXTRA_CAMERA_MODE, useCamera)
            putExtra(ScreenStreamService.EXTRA_RESULT_CODE, Activity.RESULT_OK)
            putExtra(ScreenStreamService.EXTRA_DATA, projectionData)
            putExtra(ScreenStreamService.EXTRA_SIGNAL_URL, apiBase.trimEnd('/') + createdPublishPath)
            putExtra(ScreenStreamService.EXTRA_AUTH_TOKEN, token.orEmpty())
            putExtra(ScreenStreamService.EXTRA_LANGUAGE, lang.code)
            putVideoExtras(this)
        }
        ContextCompat.startForegroundService(this, service)
        cameraStreamingActive = false
        broadcastActive = true
        liveStatusMessage = tr("status.requestingCapture")
        setStatus(liveStatusMessage)
        if (currentTab == 1) render()
    }

    private fun requestCapture() {
        val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        capture.launch(manager.createScreenCaptureIntent())
    }

    private fun persistVideoSettings() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putString(VideoSettings.KEY_RESOLUTION, videoResolution.id)
            .putInt(VideoSettings.KEY_FPS, videoFps)
            .apply()
    }

    /** Sends the selected landscape width/height; the service swaps them for screen capture. */
    private fun putVideoExtras(intent: Intent) {
        intent.putExtra(ScreenStreamService.EXTRA_VIDEO_WIDTH, videoResolution.width)
        intent.putExtra(ScreenStreamService.EXTRA_VIDEO_HEIGHT, videoResolution.height)
        intent.putExtra(ScreenStreamService.EXTRA_VIDEO_BITRATE, videoResolution.bitrateBps)
        intent.putExtra(ScreenStreamService.EXTRA_VIDEO_FPS, videoFps)
    }

    private fun videoQualitySummary(): String {
        val resolution = videoResolution
        return tr(
            "broadcast.qualitySummary",
            resolution.label,
            resolution.width,
            resolution.height,
            bitrateLabel(resolution.bitrateBps),
            videoFps,
            resolution.height,
            resolution.width,
            resolution.width,
            resolution.height
        )
    }

    private fun bitrateLabel(bps: Int): String =
        if (bps >= 1_000_000) {
            String.format(Locale.US, "%.1f Mbps", bps / 1_000_000.0).replace(".0 Mbps", " Mbps")
        } else {
            "${bps / 1000} kbps"
        }

    private fun refreshStreams() {
        apiRequest("GET", "/api/streams", null, false) { result ->
            if (result.code in 200..299) {
                val array = result.array ?: JSONArray()
                val next = mutableListOf<LiveStream>()
                for (i in 0 until array.length()) {
                    val item = array.optJSONObject(i) ?: continue
                    val live = item.optBooleanCompat("is_live")
                    val whepPath = item.optString("whepPath", "")
                    if (live && whepPath.isNotBlank()) next.add(LiveStream(
                        id = item.optLong("id"),
                        title = item.optString("title", tr("broadcast.untitled")),
                        username = item.optString("username", tr("chat.user")),
                        isLive = true,
                        whepPath = whepPath,
                        coverUrl = resolveApiUrl(item.optString("coverUrl").ifBlank { item.optString("cover_url") })
                    ))
                }
                // The public lobby is live-only. Keep the server as the source of truth,
                // and filter locally as a compatibility guard for older backend builds.
                streams = next.filter { it.isLive }
                if (currentTab == 0) render()
            } else if (result.code != 0) {
                handleApiError(result, tr("status.streamsReadFailed"), false)
            }
        }
    }

    private fun loadMyStreams() {
        if (token.isNullOrBlank()) return
        apiRequest("GET", "/api/streams/mine", null, true) { result ->
            if (result.code in 200..299) {
                myStreams = result.array ?: JSONArray()
                if (createdStreamId > 0L) {
                    for (i in 0 until myStreams.length()) {
                        val item = myStreams.optJSONObject(i) ?: continue
                        if (item.optLong("id") == createdStreamId) {
                            if (item.optBooleanCompat("is_live")) liveStatusMessage = tr("status.liveConfirmed")
                            val serverCover = myStreamCoverUrl(createdStreamId, item)
                            if (serverCover.isNotBlank()) createdCoverUrl = serverCover
                            break
                        }
                    }
                }
                if (currentTab == 1) render()
            } else handleApiError(result, tr("status.myStreamsReadFailed"))
        }
    }

    /** Poll the authenticated server state after the WHIP ICE connection succeeds.
     * The SRS on_publish hook is the source of truth for the public is_live flag.
     */
    private fun confirmCreatedStreamLive(attempt: Int = 0) {
        if (createdStreamId <= 0L || token.isNullOrBlank()) return
        apiRequest("GET", "/api/streams/mine", null, true) { result ->
            if (result.code in 200..299) {
                val array = result.array ?: JSONArray()
                myStreams = array
                var found = false
                var isLive = false
                for (i in 0 until array.length()) {
                    val item = array.optJSONObject(i) ?: continue
                    if (item.optLong("id") == createdStreamId) {
                        found = true
                        isLive = item.optBooleanCompat("is_live")
                        val serverCover = myStreamCoverUrl(createdStreamId, item)
                        if (serverCover.isNotBlank()) createdCoverUrl = serverCover
                        break
                    }
                }
                if (isLive) {
                    liveStatusMessage = tr("status.liveConfirmed")
                    setStatus(liveStatusMessage)
                    refreshStreams()
                } else if (found && attempt < 12) {
                    liveStatusMessage = tr("status.liveWaiting", attempt + 1)
                    setStatus(liveStatusMessage)
                    mainHandler.postDelayed({ confirmCreatedStreamLive(attempt + 1) }, 1500L)
                } else if (found) {
                    liveStatusMessage = tr("status.liveNotConfirmed")
                    setStatus(liveStatusMessage)
                } else {
                    liveStatusMessage = tr("status.liveMissing")
                    setStatus(liveStatusMessage)
                }
                if (currentTab == 1) render()
            } else {
                if (attempt < 12) mainHandler.postDelayed({ confirmCreatedStreamLive(attempt + 1) }, 1500L)
                else setStatus(tr("status.liveReadFailed", result.code))
            }
        }
    }

    private fun loadRecordings() {
        if (token.isNullOrBlank()) {
            recordings = emptyList()
            if (currentTab == 2) render()
            return
        }
        apiRequest("GET", "/api/recordings/mine", null, true) { result ->
            if (result.code in 200..299) {
                val array = result.array ?: JSONArray()
                val list = mutableListOf<Recording>()
                for (i in 0 until array.length()) {
                    val item = array.optJSONObject(i) ?: continue
                    list.add(Recording(
                        id = item.optString("id"),
                        name = item.optString("name"),
                        path = item.optString("path"),
                        size = item.optLong("size"),
                        modifiedAt = item.optString("modifiedAt"),
                        playUrl = item.optString("playUrl")
                    ))
                }
                recordings = list
                if (currentTab == 2) render()
            } else handleApiError(result, tr("status.recordingsReadFailed"))
        }
    }

    // ---------------------------------------------------------------------
    // Chat / playback (unchanged behaviour)
    // ---------------------------------------------------------------------

    private fun connectChat(streamId: Long) {
        val savedToken = token
        if (savedToken.isNullOrBlank()) {
            setStatus(tr("status.needLoginChat"))
            return
        }
        disconnectChat()
        chatMessages.clear()
        chatSocketState = tr("chat.connecting")
        val wsBase = apiBase.replaceFirst("^https://".toRegex(), "wss://")
            .replaceFirst("^http://".toRegex(), "ws://")
        val request = Request.Builder().url("${wsBase.trimEnd('/')}/ws/chat").build()
        chatSocket = httpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(JSONObject().put("type", "auth").put("token", savedToken).put("streamId", streamId).toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val data = JSONObject(text)
                    when (data.optString("type")) {
                        "ready" -> {
                            val history = data.optJSONArray("messages") ?: JSONArray()
                            val messages = mutableListOf<ChatMessage>()
                            for (i in 0 until history.length()) messages.add(history.optJSONObject(i)?.toChatMessage() ?: continue)
                            runOnUiThread {
                                chatMessages = messages
                                chatSocketState = tr("chat.connected")
                                setStatus(tr("status.chatConnected", selectedStream?.title ?: tr("chat.room")))
                                render()
                            }
                        }
                        "message" -> {
                            val message = data.optJSONObject("message")?.toChatMessage() ?: return
                            runOnUiThread {
                                chatMessages.add(message)
                                if (chatMessages.size > 100) chatMessages.removeAt(0)
                                if (currentTab == 0 && selectedStream?.id == streamId) render()
                            }
                        }
                        "warning", "error" -> runOnUiThread {
                            chatSocketState = L10n.serverError(lang, data.optString("message", tr("chat.unavailable")))
                            setStatus(chatSocketState)
                            if (currentTab == 0) render()
                        }
                    }
                } catch (_: Exception) { }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                runOnUiThread {
                    chatSocketState = if (code == 4403) L10n.serverError(lang, reason.ifBlank { tr("chat.roomUnavailable") }) else tr("chat.closed")
                    setStatus(chatSocketState)
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                runOnUiThread {
                    chatSocketState = tr("chat.connectFailed", t.message ?: tr("chat.networkError"))
                    setStatus(chatSocketState)
                }
            }
        })
        render()
    }

    private fun disconnectChat() {
        chatSocket?.close(1000, "user left room")
        chatSocket = null
        chatSocketState = tr("chat.disconnected")
        chatMessages.clear()
    }

    private fun sendChat(content: String) {
        val text = content.trim()
        if (text.isBlank()) return
        if (text.length > 500) {
            setStatus(tr("status.chatMaxLength"))
            return
        }
        val socket = chatSocket
        if (socket == null || !socket.send(JSONObject().put("type", "chat").put("content", text).toString())) {
            setStatus(tr("status.chatNotConnected"))
            return
        }
        setStatus(tr("status.chatSent"))
    }

    private fun attachLiveRenderer(parent: LinearLayout, heightDp: Int, stream: LiveStream) {
        val view = SurfaceViewRenderer(this).apply {
            layoutParams = LinearLayout.LayoutParams(-1, dp(heightDp)).apply { topMargin = dp(10) }
            setBackgroundColor(Color.BLACK)
            // 同上：WHEP 已收到首帧但画面仍黑时，多为 SurfaceView 层级被窗口遮住。
            setZOrderOnTop(true)
        }
        val currentToken = token
        if (currentToken.isNullOrBlank() || stream.whepPath.isBlank()) {
            parent.addView(view)
            setStatus(tr("status.needWhepPath"))
            return
        }
        if (livePlaybackClient == null || livePlaybackStreamId != stream.id) {
            stopLivePlayback()
            livePlaybackStreamId = stream.id
            liveRenderer = view
            val client = WebRtcPlaybackClient(
                this,
                apiBase.trimEnd('/') + stream.whepPath,
                currentToken,
                lang
            ) { message -> runOnUiThread { setStatus(message) } }
            livePlaybackClient = client
            // init 必须在 addView 之前，确保 Surface 创建后 EGL 渲染链已就绪。
            client.attachRenderer(view)
            parent.addView(view)
            client.start()
        } else {
            liveRenderer = view
            livePlaybackClient?.attachRenderer(view)
            parent.addView(view)
        }
    }

    private fun stopLivePlayback() {
        // Remove the renderer from the window before WebRtcPlaybackClient releases it.
        liveRenderer?.let { view -> (view.parent as? ViewGroup)?.removeView(view) }
        livePlaybackClient?.close()
        livePlaybackClient = null
        livePlaybackStreamId = 0L
        liveRenderer = null
    }

    /** Media3 is retained only for MP4 recordings. Live streams use WHEP/WebRTC. */
    private fun playMedia(url: String) {
        if (url.isBlank()) {
            setStatus(tr("status.recordingUrlEmpty"))
            return
        }
        try {
            player?.release()
            val exo = ExoPlayer.Builder(this).build()
            player = exo
            exo.setMediaItem(MediaItem.fromUri(Uri.parse(url)))
            exo.prepare()
            exo.playWhenReady = true
            playerView?.player = exo
            setStatus(tr("status.recordingLoading"))
        } catch (e: Exception) {
            setStatus(tr("status.recordingPlayerFailed", e.message ?: ""))
        }
    }

    private fun attachPlayer(parent: LinearLayout, heightDp: Int) {
        val view = PlayerView(this).apply {
            layoutParams = LinearLayout.LayoutParams(-1, dp(heightDp)).apply { topMargin = dp(10) }
            useController = true
            setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
            setBackgroundColor(Color.BLACK)
        }
        playerView?.player = null
        playerView = view
        view.player = player
        parent.addView(view)
    }

    private fun stopPlayback() {
        stopLivePlayback()
        player?.stop()
        player?.release()
        player = null
        playerView?.player = null
        playerView = null
    }

    // ---------------------------------------------------------------------
    // HTTP plumbing
    // ---------------------------------------------------------------------

    private fun apiRequest(
        method: String,
        path: String,
        payload: JSONObject?,
        authenticated: Boolean,
        readTimeoutMs: Int = 12000,
        done: (ApiResult) -> Unit
    ) {
        val base = apiBase.trimEnd('/')
        val bearer = if (authenticated) token else null
        executor.execute {
            var result = ApiResult(0, obj = JSONObject().put("error", tr("status.networkFailed")))
            var connection: HttpURLConnection? = null
            try {
                connection = URL(base + path).openConnection() as HttpURLConnection
                connection.requestMethod = method
                connection.connectTimeout = 10000
                connection.readTimeout = readTimeoutMs
                connection.setRequestProperty("Accept", "application/json")
                if (!bearer.isNullOrBlank()) connection.setRequestProperty("Authorization", "Bearer $bearer")
                if (payload != null) {
                    connection.doOutput = true
                    connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    connection.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
                }
                val code = connection.responseCode
                val responseText = (if (code in 200..299) connection.inputStream else connection.errorStream)
                    ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
                var obj: JSONObject? = null
                var array: JSONArray? = null
                try {
                    when (val parsed = org.json.JSONTokener(responseText).nextValue()) {
                        is JSONObject -> obj = parsed
                        is JSONArray -> array = parsed
                    }
                } catch (_: Exception) { }
                result = ApiResult(code, obj, array, responseText)
            } catch (e: Exception) {
                result = ApiResult(0, obj = JSONObject().put("error", tr("status.connectionFailed", e.message ?: tr("status.checkServerAddress"))))
            } finally {
                connection?.disconnect()
            }
            runOnUiThread { done(result) }
        }
    }

    private fun handleApiError(result: ApiResult, fallback: String, showToast: Boolean = true) {
        if (result.code == 401) {
            token = null
            currentUsername = ""
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove("token").remove("username").apply()
        }
        // Keep the raw server text for the ban check, but show the English mapping when
        // the UI language is English (the backend itself stays Chinese in v0.7.7).
        val rawError = result.obj?.optString("error")?.takeIf { it.isNotBlank() }
            ?: result.obj?.optString("message")?.takeIf { it.isNotBlank() }
            ?: tr("status.httpError", fallback, result.code)
        val error = L10n.serverError(lang, rawError)
        if (result.code == 403 && rawError.contains(L10n.BANNED_MARKER)) {
            bannedNotice = true
            token = null
            currentUsername = ""
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove("token").remove("username").apply()
            disconnectChat()
            setStatus(tr("status.banned"))
            render()
        } else {
            setStatus(error)
            if (showToast) Toast.makeText(this, error, Toast.LENGTH_LONG).show()
        }
    }

    private fun JSONObject.toChatMessage(): ChatMessage = ChatMessage(
        id = optString("id", System.nanoTime().toString()),
        username = optString("username", tr("chat.user")),
        content = optString("content", ""),
        createdAt = optString("createdAt", "")
    )

    private fun setStatus(message: String) {
        statusMessage = message
        if (::statusView.isInitialized) statusView.text = message
    }

    // ---------------------------------------------------------------------
    // View factories / theme helpers
    // ---------------------------------------------------------------------

    private fun panel(color: Int = PANEL): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(16), dp(16), dp(16), dp(16))
        background = if (color == PANEL) gradientDrawable(intArrayOf(PANEL, PANEL_ALT), 20, stroke = true) else rounded(color, 20, stroke = true)
        elevation = dp(4).toFloat()
    }

    private fun heading(text: String): TextView = TextView(this).apply {
        this.text = text
        textSize = 18f
        setTextColor(TEXT)
        setTypeface(typeface, Typeface.BOLD)
        setPadding(0, 0, 0, dp(6))
        letterSpacing = 0.02f
    }

    private fun body(text: String): TextView = TextView(this).apply {
        this.text = text
        textSize = 12f
        setTextColor(MUTED)
        setPadding(0, dp(3), 0, dp(6))
        setLineSpacing(0f, 1.2f)
    }

    private fun sectionLabel(text: String): TextView = TextView(this).apply {
        this.text = text
        textSize = 11.5f
        setTextColor(0xFFCFC6FF.toInt())
        setTypeface(typeface, Typeface.BOLD)
        setPadding(0, dp(12), 0, dp(4))
        letterSpacing = 0.03f
    }

    private fun infoRow(label: String, value: String): LinearLayout = horizontal().apply {
        setPadding(0, dp(4), 0, dp(4))
        addView(TextView(this@MainActivity).apply {
            text = label
            textSize = 12f
            setTextColor(MUTED)
        }, LinearLayout.LayoutParams(dp(74), -2))
        addView(TextView(this@MainActivity).apply {
            text = value
            textSize = 12.5f
            setTextColor(TEXT)
        }, LinearLayout.LayoutParams(0, -2, 1f))
    }

    private fun input(hintText: String, secret: Boolean = false): EditText = EditText(this).apply {
        hint = hintText
        textSize = 14f
        setTextColor(TEXT)
        setHintTextColor(MUTED)
        setPadding(dp(14), 0, dp(14), 0)
        minHeight = dp(50)
        background = rounded(PANEL_ALT, 14, stroke = true)
        inputType = if (secret) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_CLASS_TEXT
        if (secret) setAutofillHints("password")
    }

    private fun actionButton(text: String, primary: Boolean = false, action: () -> Unit): Button = Button(this).apply {
        this.text = text
        textSize = 12.5f
        isAllCaps = false
        stateListAnimator = null
        minHeight = dp(44)
        minimumHeight = dp(44)
        setTextColor(buttonTextColors(primary))
        background = buttonBackground(primary)
        setPadding(dp(12), 0, dp(12), 0)
        setOnClickListener { action() }
    }

    private fun chipButton(text: String, primary: Boolean = false, action: () -> Unit): TextView = TextView(this).apply {
        this.text = text
        textSize = 11.5f
        gravity = Gravity.CENTER
        setTextColor(buttonTextColors(primary))
        setPadding(dp(14), dp(8), dp(14), dp(8))
        background = buttonBackground(primary)
        isClickable = true
        isFocusable = true
        setOnClickListener { action() }
    }

    private fun coverFrame(title: String, coverUrl: String, large: Boolean): FrameLayout {
        val frame = FrameLayout(this).apply {
            background = coverPlaceholder(title)
            clipToOutline = true
            outlineProvider = roundedOutline(16)
        }
        frame.addView(TextView(this).apply {
            text = title.trim().take(1).ifBlank { tr("cover.initialFallback") }
            textSize = if (large) 44f else 22f
            setTextColor(0x59FFFFFF)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
        }, FrameLayout.LayoutParams(-1, -1))
        if (coverUrl.isNotBlank()) {
            val image = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
            frame.addView(image, FrameLayout.LayoutParams(-1, -1))
            CoverLoader.load(coverUrl, image)
        }
        return frame
    }

    private fun coverPlaceholder(title: String): GradientDrawable {
        val palettes = arrayOf(
            intArrayOf(0xFF241B52.toInt(), 0xFF5B3DF5.toInt()),
            intArrayOf(0xFF10314A.toInt(), 0xFF2B7FBF.toInt()),
            intArrayOf(0xFF3A1438.toInt(), 0xFFA24DFF.toInt()),
            intArrayOf(0xFF123B33.toInt(), 0xFF2AA683.toInt()),
            intArrayOf(0xFF40210F.toInt(), 0xFFC97B2C.toInt())
        )
        val palette = palettes[(title.hashCode() and 0x7FFFFFFF) % palettes.size]
        return gradientDrawable(palette, 16)
    }

    private fun roundedOutline(radiusDp: Int): ViewOutlineProvider = object : ViewOutlineProvider() {
        override fun getOutline(view: View, outline: Outline) {
            outline.setRoundRect(0, 0, view.width, view.height, dp(radiusDp).toFloat())
        }
    }

    private fun horizontal(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
    }

    private fun weighted() = LinearLayout.LayoutParams(0, dp(46), 1f).apply {
        marginEnd = dp(6)
    }

    private fun fieldParams() = LinearLayout.LayoutParams(-1, dp(50)).apply {
        topMargin = dp(8)
        bottomMargin = dp(3)
    }

    private fun cardParams() = LinearLayout.LayoutParams(-1, -2).apply {
        bottomMargin = dp(12)
    }

    private fun rounded(color: Int, radiusDp: Int, stroke: Boolean = false): GradientDrawable = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(radiusDp).toFloat()
        if (stroke) setStroke(dp(1), EDGE)
    }

    private fun gradientDrawable(colors: IntArray, radiusDp: Int, stroke: Boolean = false): GradientDrawable =
        GradientDrawable(GradientDrawable.Orientation.TL_BR, colors).apply {
            cornerRadius = dp(radiusDp).toFloat()
            if (stroke) setStroke(dp(1), EDGE)
        }

    private fun buttonTextColors(primary: Boolean): ColorStateList {
        val active = if (primary) 0xFFFFFFFF.toInt() else TEXT
        return ColorStateList(
            arrayOf(
                intArrayOf(-android.R.attr.state_enabled),
                intArrayOf(android.R.attr.state_pressed),
                intArrayOf()
            ),
            intArrayOf(0xFF7E89A3.toInt(), 0xFFFFFFFF.toInt(), active)
        )
    }

    private fun buttonBackground(primary: Boolean): StateListDrawable = StateListDrawable().apply {
        addState(intArrayOf(-android.R.attr.state_enabled), rounded(0xFF232C42.toInt(), 14, stroke = true))
        addState(
            intArrayOf(android.R.attr.state_pressed),
            if (primary) gradientDrawable(intArrayOf(PURPLE, PURPLE_DEEP), 14) else rounded(0xFF263354.toInt(), 14, stroke = true)
        )
        addState(
            intArrayOf(),
            if (primary) gradientDrawable(intArrayOf(PURPLE_DEEP, PURPLE), 14) else rounded(PANEL_ALT, 14, stroke = true)
        )
    }

    /** Quality (resolution / fps) toggle: gradient when selected, pressed feedback otherwise. */
    private fun selectionButtonBackground(selected: Boolean): StateListDrawable = StateListDrawable().apply {
        addState(
            intArrayOf(android.R.attr.state_pressed),
            if (selected) gradientDrawable(intArrayOf(PURPLE, PURPLE_DEEP), 12) else rounded(0xFF263354.toInt(), 12, stroke = true)
        )
        addState(
            intArrayOf(),
            if (selected) gradientDrawable(intArrayOf(PURPLE_DEEP, PURPLE), 12) else rounded(PANEL_ALT, 12, stroke = true)
        )
    }

    private fun navItemBackground(selected: Boolean): StateListDrawable = StateListDrawable().apply {
        if (selected) {
            addState(intArrayOf(), gradientDrawable(intArrayOf(PURPLE_DEEP, PURPLE), 18))
        } else {
            addState(intArrayOf(android.R.attr.state_pressed), rounded(0x1FFFFFFF, 18))
            addState(intArrayOf(), rounded(0x00000000, 18))
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun formatBytes(bytes: Long): String = when {
        bytes >= 1024L * 1024 * 1024 -> String.format("%.2f GB", bytes / (1024.0 * 1024 * 1024))
        bytes >= 1024L * 1024 -> String.format("%.1f MB", bytes / (1024.0 * 1024))
        bytes >= 1024L -> String.format("%.1f KB", bytes / 1024.0)
        else -> "$bytes B"
    }

    @Suppress("DEPRECATION")
    private fun registerStatusReceiver(filter: IntentFilter) {
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(statusReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        else registerReceiver(statusReceiver, filter)
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        try { unregisterReceiver(statusReceiver) } catch (_: Exception) { }
        disconnectChat()
        playerView?.player = null
        player?.release()
        player = null
        stopLivePlayback()
        cameraPreviewRenderer?.let { preview ->
            (preview.parent as? ViewGroup)?.removeView(preview)
            CameraPreviewBridge.detach(preview)
        }
        cameraPreviewRenderer = null
        CameraPreviewBridge.onStatus = null
        live2DViewer?.destroy()
        live2DViewer = null
        httpClient.dispatcher.executorService.shutdown()
        executor.shutdown()
        super.onDestroy()
    }
}

private fun JSONObject.optBooleanCompat(name: String): Boolean = when (val value = opt(name)) {
    is Boolean -> value
    is Number -> value.toInt() != 0
    is String -> value.equals("true", ignoreCase = true) || value == "1"
    else -> false
}

private class SimpleTextWatcher(private val onChanged: (String) -> Unit) : TextWatcher {
    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { onChanged(s?.toString().orEmpty()) }
    override fun afterTextChanged(s: Editable?) = Unit
}
