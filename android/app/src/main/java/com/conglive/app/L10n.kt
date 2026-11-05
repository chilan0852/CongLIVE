package com.conglive.app

import android.content.Context
import java.util.Locale

/**
 * In-app language model (v0.7.7).
 *
 * The UI language is independent from the Android system locale: the first launch
 * follows the system language (Chinese locales -> [ZH], everything else -> [EN]) and
 * an explicit choice made in the 我的 / Me tab is persisted in SharedPreferences under
 * [L10n.PREF_KEY] (`app_language`).
 */
enum class Lang(val code: String) {
    ZH("zh"),
    EN("en");

    companion object {
        /** System default: Chinese locales get zh, every other locale gets en. */
        fun fromSystem(): Lang =
            if (Locale.getDefault().language.lowercase(Locale.US).startsWith("zh")) ZH else EN

        /** Unknown / missing codes fall back to the system language. */
        fun fromCode(code: String?): Lang = when (code?.trim()?.lowercase(Locale.US)) {
            ZH.code -> ZH
            EN.code -> EN
            else -> fromSystem()
        }
    }
}

/**
 * Minimal zh/en dictionary plus persistence helpers.
 *
 * Every user-visible string in the Android app goes through [t] so switching the
 * language can rebuild the whole UI without restarting the activity. Dictionary
 * values are `zh to en` pairs; placeholders use [String.format] `%s` markers.
 */
object L10n {
    const val PREFS_NAME = "conglive"
    const val PREF_KEY = "app_language"
    /** Substring of the backend's ban error (backend stays Chinese in v0.7.7). */
    const val BANNED_MARKER = "封禁"

    /** Language currently saved by the user, or the system default when unset. */
    fun read(context: Context): Lang = Lang.fromCode(storedCode(context))

    /** Raw persisted code, `null` when the user has never picked a language. */
    fun storedCode(context: Context): String? =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(PREF_KEY, null)

    /** Persists the language chosen in the 我的 tab. */
    fun write(context: Context, lang: Lang) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(PREF_KEY, lang.code)
            .apply()
    }

    /** Translates [key] for [lang] and formats any `%s` placeholders. */
    fun t(lang: Lang, key: String, vararg args: Any?): String {
        val template = DICT[key]?.let { if (lang == Lang.EN) it.second else it.first } ?: return key
        return if (args.isEmpty()) template else String.format(Locale.US, template, *args)
    }

    /** Maps the backend's Chinese error text for English builds; unknown text is kept. */
    fun serverError(lang: Lang, raw: String): String {
        if (lang != Lang.EN || raw.isBlank()) return raw
        SERVER_ERRORS_EN[raw]?.let { return it }
        var mapped = raw
        for ((chinese, english) in SERVER_ERRORS_EN) {
            if (mapped.contains(chinese)) mapped = mapped.replace(chinese, english)
        }
        return mapped
    }

    /** Common backend errors (backend stays Chinese-only in v0.7.7). */
    private val SERVER_ERRORS_EN: Map<String, String> = linkedMapOf(
        "需要登录" to "Please sign in",
        "登录状态无效或已过期" to "Your session is invalid or has expired",
        "账号已被封禁" to "The account has been banned",
        "账号已被管理员封禁" to "The account has been banned by an administrator",
        "账号不存在" to "The account does not exist",
        "用户不存在" to "The user does not exist",
        "用户名已存在，请直接登录或换一个用户名" to "That username already exists; sign in or pick another one",
        "用户名或密码错误；请确认这是普通用户账号，而不是后台管理员账号" to
            "Incorrect username or password; make sure this is a regular user account, not an admin account",
        "用户名需为3-40位中文、字母、数字或下划线，不能包含空格和特殊符号" to
            "Usernames must be 3-40 characters (Chinese, letters, digits or underscores) with no spaces or symbols",
        "密码长度需为8-128个字符" to "Passwords must be 8-128 characters",
        "请填写用户名和密码" to "Please enter a username and password",
        "注册服务暂时不可用，请检查数据库连接或稍后重试" to
            "Registration is temporarily unavailable; check the database connection or try again later",
        "服务器内部错误" to "Internal server error",
        "请求内容不是有效的 JSON" to "The request body is not valid JSON",
        "请求内容过大" to "The request body is too large",
        "消息处理失败" to "Message processing failed",
        "发送太快了，请稍后再试" to "You are sending too fast; please slow down",
        "直播不存在" to "The stream does not exist",
        "直播不存在或不可用" to "The stream does not exist or is unavailable",
        "直播不存在或已删除" to "The stream does not exist or was deleted",
        "直播已结束" to "The stream has ended",
        "直播间已关闭" to "The room is closed",
        "直播间已删除" to "The room was deleted",
        "直播间已被管理员封禁" to "The room was banned by an administrator",
        "主播尚未开播" to "The host has not gone live yet",
        "直播编号无效" to "Invalid stream id",
        "直播状态由推流服务器自动维护，客户端不能直接修改" to
            "Live status is maintained by the streaming server; clients cannot change it",
        "只能发布自己的直播" to "You can only publish your own streams",
        "只能修改自己的直播封面" to "You can only change the cover of your own stream",
        "封面上传失败，请稍后重试" to "Cover upload failed; please try again later",
        "封面图片不能超过 2MB" to "The cover image must not exceed 2 MB",
        "请提供封面图片数据" to "Please provide the cover image data",
        "图片内容与声明的格式不一致" to "The image content does not match its declared format",
        "图片数据为空或 base64 编码无效" to "The image data is empty or the base64 encoding is invalid",
        "图片格式无效" to "Invalid image format",
        "图片格式无效，仅支持 JPEG/PNG/WebP 的 base64 data URI" to
            "Invalid image format; only JPEG/PNG/WebP base64 data URIs are supported",
        "无法识别的图片，仅支持 JPEG/PNG/WebP" to "Unrecognized image; only JPEG/PNG/WebP are supported",
        "录像不存在" to "The recording does not exist",
        "录像编号无效" to "Invalid recording id",
        "录像路径无效" to "Invalid recording path",
        "录像目录无效" to "Invalid recording directory",
        "只能操作录像文件" to "Only recording files can be operated on",
        "无权播放该录像" to "You are not allowed to play this recording",
        "回放链接已失效，请在后台重新打开录像" to
            "The playback link has expired; reopen the recording from the admin console",
        "不允许访问符号链接" to "Symlinks are not allowed",
        "管理员账号或密码错误" to "Incorrect admin account or password",
        "管理员登录已过期，请重新登录" to "Admin sign-in expired; please sign in again",
        "请先登录管理员后台" to "Please sign in to the admin console first",
        "无管理员权限" to "Administrator permission required",
        "插件不存在" to "The plugin does not exist",
        "插件未启用" to "The plugin is not enabled",
        "WebRTC SDP Offer 无效" to "Invalid WebRTC SDP offer",
        "WebRTC 媒体服务器暂时不可用，请检查 SRS 和 1985 内部端口" to
            "The WebRTC media server is temporarily unavailable; check SRS and internal port 1985"
    )

    /** Every user-visible Android string. Keys are grouped by screen. */
    private val DICT: Map<String, Pair<String, String>> = linkedMapOf(
        // ---------------------------------------------------------------- shell
        "brand.app" to ("葱直播" to "CongLive"),
        "brand.subtitle" to ("CONGLIVE  ·  ANDROID" to "CONGLIVE  ·  ANDROID"),
        "shell.statusReady" to ("连接服务器后即可观看和开播" to "Connect to the server to watch and go live"),
        "nav.lobby" to ("大厅" to "Lobby"),
        "nav.broadcast" to ("开播" to "Go Live"),
        "nav.recordings" to ("录像" to "Recordings"),
        "nav.profile" to ("我的" to "Me"),
        "nav.live2d" to ("看板娘" to "Mascot"),
        // ------------------------------------------------------- status messages
        "status.screenPermissionCancelled" to ("已取消系统录屏授权" to "Screen capture permission cancelled"),
        "status.micDenied" to ("未授予麦克风权限，无法开始直播。" to "Microphone permission denied; cannot start streaming."),
        "status.cameraDenied" to ("未授予摄像头权限，无法进行摄像头直播。" to "Camera permission denied; cannot stream from the camera."),
        "status.updated" to ("直播状态已更新" to "Live status updated"),
        "status.languageChanged" to ("界面语言已切换" to "App language switched"),
        "status.loggedOut" to (
            "已退出登录。正在进行的系统录屏服务不会被自动停止。" to
                "Signed out. An active screen-capture service is not stopped automatically."
            ),
        "status.needLogin" to ("请先登录" to "Please sign in"),
        "status.needLoginCreate" to ("请先登录后创建直播" to "Please sign in before creating a stream"),
        "status.needLoginValidStream" to (
            "请先登录并创建有效的 WebRTC 直播间" to
                "Please sign in and create a valid WebRTC stream first"
            ),
        "status.needLoginStream" to ("请先登录并创建直播间" to "Please sign in and create a stream first"),
        "status.needLoginChat" to ("登录后才能加入弹幕" to "Sign in to join the chat"),
        "status.needLoginComments" to ("请登录后发送评论。" to "Sign in to send comments."),
        "status.waitCameraPermission" to ("等待摄像头权限…" to "Waiting for camera permission…"),
        "status.waitScreenPermission" to ("等待系统录屏授权…" to "Waiting for screen-capture permission…"),
        "status.openingCamera" to ("正在打开摄像头并连接 WebRTC…" to "Opening the camera and connecting WebRTC…"),
        "status.requestingCapture" to (
            "正在申请屏幕共享并连接推流服务器…" to
                "Requesting screen sharing and connecting to the streaming server…"
            ),
        "status.needWhepPath" to ("需要登录并获取有效的 WHEP 播放路径" to "Sign in and get a valid WHEP playback path"),
        "status.coverLogin" to ("请先登录后再设置封面" to "Sign in before setting a cover"),
        "status.coverCreateFirst" to ("请先创建直播间，再设置封面" to "Create a stream before setting a cover"),
        "status.coverUploadingPrevious" to ("上一张封面还在上传，请稍候" to "The previous cover is still uploading; please wait"),
        "status.coverChoose" to ("请选择一张图片作为直播封面" to "Choose an image as the stream cover"),
        "status.coverCancelled" to ("已取消选择封面图片" to "Cover image selection cancelled"),
        "status.coverCompressing" to ("正在压缩封面图片…" to "Compressing the cover image…"),
        "status.coverReadFailed" to (
            "封面读取失败，或图片无法压缩到 2MB 以内。请换一张图片重试。" to
                "Could not read the image or compress it below 2 MB. Please try another image."
            ),
        "status.coverUploading" to ("正在上传封面（%s）…" to "Uploading cover (%s)…"),
        "status.coverUpdated" to ("封面已更新" to "Cover updated"),
        "status.coverTooLarge" to (
            "封面图片超过 2MB 限制，请换一张更小的图片" to
                "The cover image exceeds the 2 MB limit; choose a smaller image"
            ),
        "status.coverUploadFailed" to ("封面上传失败" to "Cover upload failed"),
        "status.serverInvalid" to (
            "服务器地址无效，请填写域名或 IP（可带端口），例如 live.example.com 或 http://192.168.1.5:3000" to
                "Invalid server address; enter a domain or IP (optionally with a port), e.g. live.example.com or http://192.168.1.5:3000"
            ),
        "status.serverNormalized" to (
            "已自动补全服务器地址：%s" to
                "Server address completed automatically: %s"
            ),
        "status.serverNoApiSuffix" to (
            "地址不要带 /api 后缀，例如填写 live.example.com 或 http://服务器IP:3000" to
                "Do not append /api to the address, e.g. live.example.com or http://SERVER_IP:3000"
            ),
        "status.roomReadFailed" to ("读取直播间信息失败（HTTP %s）" to "Failed to read the live room (HTTP %s)"),
        "status.serverChecking" to ("正在检查服务器：%s" to "Checking the server: %s"),
        "status.serverOk" to (
            "服务器连接成功，API 正常，数据库：%s。现在可以注册或登录。" to
                "Server connected, API healthy, database: %s. You can register or sign in now."
            ),
        "status.serverFailed" to (
            "服务器地址已保存，但健康检查失败：%s。请检查公网端口、防火墙和服务状态。" to
                "The address was saved, but the health check failed: %s. Check the public port, firewall and service status."
            ),
        "status.authFields" to ("请填写用户名和密码" to "Please enter a username and password"),
        "status.authUsername" to (
            "用户名需为3-40位中文、字母、数字或下划线" to
                "Username must be 3-40 characters: Chinese, letters, digits or underscores"
            ),
        "status.authPassword" to ("密码长度需为8-128个字符" to "Password must be 8-128 characters"),
        "status.loginOk" to ("登录成功，欢迎回来 %s" to "Signed in. Welcome back, %s"),
        "status.registerOk" to ("注册成功，请使用新账号登录" to "Registered. Please sign in with your new account"),
        "status.authFailed" to ("认证失败" to "Authentication failed"),
        "status.created" to (
            "WebRTC 直播间创建成功。请授权屏幕共享后开播。" to
                "WebRTC stream created. Grant screen sharing to go live."
            ),
        "status.createFailed" to ("创建直播失败" to "Could not create the stream"),
        "status.liveConfirming" to (
            "推流连接已建立，正在确认服务器开播状态…" to
                "Streaming connection established; confirming the live status with the server…"
            ),
        "status.liveConfirmed" to ("直播中 · 服务器已确认推流成功" to "Live · Streaming confirmed by the server"),
        "status.liveWaiting" to (
            "推流连接已建立，等待服务器确认（%s/12）…" to
                "Streaming connection established; waiting for server confirmation (%s/12)…"
            ),
        "status.liveNotConfirmed" to (
            "推流已连接，但服务器尚未确认开播。请检查 SRS HTTP 回调和服务器日志。" to
                "Streaming connected but the server has not confirmed going live. Check the SRS HTTP callback and server logs."
            ),
        "status.liveMissing" to (
            "找不到当前直播记录，请刷新或重新创建直播。" to
                "Current stream record not found; refresh or create the stream again."
            ),
        "status.liveReadFailed" to ("读取服务器直播状态失败（HTTP %s）" to "Failed to read the live status from the server (HTTP %s)"),
        "status.banned" to (
            "账号已被管理员封禁，登录状态已清除。" to
                "The account was banned by an administrator; the sign-in state was cleared."
            ),
        "status.streamsReadFailed" to ("读取直播列表失败" to "Failed to load the stream list"),
        "status.myStreamsReadFailed" to ("读取个人直播失败" to "Failed to load your streams"),
        "status.recordingsReadFailed" to ("读取录像失败" to "Failed to load recordings"),
        "status.recordingUrlEmpty" to ("录像播放地址为空" to "The recording playback URL is empty"),
        "status.recordingLoading" to ("正在加载录像…" to "Loading the recording…"),
        "status.recordingPlayerFailed" to ("录像播放器启动失败：%s" to "Recording player failed to start: %s"),
        "status.chatMaxLength" to ("弹幕最多 500 个字符" to "Chat messages are limited to 500 characters"),
        "status.chatNotConnected" to (
            "弹幕尚未连接，请重新加入直播间" to
                "Chat is not connected; rejoin the room"
            ),
        "status.chatSent" to ("弹幕已发送" to "Chat message sent"),
        "status.chatConnected" to ("弹幕已连接：%s" to "Chat connected: %s"),
        "status.networkFailed" to ("网络请求失败" to "Network request failed"),
        "status.connectionFailed" to ("连接失败：%s" to "Connection failed: %s"),
        "status.checkServerAddress" to ("请检查服务器地址" to "check the server address"),
        "status.httpError" to ("%s（HTTP %s）" to "%s (HTTP %s)"),
        "status.notLive" to ("这场直播当前未开播" to "This stream is not live right now"),
        // ----------------------------------------------------------------- auth
        "auth.welcome" to ("欢迎来到葱直播" to "Welcome to CongLive"),
        "auth.body" to (
            "登录后可以发送实时弹幕、创建直播和查看自己的录像。" to
                "Sign in to send live chat, create streams and view your recordings."
            ),
        "auth.username" to ("用户名（3–40 位）" to "Username (3–40 characters)"),
        "auth.password" to ("密码（至少 8 位）" to "Password (at least 8 characters)"),
        "auth.login" to ("登录" to "Sign in"),
        "auth.register" to ("注册" to "Register"),
        "auth.serverHint" to (
            "首次使用或更换 VPS 时，请先设置服务器地址。可只填域名（自动补 https://），例如 live.example.com；真机不能用模拟器默认地址 10.0.2.2。" to
                "Set the server address on first use or when switching VPS. A bare domain (e.g. live.example.com) is completed with https:// automatically. A real device cannot use the emulator default 10.0.2.2."
            ),
        "auth.serverPlaceholder" to (
            "服务器地址（域名或 http://IP:端口）" to
                "Server address (domain, or http://IP:PORT)"
            ),
        "auth.saveServer" to ("保存地址并检查服务器" to "Save address and check server"),
        // ---------------------------------------------------------------- lobby
        "lobby.title" to ("直播大厅" to "Live Lobby"),
        "lobby.refresh" to ("刷新" to "Refresh"),
        "lobby.body" to (
            "选择正在直播的房间，观看画面并加入实时弹幕。" to
                "Pick a live room, watch the video and join the live chat."
            ),
        "lobby.empty" to (
            "暂时没有直播。你可以切换到「开播」创建自己的直播。" to
                "No live streams right now. Switch to “Go Live” to create your own."
            ),
        "lobby.host" to ("主播：%s" to "Host: %s"),
        "lobby.live" to ("● 直播中" to "● Live"),
        "lobby.offline" to ("○ 未开播" to "○ Offline"),
        "lobby.currentRoom" to ("当前房间" to "Current room"),
        "lobby.watch" to ("观看 / 加入弹幕" to "Watch / Join chat"),
        "lobby.watching" to ("正在观看：%s" to "Watching: %s"),
        "chat.title" to ("实时弹幕" to "Live Chat"),
        "chat.connection" to ("连接状态：%s" to "Connection: %s"),
        "chat.empty" to ("还没有评论，发出第一条弹幕吧。" to "No comments yet — send the first one."),
        "chat.placeholder" to ("输入弹幕评论，最多 500 字" to "Type a chat message (max 500 characters)"),
        "chat.send" to ("发送" to "Send"),
        "chat.leave" to ("离开直播间" to "Leave room"),
        "chat.connected" to ("已连接" to "Connected"),
        "chat.connecting" to ("正在连接…" to "Connecting…"),
        "chat.disconnected" to ("未连接" to "Disconnected"),
        "chat.closed" to ("连接已关闭" to "Connection closed"),
        "chat.roomUnavailable" to ("直播间或账号不可用" to "The room or account is unavailable"),
        "chat.unavailable" to ("弹幕暂不可用" to "Chat is unavailable"),
        "chat.connectFailed" to ("弹幕连接失败：%s" to "Chat connection failed: %s"),
        "chat.networkError" to ("网络错误" to "network error"),
        "chat.room" to ("直播间" to "the room"),
        "chat.user" to ("用户" to "User"),
        // -------------------------------------------------- room (v0.7.9)
        "lobby.enter" to ("进入直播间" to "Enter room"),
        "room.title" to ("直播间" to "Live room"),
        "room.back" to ("← 返回大厅" to "← Back to lobby"),
        "room.leave" to ("离开直播间" to "Leave room"),
        "room.connecting" to ("正在进入直播间…" to "Entering the live room…"),
        "room.needLogin" to ("登录后才能观看直播间" to "Sign in to watch the live room"),
        "room.viewers" to ("观看人数：%s" to "Viewers: %s"),
        "room.viewersPending" to ("观看人数：--" to "Viewers: --"),
        "room.latency" to ("延迟≈%sms" to "Latency ≈ %sms"),
        "room.latencyPending" to ("延迟≈--ms" to "Latency ≈ --ms"),
        "room.notFound" to (
            "直播不存在或已删除，已返回大厅" to
                "This stream does not exist or was deleted; back to the lobby"
            ),
        "room.ended" to ("直播已结束，已返回大厅" to "The stream has ended; back to the lobby"),
        "room.loadFailed" to ("直播间信息加载失败：%s" to "Failed to load the live room: %s"),
        "room.host" to ("主播：%s" to "Host: %s"),
        // ------------------------------------------------------------ broadcast
        "broadcast.title" to ("创建直播" to "Create a Stream"),
        "broadcast.body" to (
            "选择屏幕或摄像头作为唯一视频源，通过 WebRTC/WHIP 低延迟推流。" to
                "Choose the screen or the camera as the single video source and stream with low latency over WebRTC/WHIP."
            ),
        "broadcast.currentStatus" to ("当前状态：%s" to "Current status: %s"),
        "broadcast.idle" to ("尚未开播" to "Not live yet"),
        "broadcast.screen" to ("屏幕直播" to "Screen"),
        "broadcast.camera" to ("摄像头直播" to "Camera"),
        "broadcast.stopFirstToSwitch" to (
            "请先停止当前直播，再切换视频源" to
                "Stop the current stream before switching the video source"
            ),
        "broadcast.defaultScreenTitle" to ("我的屏幕直播" to "My screen stream"),
        "broadcast.defaultCameraTitle" to ("我的摄像头直播" to "My camera stream"),
        "broadcast.qualityTitle" to (
            "画质设置（1080p / 60fps 需服务器容量支持）" to
                "Quality (1080p / 60 fps need server capacity)"
            ),
        "broadcast.resolutionSaved" to (
            "分辨率已保存：%s（%s×%s，%s），下次开播生效" to
                "Resolution saved: %s (%s×%s, %s). Applies to the next stream."
            ),
        "broadcast.fpsSaved" to ("帧率已保存：%s fps，下次开播生效" to "Frame rate saved: %s fps. Applies to the next stream."),
        "broadcast.qualitySummary" to (
            "当前：%s · %s×%s · %s · %s fps\n屏幕直播按竖屏 %s×%s 采集；摄像头直播按横屏 %s×%s 采集。" to
                "Current: %s · %s×%s · %s · %s fps\nScreen capture uses portrait %s×%s; camera capture uses landscape %s×%s."
            ),
        // v0.7.9: before going live the app asks GET /api/capacity and gates 1080p / 60fps.
        "broadcast.capacityTitle" to ("服务器能力" to "Server capacity"),
        "broadcast.capacityAllowed" to (
            "服务器资源充足：1080p / 60fps 可选" to
                "Server has enough capacity: 1080p / 60 fps enabled"
            ),
        "broadcast.capacityChecking" to (
            "正在检查服务器能力…" to
                "Checking server capacity…"
            ),
        "broadcast.capacityDisabled" to (
            "服务器资源不足，已禁用 1080p / 60fps：%s" to
                "Not enough server capacity; 1080p / 60 fps disabled: %s"
            ),
        "broadcast.capacityUnavailable" to (
            "无法获取服务器能力，暂时禁用 1080p / 60fps" to
                "Server capacity unavailable; 1080p / 60 fps temporarily disabled"
            ),
        "broadcast.capacityLimited" to (
            "CPU 核心、可用内存或当前直播数不满足要求" to
                "CPU cores, free memory or the number of live rooms do not meet the requirement"
            ),
        "broadcast.highQualityReset" to (
            "服务器不支持 1080p / 60fps，已恢复 720p / 24fps" to
                "The server does not support 1080p / 60 fps; reverted to 720p / 24 fps"
            ),
        "broadcast.highQualityBlocked" to (
            "服务器资源不足，无法启用 1080p / 60fps：%s" to
                "Not enough server capacity for 1080p / 60 fps: %s"
            ),
        "broadcast.cameraBody" to (
            "摄像头默认关闭。开始直播时才请求摄像头权限；可在直播中切换前置/后置摄像头。" to
                "The camera stays off by default; permission is requested only when streaming starts. You can switch the front/back camera while live."
            ),
        "broadcast.previewUnavailable" to (
            "摄像头预览暂不可用，但推流状态会继续显示" to
                "Camera preview is unavailable, but the streaming status keeps updating"
            ),
        "broadcast.switchCamera" to ("切换前置 / 后置摄像头" to "Switch front / back camera"),
        "broadcast.screenPermissionBody" to (
            "开始时会弹出 Android 系统屏幕共享授权。" to
                "Android will ask for screen-sharing permission when you start."
            ),
        // v0.8.2: experimental AudioPlaybackCapture toggle (screen sharing only).
        "broadcast.systemAudioTitle" to ("系统音频（实验）" to "System audio (experimental)"),
        "broadcast.systemAudioOn" to (
            "系统内录：已开启（替换麦克风）" to
                "System audio: on (replaces microphone)"
            ),
        "broadcast.systemAudioOff" to (
            "系统内录：关闭（使用麦克风）" to
                "System audio: off (uses microphone)"
            ),
        "broadcast.systemAudioBody" to (
            "开启后屏幕直播会尝试用 AudioPlaybackCapture 采集设备正在播放的声音并替换麦克风；部分 App 禁止被录制，部分机型会失败，失败时自动回退麦克风。" to
                "When enabled, screen streaming tries to capture the audio playing on the device with AudioPlaybackCapture and replaces the microphone. Some apps block capture and some devices fail; failures fall back to the microphone automatically."
            ),
        "broadcast.systemAudioEnabledHint" to (
            "已开启系统内录（实验）；无法采集时会自动回退麦克风" to
                "System audio capture enabled (experimental); falls back to the microphone if capture fails"
            ),
        "broadcast.systemAudioDisabledHint" to (
            "已关闭系统内录，开播将使用麦克风" to
                "System audio capture disabled; streaming will use the microphone"
            ),
        "broadcast.audioSource" to ("音频来源" to "Audio source"),
        "broadcast.audioSourceSystem" to ("系统内录（实验）" to "System audio (experimental)"),
        "broadcast.audioSourceMic" to ("麦克风" to "Microphone"),
        "broadcast.titleHint" to ("直播标题" to "Stream title"),
        "broadcast.create" to ("创建直播并获取推流地址" to "Create stream and get publishing URL"),
        "broadcast.protocol" to ("传输协议" to "Protocol"),
        "broadcast.source" to ("视频源" to "Video source"),
        "broadcast.sourceCamera" to ("摄像头" to "Camera"),
        "broadcast.sourceScreen" to ("屏幕" to "Screen"),
        "broadcast.qualityLabel" to ("画质" to "Quality"),
        "broadcast.publishPath" to ("发布接口" to "Publish endpoint"),
        "broadcast.coverTitle" to ("直播封面（可选）" to "Stream cover (optional)"),
        "broadcast.coverUploading" to ("正在上传封面…" to "Uploading cover…"),
        "broadcast.chooseCover" to ("从相册选择封面" to "Choose cover from gallery"),
        "broadcast.startCamera" to ("开始摄像头直播" to "Start camera stream"),
        "broadcast.startScreen" to ("开始屏幕直播" to "Start screen stream"),
        "broadcast.createdHint" to (
            "创建直播后会显示开播按钮和封面设置。" to
                "After creating a stream, the start button and cover settings appear."
            ),
        "broadcast.stop" to ("停止直播" to "Stop stream"),
        "broadcast.stopping" to ("正在停止直播…" to "Stopping the stream…"),
        "broadcast.myStreams" to ("我的直播记录" to "My Streams"),
        "broadcast.myStreamsEmpty" to ("还没有创建过直播。" to "You have not created a stream yet."),
        "broadcast.untitled" to ("未命名直播" to "Untitled stream"),
        "broadcast.hasCover" to ("已有封面" to "cover set"),
        "broadcast.noCover" to ("暂无封面" to "no cover"),
        "broadcast.uploadingShort" to ("正在上传…" to "Uploading…"),
        "broadcast.chooseCoverShort" to ("从相册选封面" to "Choose cover"),
        "broadcast.roomCreated" to ("直播间已创建，等待开始屏幕共享" to "Stream created; waiting to start screen sharing"),
        "broadcast.startingCameraNotification" to (
            "正在启动 WebRTC 摄像头直播" to
                "Starting WebRTC camera stream"
            ),
        "broadcast.startingScreenNotification" to (
            "正在启动 WebRTC 屏幕直播" to
                "Starting WebRTC screen stream"
            ),
        // ----------------------------------------------------------- recordings
        "recordings.title" to ("我的录像" to "My Recordings"),
        "recordings.refresh" to ("刷新" to "Refresh"),
        "recordings.body" to (
            "这里只显示你自己直播产生的录像。点击即可在线回放。" to
                "Only recordings from your own streams appear here. Tap to play online."
            ),
        "recordings.needLogin" to ("请先登录后查看个人录像。" to "Sign in to view your recordings."),
        "recordings.empty" to (
            "暂时没有找到录像。直播结束并完成录像写入后，可点击刷新。" to
                "No recordings found yet. Refresh after a stream ends and the recording is written."
            ),
        "recordings.playing" to ("正在播放" to "Playing"),
        "recordings.play" to ("在线回放" to "Play online"),
        "recordings.playTitle" to ("录像回放：%s" to "Recording playback: %s"),
        // -------------------------------------------------------------- profile
        "profile.title" to ("我的账户" to "My Account"),
        "profile.bodyGuest" to ("登录后可管理自己的直播和录像。" to "Sign in to manage your streams and recordings."),
        "profile.banned" to ("账号当前不可用，请联系管理员。" to "This account is unavailable. Contact an administrator."),
        "profile.statusOk" to ("账号状态：正常登录" to "Account status: signed in"),
        "profile.checkStatus" to (
            "检查账号状态 / 刷新我的直播" to
                "Check account / Refresh my streams"
            ),
        "profile.logout" to ("退出登录" to "Sign out"),
        "profile.settings" to ("服务器设置" to "Server Settings"),
        "profile.serverBody" to (
            "填写你的葱直播服务器地址：可只填域名（自动补 https://，如 live.example.com），也可填 http://服务器IP:3000。" to
                "Enter your CongLive server address: a bare domain works (live.example.com becomes https://…), or use http://SERVER_IP:3000."
            ),
        "profile.apiHint" to ("API 地址" to "API address"),
        "profile.saveServer" to ("保存服务器地址并检查连接" to "Save server address and check connection"),
        "profile.language" to ("语言 / Language" to "Language / 语言"),
        "profile.languageBody" to ("切换后立即生效，并保存在本机。" to "Applies immediately and is saved on this device."),
        "lang.zh" to ("中文" to "中文"),
        "lang.en" to ("English" to "English"),
        // --------------------------------------------------------------- live2d
        "live2d.title" to ("Live2D 看板娘" to "Live2D Mascot"),
        "live2d.body" to (
            "只作为 App 界面里的看板娘显示，不会合成进直播画面，也不会进入 WebRTC 推流。" to
                "Shown only inside the app; it is never composited into the video or sent over WebRTC."
            ),
        "live2d.body2" to (
            "「选择模型包」可直接读取本地 zip（含 .model3.json 与贴图/moc3 资源）；也可以输入模型 .model3.json 的公网地址，模型资源需要允许跨域访问（CORS）。运行库来自 CDN，App 不内置模型。" to
                "“Choose model package” reads a local .zip that contains the .model3.json and its assets; alternatively enter a public .model3.json URL whose assets allow CORS. The runtime comes from a CDN and no model is bundled."
            ),
        "live2d.urlHint" to (
            "模型地址，例如 https://example.com/model.model3.json" to
                "Model URL, e.g. https://example.com/model.model3.json"
            ),
        "live2d.load" to ("加载模型" to "Load model"),
        "live2d.pickZip" to ("选择模型包" to "Choose model package"),
        "live2d.zipChoose" to (
            "请选择包含 .model3.json 与贴图资源的模型 zip 包" to
                "Pick a model .zip that contains the .model3.json and its textures"
            ),
        "live2d.zipCopying" to ("正在读取模型包…" to "Reading the model package…"),
        "live2d.zipCopied" to ("模型包已就绪：%s" to "Model package ready: %s"),
        "live2d.zipCopyFailed" to (
            "模型包复制失败，请重新选择" to
                "Could not copy the model package; please pick it again"
            ),
        "live2d.zipCancelled" to ("已取消选择模型包" to "Model package selection cancelled"),
        "live2d.zipEmpty" to ("模型包为空或无法读取" to "The model package is empty or unreadable"),
        "live2d.zipTooLarge" to (
            "模型包超过 %s MB，无法加载" to
                "The model package exceeds %s MB and cannot be loaded"
            ),
        "live2d.zipLoading" to ("正在加载本地模型包…" to "Loading the local model package…"),
        "live2d.show" to ("显示" to "Show"),
        "live2d.hide" to ("隐藏" to "Hide"),
        "live2d.reload" to ("重新加载看板娘页面" to "Reload mascot page"),
        "live2d.waiting" to (
            "等待模型：选择模型包，或贴入 .model3.json 地址后点击「加载模型」。" to
                "Waiting for a model: pick a model package, or paste a .model3.json URL and tap “Load model”."
            ),
        "live2d.statusUpdated" to ("Live2D 状态已更新" to "Live2D status updated"),
        "live2d.loadFailed" to ("Live2D 加载失败" to "Live2D failed to load"),
        "live2d.pageFailed" to ("Live2D 页面加载失败：%s" to "Live2D page failed to load: %s"),
        "live2d.urlEmpty" to ("请先填写 .model3.json 地址" to "Enter a .model3.json URL first"),
        "live2d.urlScheme" to (
            "模型地址必须以 http:// 或 https:// 开头" to
                "The model URL must start with http:// or https://"
            ),
        "live2d.urlNotModel" to ("地址需要指向 .model3.json 文件" to "The URL must point to a .model3.json file"),
        "live2d.pageInitializing" to (
            "Live2D 页面正在初始化，稍后自动加载…" to
                "Live2D page is initializing; loading automatically…"
            ),
        "live2d.loading" to ("正在加载 Live2D 模型…" to "Loading the Live2D model…"),
        "live2d.reloading" to ("正在重新加载 Live2D 页面…" to "Reloading the Live2D page…"),
        // ------------------------------------------------------------- covers
        "cover.initialFallback" to ("葱" to "C"),
        // ------------------------------------------------------ camera preview
        "bridge.firstFrame" to ("摄像头预览已渲染" to "Camera preview rendered"),
        // -------------------------------------------------------------- service
        "svc.channelName" to ("葱直播屏幕推流" to "CongLive screen streaming"),
        "svc.alreadyRunning" to (
            "WebRTC 直播已经在启动或进行中" to
                "A WebRTC stream is already starting or running"
            ),
        "svc.foregroundFailed" to ("无法启用前台服务：%s" to "Could not start the foreground service: %s"),
        "svc.invalidSignal" to ("WHIP 信令地址无效" to "Invalid WHIP signalling URL"),
        "svc.loginExpired" to ("登录状态已失效，请重新登录" to "Sign-in expired; please sign in again"),
        "svc.noProjection" to ("没有收到系统录屏授权数据" to "No screen-capture authorization data received"),
        "svc.startFailed" to ("WebRTC 开播失败：%s" to "WebRTC stream failed to start: %s"),
        "svc.stopped" to ("直播已停止" to "Stream stopped"),
        "svc.serviceClosed" to ("直播服务已关闭" to "Streaming service closed"),
        "svc.projectionStopped" to ("系统已停止屏幕共享" to "Screen sharing was stopped by the system"),
        "svc.cameraError" to ("摄像头错误：%s" to "Camera error: %s"),
        "svc.cameraDisconnected" to ("摄像头已断开" to "Camera disconnected"),
        "svc.cameraFrozen" to ("摄像头画面冻结：%s" to "Camera preview frozen: %s"),
        "svc.cameraOpening" to ("正在打开摄像头：%s" to "Opening camera: %s"),
        "svc.cameraStarted" to ("摄像头采集已启动，正在连接 WebRTC…" to "Camera capture started; connecting WebRTC…"),
        "svc.cameraClosed" to ("摄像头已关闭" to "Camera closed"),
        "svc.noCamera" to ("没有发现可用摄像头" to "No usable camera found"),
        "svc.capturerCreateFailed" to ("无法创建摄像头采集器" to "Could not create the camera capturer"),
        "svc.switchCameraFront" to ("已切换到前置摄像头" to "Switched to the front camera"),
        "svc.switchCameraBack" to ("已切换到后置摄像头" to "Switched to the back camera"),
        "svc.switchCameraFailed" to ("切换摄像头失败：%s" to "Failed to switch camera: %s"),
        "svc.notCamera" to ("当前不是摄像头直播" to "The current stream is not a camera stream"),
        "svc.videoParams" to (
            "视频参数：%s×%s @ %sfps · %skbps · 关键帧间隔 %ss" to
                "Video: %s×%s @ %s fps · %s kbps · keyframe interval %s s"
            ),
        "svc.encodingRejected" to (
            "视频码率/帧率参数未被编码器接受，将使用默认值" to
                "The encoder rejected the bitrate/frame-rate settings; defaults will be used"
            ),
        "svc.encodingFailed" to ("应用视频码率参数失败：%s" to "Failed to apply the video bitrate settings: %s"),
        "svc.iceConnected" to (
            "WebRTC 推流成功 · 服务器媒体通道已连接" to
                "WebRTC streaming established · server media channel connected"
            ),
        "svc.iceFailed" to (
            "WebRTC ICE 连接失败，请检查公网候选 IP 和 UDP/TCP 8000" to
                "WebRTC ICE connection failed; check the public candidate IP and UDP/TCP 8000"
            ),
        "svc.iceDisconnected" to (
            "WebRTC 网络暂时断开，正在尝试恢复…" to
                "WebRTC network temporarily disconnected; trying to recover…"
            ),
        "svc.iceTimeout" to (
            "ICE 候选收集超时，继续尝试当前候选" to
                "ICE candidate gathering timed out; continuing with the current candidates"
            ),
        "svc.peerCreateFailed" to ("无法创建 WebRTC PeerConnection" to "Could not create the WebRTC PeerConnection"),
        "svc.trackMissing" to ("屏幕视频轨道尚未初始化" to "The screen video track is not initialized"),
        "svc.transceiverMissing" to ("找不到视频 RTP Transceiver" to "Video RTP transceiver not found"),
        "svc.h264Missing" to (
            "当前设备 WebRTC 编码器没有 H.264，请更新系统 WebView/设备 WebRTC 运行环境" to
                "This device's WebRTC encoder lacks H.264; update the system WebView/WebRTC runtime"
            ),
        "svc.codecFailed" to ("设置 H.264 编码优先级失败：%s" to "Failed to set H.264 codec priority: %s"),
        "svc.unknownError" to ("未知错误" to "unknown error"),
        "svc.offerTimeout" to ("创建 WebRTC SDP Offer 超时" to "Timed out creating the WebRTC SDP offer"),
        "svc.offerFailed" to ("创建 SDP Offer 失败：%s" to "Failed to create the SDP offer: %s"),
        "svc.localSdpTimeout" to ("设置本地 SDP 超时" to "Timed out setting the local SDP"),
        "svc.localSdpFailed" to ("设置本地 SDP 失败：%s" to "Failed to set the local SDP: %s"),
        "svc.localSdpEmpty" to ("本地 SDP 为空" to "Local SDP is empty"),
        "svc.negotiating" to ("正在通过 WHIP 协商媒体会话…" to "Negotiating the media session via WHIP…"),
        "svc.whipHttp" to ("WHIP HTTP %s：%s" to "WHIP HTTP %s: %s"),
        "svc.answerInvalid" to ("媒体服务器返回的 SDP Answer 无效" to "The media server returned an invalid SDP answer"),
        "svc.remoteSdpTimeout" to ("设置远端 SDP 超时" to "Timed out setting the remote SDP"),
        "svc.remoteSdpFailed" to ("设置远端 SDP 失败：%s" to "Failed to set the remote SDP: %s"),
        "svc.whipDone" to (
            "WHIP 信令交换完成，正在建立媒体连接…" to
                "WHIP signalling complete; establishing the media connection…"
            ),
        "svc.videoSourceMissing" to ("视频源尚未初始化" to "The video source is not initialized"),
        // v0.8.2: experimental AudioPlaybackCapture (screen sharing).
        "svc.systemAudioEnabled" to (
            "系统内录已启用（实验）：%s Hz 单声道，替换麦克风音频" to
                "System audio capture enabled (experimental): %s Hz mono, replacing the microphone"
            ),
        "svc.systemAudioFallback" to (
            "系统内录不可用，已回退麦克风：%s" to
                "System audio capture unavailable; fell back to the microphone: %s"
            ),
        "svc.systemAudioNoProjection" to (
            "无法获取 MediaProjection" to
                "Could not access the MediaProjection"
            ),
        "svc.systemAudioNoAdm" to ("音频模块尚未初始化" to "The audio module is not initialized"),
        "svc.systemAudioBuffer" to (
            "系统内录缓冲区无效：%s" to
                "Invalid system-audio capture buffer: %s"
            ),
        "svc.systemAudioNotInitialized" to (
            "系统内录 AudioRecord 初始化失败" to
                "The system-audio AudioRecord failed to initialize"
            ),
        "svc.systemAudioPrewarm" to (
            "音频采集预初始化失败" to
                "Audio capture pre-initialization failed"
            ),
        "svc.systemAudioReflection" to (
            "反射注入系统内录 AudioRecord 失败" to
                "Reflection injection of the system-audio AudioRecord failed"
            ),
        // -------------------------------------------------- voice room (v0.8.0)
        "voice.title" to ("语音房" to "Voice room"),
        "voice.hint" to (
            "加入后才申请麦克风，并与房内其他听众建立点对点全双工音频；离开会释放麦克风和所有连接。" to
                "The microphone is requested only after you join, then you get point-to-point full-duplex audio with the other listeners. Leaving releases the microphone and every connection."
            ),
        "voice.join" to ("加入语音" to "Join voice"),
        "voice.joining" to ("正在加入语音…" to "Joining voice…"),
        "voice.leave" to ("离开语音" to "Leave voice"),
        "voice.mute" to ("静音" to "Mute"),
        "voice.unmute" to ("取消静音" to "Unmute"),
        "voice.mutedBadge" to ("已静音" to "Muted"),
        "voice.liveBadge" to ("语音中" to "In voice"),
        "voice.idleBadge" to ("未加入" to "Not joined"),
        "voice.errorBadge" to ("语音错误" to "Voice error"),
        "voice.connecting" to ("连接中…" to "Connecting…"),
        "voice.connected" to ("已连接" to "Connected"),
        "voice.speaking" to ("说话中" to "Speaking"),
        "voice.participants" to ("参与者 %s 人" to "%s participant(s)"),
        "voice.you" to ("（你）" to " (you)"),
        "voice.empty" to (
            "还没有其他参与者；分享房间给听众，他们加入语音后即可全双工通话。" to
                "No other participants yet. Share the room; listeners can talk full-duplex once they join voice."
            ),
        "voice.joinHint" to (
            "点击「加入语音」前不会创建 PeerConnection，也不会占用麦克风。" to
                "No PeerConnection is created and the microphone is untouched until you tap Join voice."
            ),
        "voice.retry" to ("重新加入" to "Rejoin"),
        "voice.error.micDenied" to (
            "麦克风权限被拒绝：请允许麦克风后重试。" to
                "Microphone permission was denied. Allow it and try again."
            ),
        "voice.error.micNotFound" to ("未找到可用的麦克风设备。" to "No microphone device was found."),
        "voice.error.micBusy" to (
            "麦克风被其他程序占用，请关闭后重试。" to
                "The microphone is in use by another app. Close it and try again."
            ),
        "voice.error.micUnsupported" to (
            "当前设备不支持麦克风采集，无法加入语音。" to
                "This device does not support microphone capture, so voice is unavailable."
            ),
        "voice.error.micFailed" to ("获取麦克风失败：%s" to "Could not access the microphone: %s"),
        "voice.error.connectFailed" to (
            "语音连接失败，请检查网络后重试。" to
                "Voice connection failed. Check your network and try again."
            ),
        "voice.error.auth" to (
            "登录状态已失效，请重新登录后再加入语音。" to
                "Your session has expired. Sign in again before joining voice."
            ),
        "voice.error.disconnected" to (
            "语音连接已断开，请重新加入。" to
                "The voice connection was closed. Please rejoin."
            ),
        "voice.error.notJoined" to (
            "语音尚未加入房间，请重新加入。" to
                "Voice has not joined the room yet. Please rejoin."
            ),
        "voice.error.targetLeft" to ("对方已离开语音房。" to "The other participant has left the voice room."),
        "voice.error.invalidSignal" to (
            "语音信令格式错误，已忽略。" to
                "The voice signal was invalid and has been ignored."
            ),
        "voice.error.signalTooLarge" to (
            "语音信令过大，已被服务器拒绝。" to
                "The voice signal was too large and was rejected by the server."
            ),
        "voice.error.rateLimited" to (
            "语音信令过于频繁，请稍后重试。" to
                "Voice signals are being sent too fast; try again shortly."
            ),
        "voice.error.signal" to ("语音信令错误。" to "Voice signaling error."),
        "voice.error.peerFailed" to (
            "与某位参与者的音频连接失败，可尝试离开后重新加入。" to
                "The audio connection to a participant failed; leave and rejoin to retry."
            ),
        // v0.8.1: TURN relay status shown in the voice card.
        "voice.relay.checking" to (
            "正在获取中继凭据…" to
                "Fetching relay credentials…"
            ),
        "voice.relay.turn" to (
            "中继：TURN（跨 NAT 更稳定）" to
                "Relay: TURN (more reliable across NAT)"
            ),
        "voice.relay.stun" to ("直连 / STUN" to "Direct / STUN"),
        "voice.relay.fallback" to (
            "无法获取 TURN 凭据（%s），已回退 STUN 直连；严格 NAT/防火墙环境可能无法建立语音。" to
                "Could not get TURN credentials (%s); falling back to direct STUN. Voice may fail behind strict NAT/firewalls."
            ),
        // ------------------------------------------------------------ playback
        "playback.firstFrame" to ("已收到视频首帧" to "First video frame received"),
        "playback.peerCreateFailed" to ("无法创建 WebRTC 播放连接" to "Could not create the WebRTC playback connection"),
        "playback.offerTimeout" to ("创建 WHEP Offer 超时" to "Timed out creating the WHEP offer"),
        "playback.offerFailed" to ("创建 WHEP Offer 失败：%s" to "Failed to create the WHEP offer: %s"),
        "playback.localSdpTimeout" to ("设置本地 SDP 超时" to "Timed out setting the local SDP"),
        "playback.localSdpFailed" to ("本地 SDP 失败：%s" to "Local SDP failed: %s"),
        "playback.iceTimeout" to (
            "ICE 候选收集超时，继续尝试当前候选" to
                "ICE candidate gathering timed out; continuing with the current candidates"
            ),
        "playback.localSdpEmpty" to ("本地 SDP 为空" to "Local SDP is empty"),
        "playback.remoteSdpTimeout" to ("设置远端 SDP 超时" to "Timed out setting the remote SDP"),
        "playback.remoteSdpFailed" to ("远端 SDP 失败：%s" to "Remote SDP failed: %s"),
        "playback.signalingDone" to ("WHEP 信令已完成，正在连接媒体…" to "WHEP signalling complete; connecting media…"),
        "playback.failed" to ("WebRTC 播放失败：%s" to "WebRTC playback failed: %s"),
        "playback.connected" to ("WebRTC 已连接 · 低延迟播放中" to "WebRTC connected · playing with low latency"),
        "playback.iceFailed" to (
            "WebRTC ICE 失败，请检查候选 IP 和 8000 端口" to
                "WebRTC ICE failed; check the candidate IP and port 8000"
            ),
        "playback.disconnected" to ("WebRTC 播放暂时断开" to "WebRTC playback temporarily disconnected"),
        "playback.state" to ("WebRTC：%s" to "WebRTC: %s"),
        "playback.whepHttp" to ("WHEP HTTP %s：%s" to "WHEP HTTP %s: %s"),
        "playback.answerInvalid" to ("服务器 SDP Answer 无效" to "The server SDP answer is invalid")
    )
}
