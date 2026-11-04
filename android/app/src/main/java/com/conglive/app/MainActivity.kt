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
    private var draftTitle: String = "我的屏幕直播"
    private var chatMessages: MutableList<ChatMessage> = mutableListOf()
    private var chatSocket: WebSocket? = null
    private var player: ExoPlayer? = null
    private var playerView: PlayerView? = null
    private var livePlaybackClient: WebRtcPlaybackClient? = null
    private var livePlaybackStreamId: Long = 0L
    private var liveRenderer: SurfaceViewRenderer? = null
    private var bannedNotice = false
    private var liveStatusMessage = "尚未开播"
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
    private var live2DStatusMessage = "等待模型：贴入 .model3.json 地址后点击「加载模型」。"

    private val capture = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            startWhipService(result.data, useCamera = false)
        } else setStatus("已取消系统录屏授权")
    }

    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) beginSelectedCapture() else setStatus("未授予麦克风权限，无法开始直播。")
    }

    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startCameraStreaming() else setStatus("未授予摄像头权限，无法进行摄像头直播。")
    }

    /**
     * ACTION_OPEN_DOCUMENT：让系统相册/文件选择器返回图片 Uri，不需要任何存储权限，
     * 也不需要向用户申请 READ_MEDIA_IMAGES。
     */
    private val coverPicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val streamId = pendingCoverStreamId
        pendingCoverStreamId = 0L
        if (uri == null) {
            setStatus("已取消选择封面图片")
        } else if (streamId <= 0L) {
            setStatus("请先创建直播间，再设置封面")
        } else {
            setStatus("正在压缩封面图片…")
            executor.execute {
                val prepared = try {
                    CoverSupport.prepare(contentResolver, uri)
                } catch (_: Exception) {
                    null
                }
                runOnUiThread {
                    if (prepared == null) {
                        setStatus("封面读取失败，或图片无法压缩到 2MB 以内。请换一张图片重试。")
                    } else {
                        uploadCover(streamId, prepared)
                    }
                }
            }
        }
    }

    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val message = intent?.getStringExtra(ScreenStreamService.EXTRA_MESSAGE) ?: "直播状态已更新"
            val wasCameraStreamingActive = cameraStreamingActive
            liveStatusMessage = message
            if (message.contains("摄像头采集已启动")) cameraStreamingActive = true
            if (message.contains("已切换到前置摄像头")) cameraFacingFront = true
            if (message.contains("已切换到后置摄像头")) cameraFacingFront = false
            if (message.contains("推流成功") || message.contains("直播中") || message.contains("正在连接 WebRTC")) broadcastActive = true
            if (message.contains("已停止") || message.contains("服务已关闭") || message.contains("直播失败") || message.contains("开播失败") || message.contains("连接失败")) {
                cameraStreamingActive = false
                broadcastActive = false
            }
            setStatus(message)
            when {
                message.contains("推流成功") -> {
                    liveStatusMessage = "推流连接已建立，正在确认服务器开播状态…"
                    setStatus(liveStatusMessage)
                    refreshStreams()
                    confirmCreatedStreamLive()
                }
                message.contains("直播中") -> {
                    refreshStreams()
                }
                message.contains("已停止") || message.contains("连接失败") ||
                    message.contains("鉴权失败") || message.contains("启动直播失败") ||
                    message.contains("超时") -> {
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

        buildShell()
        registerStatusReceiver(IntentFilter(ScreenStreamService.ACTION_STATUS))
        render()
        if (!token.isNullOrBlank()) {
            refreshStreams()
            loadMyStreams()
        }
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
            text = "葱直播"
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
            text = "CONGLIVE  ·  ANDROID"
            textSize = 9.5f
            setTextColor(MUTED)
            letterSpacing = 0.18f
        })
        header.addView(brand, LinearLayout.LayoutParams(0, -2, 1f))
        header.addView(TextView(this).apply {
            text = "v0.7.6"
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
            text = "连接服务器后即可观看和开播"
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
            "🏠" to "大厅",
            "🎥" to "开播",
            "🎞" to "录像",
            "👤" to "我的",
            "✨" to "看板娘"
        ).forEachIndexed { index, (icon, label) ->
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
                text = label
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
        card.addView(heading("欢迎来到葱直播"))
        card.addView(body("登录后可以发送实时弹幕、创建直播和查看自己的录像。"))
        val userInput = input("用户名（3–40 位）")
        val passInput = input("密码（至少 8 位）", true)
        card.addView(userInput, fieldParams())
        card.addView(passInput, fieldParams())
        val actions = horizontal()
        actions.addView(actionButton("登录", true) {
            val u = userInput.text.toString().trim()
            val p = passInput.text.toString()
            auth("login", u, p)
        }, weighted())
        actions.addView(actionButton("注册", false) {
            auth("register", userInput.text.toString().trim(), passInput.text.toString())
        }, weighted())
        card.addView(actions)
        card.addView(body("首次使用或更换 VPS 时，请先设置服务器 API 地址。真机不能使用模拟器默认地址 10.0.2.2。"))
        val serverInput = input("服务器 API 根地址（例如 http://VPS公网IP:3000）", false).apply { setText(apiBase) }
        card.addView(serverInput, fieldParams())
        card.addView(actionButton("保存地址并检查服务器", false) {
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
        row.addView(heading("直播大厅"), LinearLayout.LayoutParams(0, -2, 1f))
        row.addView(actionButton("刷新", false) { refreshStreams() })
        top.addView(row)
        top.addView(body("选择正在直播的房间，观看画面并加入实时弹幕。"))
        if (streams.isEmpty()) {
            top.addView(body("暂时没有直播。你可以切换到「开播」创建自己的直播。"))
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
                detail.addView(body("主播：${stream.username}"))
                line.addView(detail, LinearLayout.LayoutParams(0, -2, 1f))
                line.addView(TextView(this).apply {
                    text = if (stream.isLive) "● 直播中" else "○ 未开播"
                    textSize = 11f
                    setTextColor(if (stream.isLive) GREEN else MUTED)
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(9), dp(3), dp(9), dp(3))
                    background = rounded(if (stream.isLive) 0x2254E0A8 else 0x11FFFFFF, 10)
                })
                item.addView(line)
                item.addView(actionButton(if (selectedStream?.id == stream.id) "当前房间" else "观看 / 加入弹幕", true) {
                    if (!stream.isLive) {
                        setStatus("这场直播当前未开播")
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
            playback.addView(heading("正在观看：${stream.title}"))
            playback.addView(body("主播：${stream.username}"))
            attachLiveRenderer(playback, 210, stream)
            val chatCard = panel()
            chatCard.addView(heading("实时弹幕"))
            chatCard.addView(body(if (token.isNullOrBlank()) "请登录后发送评论。" else "连接状态：${chatSocketState}"))
            val messagesBox = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(10), dp(8), dp(10), dp(8))
                background = rounded(PANEL_ALT, 14, stroke = true)
            }
            if (chatMessages.isEmpty()) messagesBox.addView(body("还没有评论，发出第一条弹幕吧。"))
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
            val chatInput = input("输入弹幕评论，最多 500 字").apply { filters = arrayOf(InputFilter.LengthFilter(500)) }
            val send = actionButton("发送", true) { sendChat(chatInput.text.toString()); chatInput.setText("") }
            val chatRow = horizontal()
            chatRow.addView(chatInput, LinearLayout.LayoutParams(0, dp(50), 1f).apply { marginEnd = dp(8) })
            chatRow.addView(send)
            chatCard.addView(chatRow)
            chatCard.addView(actionButton("离开直播间", false) {
                disconnectChat()
                selectedStream = null
                stopPlayback()
                render()
            })
            content.addView(playback, cardParams())
            content.addView(chatCard, cardParams())
        }
    }

    private var chatSocketState = "未连接"

    // ---------------------------------------------------------------------
    // Broadcast
    // ---------------------------------------------------------------------

    private fun renderBroadcast() {
        val card = panel()
        card.addView(heading("创建直播"))
        card.addView(body("选择屏幕或摄像头作为唯一视频源，通过 WebRTC/WHIP 低延迟推流。"))
        val statusLine = body("当前状态：$liveStatusMessage")
        card.addView(statusLine)
        val sourceRow = horizontal()
        sourceRow.addView(actionButton("屏幕直播", videoSourceMode == "screen") {
            if (broadcastActive) setStatus("请先停止当前直播，再切换视频源") else {
                videoSourceMode = "screen"
                draftTitle = "我的屏幕直播"
                render()
            }
        }.apply { isEnabled = !broadcastActive }, weighted())
        sourceRow.addView(actionButton("摄像头直播", videoSourceMode == "camera") {
            if (broadcastActive) setStatus("请先停止当前直播，再切换视频源") else {
                videoSourceMode = "camera"
                draftTitle = "我的摄像头直播"
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
        card.addView(sectionLabel("画质设置（默认 720p / 24fps）"))
        val resolutionRow = horizontal()
        VideoSettings.RESOLUTIONS.forEach { option ->
            val button = actionButton(option.label, false) {
                if (videoResolution.id != option.id) {
                    videoResolution = option
                    persistVideoSettings()
                    paintQualitySelection()
                    setStatus("分辨率已保存：${option.label}（${option.width}×${option.height}，${bitrateLabel(option.bitrateBps)}），下次开播生效")
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
                    setStatus("帧率已保存：$fps fps，下次开播生效")
                }
            }
            fpsButtons[fps] = button
            fpsRow.addView(button, weighted())
        }
        card.addView(fpsRow)
        paintQualitySelection()
        card.addView(qualitySummary)

        if (videoSourceMode == "camera") {
            card.addView(body("摄像头默认关闭。开始直播时才请求摄像头权限；可在直播中切换前置/后置摄像头。"))
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
                if (!CameraPreviewBridge.attach(preview)) setStatus("摄像头预览暂不可用，但推流状态会继续显示")
                card.addView(preview)
                card.addView(actionButton("切换前置 / 后置摄像头", false) {
                    val switchIntent = Intent(this, ScreenStreamService::class.java).setAction(ScreenStreamService.ACTION_SWITCH_CAMERA)
                    startService(switchIntent)
                })
            }
        } else {
            card.addView(body("开始时会弹出 Android 系统屏幕共享授权。"))
        }
        val titleInput = input("直播标题").apply { setText(draftTitle) }
        titleInput.addTextChangedListener(SimpleTextWatcher { draftTitle = it })
        card.addView(titleInput, fieldParams())
        card.addView(actionButton("创建直播并获取推流地址", true) { createLive() })
        if (createdPublishPath.isNotBlank()) {
            card.addView(infoRow("传输协议", "WebRTC / WHIP"))
            card.addView(infoRow("视频源", if (videoSourceMode == "camera") "摄像头" else "屏幕"))
            card.addView(infoRow("画质", "${videoResolution.label} · ${bitrateLabel(videoResolution.bitrateBps)} · $videoFps fps"))
            card.addView(infoRow("发布接口", createdPublishPath))
            if (createdStreamId > 0L) {
                card.addView(sectionLabel("直播封面（可选）"))
                card.addView(
                    coverFrame(draftTitle, createdCoverUrl, large = true),
                    LinearLayout.LayoutParams(-1, dp(164)).apply { topMargin = dp(8) }
                )
                card.addView(actionButton(if (coverUploading) "正在上传封面…" else "从相册选择封面", false) {
                    pickCover(createdStreamId)
                }.apply { isEnabled = !coverUploading })
            }
            card.addView(actionButton(if (videoSourceMode == "camera") "开始摄像头直播" else "开始屏幕直播", true) { startCapture() })
        } else {
            card.addView(body("创建直播后会显示开播按钮和封面设置。"))
        }
        card.addView(actionButton("停止直播", false) {
            liveStatusMessage = "正在停止直播…"
            startService(Intent(this, ScreenStreamService::class.java).setAction(ScreenStreamService.ACTION_STOP))
            setStatus(liveStatusMessage)
            render()
        })
        content.addView(card, cardParams())

        val own = panel()
        own.addView(heading("我的直播记录"))
        if (myStreams.length() == 0) own.addView(body("还没有创建过直播。"))
        for (i in 0 until myStreams.length()) {
            val item = myStreams.optJSONObject(i) ?: continue
            val streamId = item.optLong("id")
            val title = item.optString("title", "未命名直播")
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
            detail.addView(body("${if (isLive) "● 直播中" else "○ 未开播"}  ·  ${if (coverUrl.isNotBlank()) "已有封面" else "暂无封面"}"))
            detail.addView(chipButton(if (coverUploading) "正在上传…" else "从相册选封面", false) {
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
        row.addView(heading("我的录像"), LinearLayout.LayoutParams(0, -2, 1f))
        row.addView(actionButton("刷新", false) { loadRecordings() })
        card.addView(row)
        card.addView(body("这里只显示你自己直播产生的录像。点击即可在线回放。"))
        if (token.isNullOrBlank()) {
            card.addView(body("请先登录后查看个人录像。"))
        } else if (recordings.isEmpty()) {
            card.addView(body("暂时没有找到录像。直播结束并完成录像写入后，可点击刷新。"))
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
                item.addView(actionButton(if (selectedRecording?.id == recording.id) "正在播放" else "在线回放", true) {
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
            playCard.addView(heading("录像回放：${recording.name}"))
            attachPlayer(playCard, 220)
            content.addView(playCard, cardParams())
        }
    }

    private fun renderProfile() {
        val card = panel()
        card.addView(heading("我的账户"))
        if (token.isNullOrBlank()) {
            card.addView(body("登录后可管理自己的直播和录像。"))
        } else {
            card.addView(TextView(this).apply {
                text = "👤  $currentUsername"
                textSize = 18f
                setTextColor(TEXT)
                setTypeface(typeface, Typeface.BOLD)
                setPadding(0, dp(2), 0, dp(4))
            })
            card.addView(body(if (bannedNotice) "账号当前不可用，请联系管理员。" else "账号状态：正常登录"))
            card.addView(actionButton("检查账号状态 / 刷新我的直播", true) { loadMyStreams() })
            card.addView(actionButton("退出登录", false) {
                disconnectChat()
                token = null
                currentUsername = ""
                bannedNotice = false
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove("token").remove("username").apply()
                setStatus("已退出登录。正在进行的系统录屏服务不会被自动停止。")
                render()
            })
        }
        content.addView(card, cardParams())

        val settings = panel()
        settings.addView(heading("服务器设置"))
        settings.addView(body("填写你的葱直播 API 根地址，例如 https://live.example.com 或 http://服务器IP:3000。"))
        apiAddressInput = input("API 地址", false).apply { setText(apiBase) }
        settings.addView(apiAddressInput, fieldParams())
        settings.addView(actionButton("保存服务器地址并检查连接", true) {
            saveAndCheckServer(apiAddressInput.text.toString())
        })
        content.addView(settings, cardParams())
    }

    // ---------------------------------------------------------------------
    // Live2D 看板娘 (UI only, never composited into WebRTC)
    // ---------------------------------------------------------------------

    private fun renderLive2D() {
        val card = panel()
        card.addView(heading("Live2D 看板娘"))
        card.addView(body("只作为 App 界面里的看板娘显示，不会合成进直播画面，也不会进入 WebRTC 推流。"))
        card.addView(body("输入模型 .model3.json 的公网地址；模型资源需要允许跨域访问（CORS）。运行库来自 CDN，App 不内置模型。"))

        val viewer = live2DViewer ?: Live2DViewer(
            this,
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

        val urlInput = input("模型地址，例如 https://example.com/model.model3.json", false)
        if (live2DModelUrl.isNotBlank()) urlInput.setText(live2DModelUrl)
        card.addView(urlInput, fieldParams())
        val actions = horizontal()
        actions.addView(actionButton("加载模型", true) {
            val url = urlInput.text.toString().trim()
            live2DModelUrl = url
            viewer.loadModel(url)
        }, weighted())
        actions.addView(actionButton("显示", false) { viewer.showModel() }, weighted())
        actions.addView(actionButton("隐藏", false) { viewer.hideModel() }, weighted())
        card.addView(actions)
        val state = body(live2DStatusMessage)
        live2DStateView = state
        card.addView(state)
        card.addView(actionButton("重新加载看板娘页面", false) { viewer.reload() })
        content.addView(card, cardParams())
    }

    // ---------------------------------------------------------------------
    // Cover upload helpers
    // ---------------------------------------------------------------------

    private fun pickCover(streamId: Long) {
        if (token.isNullOrBlank()) {
            setStatus("请先登录后再设置封面")
            return
        }
        if (streamId <= 0L) {
            setStatus("请先创建直播间，再设置封面")
            return
        }
        if (coverUploading) {
            setStatus("上一张封面还在上传，请稍候")
            return
        }
        pendingCoverStreamId = streamId
        setStatus("请选择一张图片作为直播封面")
        coverPicker.launch(arrayOf("image/*"))
    }

    private fun uploadCover(streamId: Long, prepared: CoverSupport.PreparedCover) {
        coverUploading = true
        setStatus("正在上传封面（${prepared.sizeLabel}）…")
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
                setStatus("封面已更新")
                loadMyStreams()
                refreshStreams()
                render()
            } else {
                if (result.code == 413) setStatus("封面图片超过 2MB 限制，请换一张更小的图片")
                else handleApiError(result, "封面上传失败")
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
            setStatus("服务器地址必须以 http:// 或 https:// 开头")
            return
        }
        if (value.endsWith("/api", ignoreCase = true)) {
            setStatus("地址不要带 /api 后缀，例如填写 http://服务器IP:3000")
            return
        }
        apiBase = value
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("api", apiBase).apply()
        setStatus("正在检查服务器：$apiBase")
        apiRequest("GET", "/api/health", null, false) { result ->
            if (result.code == 200 && result.obj?.optBoolean("ok") == true) {
                val dbStatus = result.obj.optString("database", "unknown")
                setStatus("服务器连接成功，API 正常，数据库：$dbStatus。现在可以注册或登录。")
                refreshStreams()
            } else {
                val reason = result.obj?.optString("error")?.takeIf { it.isNotBlank() }
                    ?: result.raw.take(180).ifBlank { "HTTP ${result.code}" }
                setStatus("服务器地址已保存，但健康检查失败：$reason。请检查公网端口、防火墙和服务状态。")
            }
        }
    }

    private fun auth(path: String, username: String, password: String) {
        if (username.isBlank() || password.isBlank()) {
            setStatus("请填写用户名和密码")
            return
        }
        val usernameLength = username.codePointCount(0, username.length)
        if (usernameLength !in 3..40 || !username.matches(Regex("[\\p{L}\\p{N}_]+"))) {
            setStatus("用户名需为3-40位中文、字母、数字或下划线")
            return
        }
        if (password.length !in 8..128) {
            setStatus("密码长度需为8-128个字符")
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
                    setStatus("登录成功，欢迎回来 $currentUsername")
                    refreshStreams()
                    loadMyStreams()
                    loadRecordings()
                } else {
                    setStatus("注册成功，请使用新账号登录")
                }
                render()
            } else handleApiError(result, "认证失败")
        }
    }

    private fun createLive() {
        if (token.isNullOrBlank()) {
            setStatus("请先登录")
            currentTab = 3
            render()
            return
        }
        apiRequest("POST", "/api/streams", JSONObject().put("title", draftTitle), true) { result ->
            if (result.code in 200..299) {
                createdPublishPath = result.obj?.optString("publishPath").orEmpty()
                createdStreamId = result.obj?.optLong("id") ?: 0L
                createdCoverUrl = ""
                liveStatusMessage = "直播间已创建，等待开始屏幕共享"
                setStatus("WebRTC 直播间创建成功。请授权屏幕共享后开播。")
                loadMyStreams()
                render()
            } else handleApiError(result, "创建直播失败")
        }
    }

    private fun startCapture() {
        if (token.isNullOrBlank()) {
            setStatus("请先登录后创建直播")
            return
        }
        if (!createdPublishPath.startsWith("/api/streams/") || token.isNullOrBlank()) {
            setStatus("请先登录并创建有效的 WebRTC 直播间")
            return
        }
        liveStatusMessage = if (videoSourceMode == "camera") "等待摄像头权限…" else "等待系统录屏授权…"
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
            setStatus("请先登录并创建直播间")
            return
        }
        val service = Intent(this, ScreenStreamService::class.java).apply {
            action = ScreenStreamService.ACTION_START
            putExtra(ScreenStreamService.EXTRA_CAMERA_MODE, true)
            putExtra(ScreenStreamService.EXTRA_FRONT_CAMERA, cameraFacingFront)
            putExtra(ScreenStreamService.EXTRA_SIGNAL_URL, apiBase.trimEnd('/') + createdPublishPath)
            putExtra(ScreenStreamService.EXTRA_AUTH_TOKEN, token.orEmpty())
            putVideoExtras(this)
        }
        ContextCompat.startForegroundService(this, service)
        cameraStreamingActive = true
        broadcastActive = true
        liveStatusMessage = "正在打开摄像头并连接 WebRTC…"
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
            putVideoExtras(this)
        }
        ContextCompat.startForegroundService(this, service)
        cameraStreamingActive = false
        broadcastActive = true
        liveStatusMessage = "正在申请屏幕共享并连接推流服务器…"
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
        return "当前：${resolution.label} · ${resolution.width}×${resolution.height} · ${bitrateLabel(resolution.bitrateBps)} · $videoFps fps\n" +
            "屏幕直播按竖屏 ${resolution.height}×${resolution.width} 采集；摄像头直播按横屏 ${resolution.width}×${resolution.height} 采集。"
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
                        title = item.optString("title", "未命名直播"),
                        username = item.optString("username", "用户"),
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
                handleApiError(result, "读取直播列表失败", false)
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
                            if (item.optBooleanCompat("is_live")) liveStatusMessage = "直播中 · 服务器已确认推流成功"
                            val serverCover = myStreamCoverUrl(createdStreamId, item)
                            if (serverCover.isNotBlank()) createdCoverUrl = serverCover
                            break
                        }
                    }
                }
                if (currentTab == 1) render()
            } else handleApiError(result, "读取个人直播失败")
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
                    liveStatusMessage = "直播中 · 服务器已确认推流成功"
                    setStatus(liveStatusMessage)
                    refreshStreams()
                } else if (found && attempt < 12) {
                    liveStatusMessage = "推流连接已建立，等待服务器确认（${attempt + 1}/12）…"
                    setStatus(liveStatusMessage)
                    mainHandler.postDelayed({ confirmCreatedStreamLive(attempt + 1) }, 1500L)
                } else if (found) {
                    liveStatusMessage = "推流已连接，但服务器尚未确认开播。请检查 SRS HTTP 回调和服务器日志。"
                    setStatus(liveStatusMessage)
                } else {
                    liveStatusMessage = "找不到当前直播记录，请刷新或重新创建直播。"
                    setStatus(liveStatusMessage)
                }
                if (currentTab == 1) render()
            } else {
                if (attempt < 12) mainHandler.postDelayed({ confirmCreatedStreamLive(attempt + 1) }, 1500L)
                else setStatus("读取服务器直播状态失败（HTTP ${result.code}）")
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
            } else handleApiError(result, "读取录像失败")
        }
    }

    // ---------------------------------------------------------------------
    // Chat / playback (unchanged behaviour)
    // ---------------------------------------------------------------------

    private fun connectChat(streamId: Long) {
        val savedToken = token
        if (savedToken.isNullOrBlank()) {
            setStatus("登录后才能加入弹幕")
            return
        }
        disconnectChat()
        chatMessages.clear()
        chatSocketState = "正在连接…"
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
                                chatSocketState = "已连接"
                                setStatus("弹幕已连接：${selectedStream?.title ?: "直播间"}")
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
                            chatSocketState = data.optString("message", "弹幕暂不可用")
                            setStatus(chatSocketState)
                            if (currentTab == 0) render()
                        }
                    }
                } catch (_: Exception) { }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                runOnUiThread {
                    chatSocketState = if (code == 4403) reason.ifBlank { "直播间或账号不可用" } else "连接已关闭"
                    setStatus(chatSocketState)
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                runOnUiThread {
                    chatSocketState = "弹幕连接失败：${t.message ?: "网络错误"}"
                    setStatus(chatSocketState)
                }
            }
        })
        render()
    }

    private fun disconnectChat() {
        chatSocket?.close(1000, "user left room")
        chatSocket = null
        chatSocketState = "未连接"
        chatMessages.clear()
    }

    private fun sendChat(content: String) {
        val text = content.trim()
        if (text.isBlank()) return
        if (text.length > 500) {
            setStatus("弹幕最多 500 个字符")
            return
        }
        val socket = chatSocket
        if (socket == null || !socket.send(JSONObject().put("type", "chat").put("content", text).toString())) {
            setStatus("弹幕尚未连接，请重新加入直播间")
            return
        }
        setStatus("弹幕已发送")
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
            setStatus("需要登录并获取有效的 WHEP 播放路径")
            return
        }
        if (livePlaybackClient == null || livePlaybackStreamId != stream.id) {
            stopLivePlayback()
            livePlaybackStreamId = stream.id
            liveRenderer = view
            val client = WebRtcPlaybackClient(
                this,
                apiBase.trimEnd('/') + stream.whepPath,
                currentToken
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
            setStatus("录像播放地址为空")
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
            setStatus("正在加载录像…")
        } catch (e: Exception) {
            setStatus("录像播放器启动失败：${e.message}")
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
            var result = ApiResult(0, obj = JSONObject().put("error", "网络请求失败"))
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
                result = ApiResult(0, obj = JSONObject().put("error", "连接失败：${e.message ?: "请检查服务器地址"}"))
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
        val error = result.obj?.optString("error")?.takeIf { it.isNotBlank() }
            ?: result.obj?.optString("message")?.takeIf { it.isNotBlank() }
            ?: "$fallback（HTTP ${result.code}）"
        if (result.code == 403 && error.contains("封禁")) {
            bannedNotice = true
            token = null
            currentUsername = ""
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove("token").remove("username").apply()
            disconnectChat()
            setStatus("账号已被管理员封禁，登录状态已清除。")
            render()
        } else {
            setStatus(error)
            if (showToast) Toast.makeText(this, error, Toast.LENGTH_LONG).show()
        }
    }

    private fun JSONObject.toChatMessage(): ChatMessage = ChatMessage(
        id = optString("id", System.nanoTime().toString()),
        username = optString("username", "用户"),
        content = optString("content", ""),
        createdAt = optString("createdAt", "")
    )

    private fun setStatus(message: String) {
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
            text = title.trim().take(1).ifBlank { "葱" }
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
