package com.conglive.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjection
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera1Enumerator
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraEnumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.CameraVideoCapturer.CameraEventsHandler
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.audio.JavaAudioDeviceModule
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpSender
import org.webrtc.MediaStreamTrack
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.VideoCapturer
import org.webrtc.ScreenCapturerAndroid
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * WebRTC publisher for either MediaProjection screen capture or Camera2.
 * Camera use requires an explicit runtime permission; the selected video source
 * is sent as the single WHIP video track accepted by the endpoint.
 */
class ScreenStreamService : Service() {
    companion object {
        const val ACTION_START = "com.conglive.app.action.START"
        const val ACTION_STOP = "com.conglive.app.action.STOP"
        const val ACTION_STATUS = "com.conglive.app.action.STATUS"
        const val ACTION_SWITCH_CAMERA = "com.conglive.app.action.SWITCH_CAMERA"
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_DATA = "projection_data"
        const val EXTRA_SIGNAL_URL = "whip_url"
        const val EXTRA_AUTH_TOKEN = "auth_token"
        const val EXTRA_CAMERA_MODE = "camera_mode"
        const val EXTRA_FRONT_CAMERA = "front_camera"
        /** Landscape width/height of the selected resolution; screen capture swaps them. */
        const val EXTRA_VIDEO_WIDTH = "video_width"
        const val EXTRA_VIDEO_HEIGHT = "video_height"
        const val EXTRA_VIDEO_BITRATE = "video_bitrate"
        const val EXTRA_VIDEO_FPS = "video_fps"
        const val EXTRA_MESSAGE = "message"
        private const val MIN_VIDEO_DIMENSION = 160
        private const val MAX_VIDEO_DIMENSION = 1920
        private const val MIN_VIDEO_BITRATE = 100_000
        private const val MAX_VIDEO_BITRATE = 20_000_000
        private const val MIN_VIDEO_FPS = 1
        private const val MAX_VIDEO_FPS = 60
        private const val CHANNEL_ID = "conglive_screen_stream"
        private const val NOTIFICATION_ID = 704
    }

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(25, TimeUnit.SECONDS)
        .build()
    private var eglBase: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    private var audioModule: JavaAudioDeviceModule? = null
    private var peer: PeerConnection? = null
    private var capturer: VideoCapturer? = null
    private var cameraCapturer: CameraVideoCapturer? = null
    private var cameraMode = false
    /** Landscape dimensions as configured on the broadcast page (default 1280x720). */
    private var configuredWidth = VideoSettings.defaultResolution().width
    private var configuredHeight = VideoSettings.defaultResolution().height
    /** Encoder targets applied to the video RTP sender (default 2 Mbps / 24 fps). */
    private var videoBitrateBps = VideoSettings.defaultResolution().bitrateBps
    private var videoFps = VideoSettings.DEFAULT_FPS
    private var iFrameInterval = VideoSettings.DEFAULT_IFRAME_INTERVAL
    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    private var videoSource: VideoSource? = null
    private var audioSource: AudioSource? = null
    private var videoTrack: VideoTrack? = null
    private var audioTrack: AudioTrack? = null
    @Volatile private var isStopping = false
    @Volatile private var isStarting = false
    /** Set as soon as a stop is requested; the media worker polls it between steps. */
    @Volatile private var stopRequested = false
    @Volatile private var mediaWorker: Thread? = null
    @Volatile private var pendingCall: Call? = null
    /** Serializes worker hand-off and teardown so a joining stop cannot miss a worker. */
    private val stateLock = Any()

    /** Internal control-flow exception: the streaming session was stopped while setting up. */
    private class StreamStopped : RuntimeException()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startStreaming(intent)
            ACTION_STOP -> stopStreaming("直播已停止")
            ACTION_SWITCH_CAMERA -> switchCamera()
        }
        return START_NOT_STICKY
    }

    private fun startStreaming(intent: Intent) {
        if (isStarting || isStopping || peer != null || mediaWorker?.isAlive == true) {
            sendStatus("WebRTC 直播已经在启动或进行中")
            return
        }
        cameraMode = intent.getBooleanExtra(EXTRA_CAMERA_MODE, false)
        val fallback = VideoSettings.defaultResolution()
        configuredWidth = sanitizeDimension(intent.getIntExtra(EXTRA_VIDEO_WIDTH, fallback.width), fallback.width)
        configuredHeight = sanitizeDimension(intent.getIntExtra(EXTRA_VIDEO_HEIGHT, fallback.height), fallback.height)
        videoBitrateBps = intent.getIntExtra(EXTRA_VIDEO_BITRATE, fallback.bitrateBps)
            .coerceIn(MIN_VIDEO_BITRATE, MAX_VIDEO_BITRATE)
        val requestedFps = intent.getIntExtra(EXTRA_VIDEO_FPS, VideoSettings.DEFAULT_FPS)
        videoFps = if (requestedFps in VideoSettings.FPS_OPTIONS) requestedFps else VideoSettings.DEFAULT_FPS
        iFrameInterval = VideoSettings.DEFAULT_IFRAME_INTERVAL
        isStarting = true
        isStopping = false
        stopRequested = false
        // Called from a startForegroundService() Intent, so startForeground() must be
        // invoked promptly even if the remaining arguments turn out to be invalid.
        try {
            startCaptureForeground(cameraMode)
        } catch (error: Exception) {
            sendStatus("无法启用前台服务：${error.message ?: error.javaClass.simpleName}")
            stopStreaming("直播已停止")
            return
        }
        val signalUrl = intent.getStringExtra(EXTRA_SIGNAL_URL).orEmpty().trim()
        val authToken = intent.getStringExtra(EXTRA_AUTH_TOKEN).orEmpty().trim()
        if (!signalUrl.startsWith("https://") && !signalUrl.startsWith("http://")) {
            sendStatus("WHIP 信令地址无效")
            stopStreaming("直播已停止")
            return
        }
        if (authToken.isBlank()) {
            sendStatus("登录状态已失效，请重新登录")
            stopStreaming("直播已停止")
            return
        }
        @Suppress("DEPRECATION")
        val resultData = intent.getParcelableExtra<Intent>(EXTRA_DATA)
        if (!cameraMode && resultData == null) {
            sendStatus("没有收到系统录屏授权数据")
            stopStreaming("直播已停止")
            return
        }
        val worker = Thread({
            try {
                try {
                    prepareMedia(
                        resultData,
                        cameraMode,
                        intent.getBooleanExtra(EXTRA_FRONT_CAMERA, true),
                        configuredWidth,
                        configuredHeight,
                        videoBitrateBps,
                        videoFps
                    )
                    abortIfStopped()
                    negotiateWhip(signalUrl, authToken)
                } catch (_: StreamStopped) {
                    // A stop was requested mid-setup; stopStreaming() owns teardown.
                }
            } catch (error: Exception) {
                if (!stopRequested) {
                    sendStatus("WebRTC 开播失败：${error.message ?: error.javaClass.simpleName}")
                }
                stopStreaming("直播已停止")
            } finally {
                isStarting = false
            }
        }, "CongLive-WebRTC-Session").apply { isDaemon = true }
        synchronized(stateLock) {
            if (stopRequested) {
                isStarting = false
                stopStreaming("直播已停止")
                return
            }
            mediaWorker = worker
            worker.start()
        }
    }

    private fun prepareMedia(
        resultData: Intent?,
        useCamera: Boolean,
        frontCamera: Boolean,
        width: Int,
        height: Int,
        bitrateBps: Int,
        fps: Int
    ) {
        // 摄像头按横屏尺寸采集；屏幕共享按竖屏尺寸采集（交换宽高）。
        val captureWidth = if (useCamera) width else height
        val captureHeight = if (useCamera) height else width
        // ScreenCapturerAndroid consumes the one-time MediaProjection grant itself.
        // Do not call MediaProjectionManager.getMediaProjection() here as well: Android 14+
        // restricts reusing a projection grant and would fail when the capturer starts.
        abortIfStopped()

        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(applicationContext).createInitializationOptions()
        )
        val egl = EglBase.create()
        eglBase = egl
        val adm = JavaAudioDeviceModule.builder(applicationContext).createAudioDeviceModule()
        audioModule = adm
        abortIfStopped()
        factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(adm)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, false))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()
        abortIfStopped()

        val helper = SurfaceTextureHelper.create("CongLive-WebRTC-Capture", egl.eglBaseContext)
        surfaceTextureHelper = helper
        val source = factory!!.createVideoSource(!useCamera)
        videoSource = source
        prepareVideo(captureWidth, captureHeight, bitrateBps, fps, iFrameInterval = VideoSettings.DEFAULT_IFRAME_INTERVAL)
        abortIfStopped()

        if (useCamera) {
            val enumerator: CameraEnumerator = if (Camera2Enumerator.isSupported(applicationContext)) {
                Camera2Enumerator(applicationContext)
            } else {
                // Some devices expose only legacy Camera2 hardware; fall back to Camera1 API.
                Camera1Enumerator(false)
            }
            val names = enumerator.deviceNames.toList()
            val selectedName = names.firstOrNull { enumerator.isFrontFacing(it) == frontCamera }
                ?: names.firstOrNull()
                ?: throw IllegalStateException("没有发现可用摄像头")
            val created = enumerator.createCapturer(selectedName, object : CameraEventsHandler {
                override fun onCameraError(errorDescription: String) {
                    sendStatus("摄像头错误：$errorDescription")
                }
                override fun onCameraDisconnected() { sendStatus("摄像头已断开") }
                override fun onCameraFreezed(errorDescription: String) { sendStatus("摄像头画面冻结：$errorDescription") }
                override fun onCameraOpening(cameraName: String) { sendStatus("正在打开摄像头：$cameraName") }
                override fun onFirstFrameAvailable() { sendStatus("摄像头采集已启动，正在连接 WebRTC…") }
                override fun onCameraClosed() { sendStatus("摄像头已关闭") }
            }) ?: throw IllegalStateException("无法创建摄像头采集器")
            cameraCapturer = created
            capturer = created
            created.initialize(helper, applicationContext, source.capturerObserver)
        } else {
            val projectionData = resultData ?: throw IllegalStateException("没有收到系统录屏授权数据")
            val screen = ScreenCapturerAndroid(projectionData, object : MediaProjection.Callback() {
                override fun onStop() {
                    if (!isStopping) stopStreaming("系统已停止屏幕共享")
                }
            })
            capturer = screen
            screen.initialize(helper, applicationContext, source.capturerObserver)
        }

        // Create/publish the track before starting capture so the Activity can
        // attach its local preview before the camera emits its first frame.
        abortIfStopped()
        val video = factory!!.createVideoTrack(if (useCamera) "conglive-camera" else "conglive-screen", source)
        videoTrack = video
        if (useCamera) CameraPreviewBridge.publish(video, egl.eglBaseContext, frontCamera)
        abortIfStopped()
        if (useCamera) cameraCapturer?.startCapture(captureWidth, captureHeight, fps)
        else capturer?.startCapture(captureWidth, captureHeight, fps)
        abortIfStopped()
        val audioConstraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
        }
        val audio = factory!!.createAudioSource(audioConstraints)
        audioSource = audio
        audioTrack = factory!!.createAudioTrack("conglive-microphone", audio).apply { setEnabled(true) }
    }

    /** Configures the capture/encoder format from the broadcast-page settings.
     * [width]/[height] are already oriented for the active source (portrait for
     * screen capture, landscape for the camera). */
    private fun prepareVideo(
        width: Int,
        height: Int,
        bitrateBps: Int,
        fps: Int,
        iFrameInterval: Int = VideoSettings.DEFAULT_IFRAME_INTERVAL
    ) {
        val source = videoSource ?: throw IllegalStateException("视频源尚未初始化")
        videoBitrateBps = bitrateBps
        videoFps = fps
        this.iFrameInterval = iFrameInterval
        // 采集尺寸由 startCapture() 指定；这里让编码端按设置的分辨率/帧率输出。
        source.adaptOutputFormat(width, height, fps)
        sendStatus("视频参数：${width}×${height} @ ${fps}fps · ${bitrateBps / 1000}kbps · 关键帧间隔 ${iFrameInterval}s")
    }

    /** Applies the configured bitrate / frame rate to the video RTP sender.
     * Android WebRTC has no public keyframe-interval API; H.264 negotiates its
     * default GOP and SRS re-encodes to RTMP for recording. */
    private fun applyVideoEncodingParameters(sender: RtpSender) {
        try {
            val parameters = sender.parameters ?: return
            if (parameters.encodings.isEmpty()) return
            parameters.encodings.forEach { encoding ->
                encoding.maxBitrateBps = videoBitrateBps
                encoding.maxFramerate = videoFps
            }
            if (!sender.setParameters(parameters)) {
                sendStatus("视频码率/帧率参数未被编码器接受，将使用默认值")
            }
        } catch (error: Exception) {
            sendStatus("应用视频码率参数失败：${error.message ?: error.javaClass.simpleName}")
        }
    }

    private fun sanitizeDimension(value: Int, fallback: Int): Int {
        val candidate = if (value <= 0) fallback else value
        // H.264 requires even dimensions.
        return (candidate.coerceIn(MIN_VIDEO_DIMENSION, MAX_VIDEO_DIMENSION) / 2) * 2
    }

    private fun negotiateWhip(signalUrl: String, authToken: String) {
        val iceServers = listOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer()
        )
        val config = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val iceComplete = CountDownLatch(1)
        abortIfStopped()
        val connection = factory?.createPeerConnection(config, object : PeerConnection.Observer {
            override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
                if (stopRequested || isStopping) return
                when (state) {
                    PeerConnection.IceConnectionState.CONNECTED, PeerConnection.IceConnectionState.COMPLETED -> sendStatus("WebRTC 推流成功 · 服务器媒体通道已连接")
                    PeerConnection.IceConnectionState.FAILED -> sendStatus("WebRTC ICE 连接失败，请检查公网候选 IP 和 UDP/TCP 8000")
                    PeerConnection.IceConnectionState.DISCONNECTED -> sendStatus("WebRTC 网络暂时断开，正在尝试恢复…")
                    else -> Unit
                }
            }
            override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
                if (state == PeerConnection.IceGatheringState.COMPLETE) iceComplete.countDown()
            }
            override fun onIceCandidate(candidate: IceCandidate) = Unit
            override fun onIceCandidatesRemoved(candidates: Array<IceCandidate>) = Unit
            override fun onAddStream(stream: org.webrtc.MediaStream) = Unit
            override fun onRemoveStream(stream: org.webrtc.MediaStream) = Unit
            override fun onDataChannel(channel: org.webrtc.DataChannel) = Unit
            override fun onRenegotiationNeeded() = Unit
            override fun onAddTrack(receiver: RtpReceiver, streams: Array<out org.webrtc.MediaStream>) = Unit
        }) ?: throw IllegalStateException("无法创建 WebRTC PeerConnection")
        peer = connection
        abortIfStopped()
        val screenTrack = videoTrack ?: throw IllegalStateException("屏幕视频轨道尚未初始化")
        connection.addTrack(screenTrack, listOf("conglive-live"))
        audioTrack?.let { connection.addTrack(it, listOf("conglive-live")) }
        abortIfStopped()

        // SRS RTC->RTMP recording requires H.264 video. Prefer only the H.264
        // codec family (and RTX retransmission) on the sending transceiver.
        val videoTransceiver = connection.transceivers.firstOrNull {
            it.mediaType == MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO
        } ?: throw IllegalStateException("找不到视频 RTP Transceiver")
        val videoCapabilities = factory!!.getRtpSenderCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO)
        val h264Codecs = videoCapabilities.codecs.filter {
            it.mimeType.equals("video/H264", ignoreCase = true) || it.mimeType.equals("video/rtx", ignoreCase = true)
        }
        if (h264Codecs.none { it.mimeType.equals("video/H264", ignoreCase = true) }) {
            throw IllegalStateException("当前设备 WebRTC 编码器没有 H.264，请更新系统 WebView/设备 WebRTC 运行环境")
        }
        // webrtc-sdk 150.x returns RtcError (isSuccess/isError/error) instead of RtcErrorType.
        val codecError = videoTransceiver.setCodecPreferences(h264Codecs)
        if (codecError.isError()) {
            throw IllegalStateException("设置 H.264 编码优先级失败：${codecError.error()?.message ?: "未知错误"}")
        }
        applyVideoEncodingParameters(videoTransceiver.sender)
        abortIfStopped()

        var offer: SessionDescription? = null
        var createError: String? = null
        val offerLatch = CountDownLatch(1)
        connection.createOffer(object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) { offer = description; offerLatch.countDown() }
            override fun onSetSuccess() = Unit
            override fun onCreateFailure(error: String) { createError = error; offerLatch.countDown() }
            override fun onSetFailure(error: String) = Unit
        }, MediaConstraints())
        awaitLatch(offerLatch, 20_000, "创建 WebRTC SDP Offer 超时")
        val localOffer = offer ?: throw IllegalStateException("创建 SDP Offer 失败：${createError ?: "未知错误"}")

        val localSet = CountDownLatch(1)
        var localError: String? = null
        abortIfStopped()
        connection.setLocalDescription(object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) = Unit
            override fun onSetSuccess() { localSet.countDown() }
            override fun onCreateFailure(error: String) = Unit
            override fun onSetFailure(error: String) { localError = error; localSet.countDown() }
        }, localOffer)
        awaitLatch(localSet, 15_000, "设置本地 SDP 超时")
        if (localError != null) throw IllegalStateException("设置本地 SDP 失败：$localError")
        if (!awaitOrTimeout(iceComplete, 18_000)) {
            abortIfStopped()
            sendStatus("ICE 候选收集超时，继续尝试当前候选")
        }

        abortIfStopped()
        val localSdp = connection.localDescription?.description ?: throw IllegalStateException("本地 SDP 为空")
        sendStatus("正在通过 WHIP 协商媒体会话…")
        val request = Request.Builder()
            .url(signalUrl)
            .header("Authorization", "Bearer $authToken")
            .header("Accept", "application/sdp")
            .post(localSdp.toRequestBody("application/sdp".toMediaType()))
            .build()
        val call = http.newCall(request)
        pendingCall = call
        try {
            call.execute().use { response ->
                val answer = response.body?.string().orEmpty()
                abortIfStopped()
                if (!response.isSuccessful) throw IllegalStateException("WHIP HTTP ${response.code}：${answer.take(240)}")
                if (!answer.startsWith("v=0")) throw IllegalStateException("媒体服务器返回的 SDP Answer 无效")
                abortIfStopped()
                val remoteSet = CountDownLatch(1)
                var remoteError: String? = null
                connection.setRemoteDescription(object : SdpObserver {
                    override fun onCreateSuccess(description: SessionDescription) = Unit
                    override fun onSetSuccess() { remoteSet.countDown() }
                    override fun onCreateFailure(error: String) = Unit
                    override fun onSetFailure(error: String) { remoteError = error; remoteSet.countDown() }
                }, SessionDescription(SessionDescription.Type.ANSWER, answer))
                awaitLatch(remoteSet, 15_000, "设置远端 SDP 超时")
                if (remoteError != null) throw IllegalStateException("设置远端 SDP 失败：$remoteError")
            }
        } finally {
            pendingCall = null
        }
        sendStatus("WHIP 信令交换完成，正在建立媒体连接…")
    }

    private fun startCaptureForeground(useCamera: Boolean) {
        val notification = buildNotification(if (useCamera) "正在启动 WebRTC 摄像头直播" else "正在启动 WebRTC 屏幕直播")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            var types = if (useCamera) ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
                else ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            startForeground(NOTIFICATION_ID, notification, types)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !useCamera) {
            // Android 10 supports the mediaProjection type; camera type is not available until Android 11.
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun switchCamera() {
        val camera = cameraCapturer
        if (camera == null || isStopping || stopRequested) {
            sendStatus("当前不是摄像头直播")
            return
        }
        camera.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
            override fun onCameraSwitchDone(isFrontCamera: Boolean) {
                CameraPreviewBridge.setMirror(isFrontCamera)
                sendStatus(if (isFrontCamera) "已切换到前置摄像头" else "已切换到后置摄像头")
            }
            override fun onCameraSwitchError(errorDescription: String) {
                sendStatus("切换摄像头失败：$errorDescription")
            }
        })
    }

    private fun stopStreaming(message: String) {
        var worker: Thread? = null
        synchronized(stateLock) {
            if (isStopping) return
            isStopping = true
            stopRequested = true
            try {
                pendingCall?.cancel()
            } catch (_: Exception) {
            }
            worker = mediaWorker
        }
        // The media worker may still be creating native objects; let it unwind before
        // any of them is disposed. It polls stopRequested every 100 ms and the
        // in-flight WHIP HTTP call was cancelled above, so this normally returns fast.
        if (worker != null && worker !== Thread.currentThread()) {
            try {
                worker.join(8_000)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
        synchronized(stateLock) {
            releaseMediaLocked()
            mediaWorker = null
        }
        try {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } catch (_: Exception) {
        }
        sendStatus(message)
        isStarting = false
        // isStopping intentionally stays true until the next startStreaming() call so
        // late callbacks (MediaProjection, camera events, worker) cannot tear down twice.
        stopSelf()
    }

    /** Releases native WebRTC objects in dependency order. Each step is isolated so a
     * failure in one does not leak the remaining ones. The camera preview renderer is
     * released before [eglBase]: its EglRenderer was created with that shared context. */
    private fun releaseMediaLocked() {
        try {
            peer?.close()
        } catch (_: Exception) {
        }
        try {
            peer?.dispose()
        } catch (_: Exception) {
        }
        peer = null
        try {
            capturer?.stopCapture()
        } catch (_: Exception) {
        }
        try {
            capturer?.dispose()
        } catch (_: Exception) {
        }
        capturer = null
        cameraCapturer = null
        // Preview renderer must release its EGL surface while the shared context lives.
        try {
            CameraPreviewBridge.clear()
        } catch (_: Exception) {
        }
        try {
            videoTrack?.dispose()
        } catch (_: Exception) {
        }
        videoTrack = null
        try {
            audioTrack?.dispose()
        } catch (_: Exception) {
        }
        audioTrack = null
        try {
            videoSource?.dispose()
        } catch (_: Exception) {
        }
        videoSource = null
        try {
            audioSource?.dispose()
        } catch (_: Exception) {
        }
        audioSource = null
        try {
            surfaceTextureHelper?.dispose()
        } catch (_: Exception) {
        }
        surfaceTextureHelper = null
        try {
            factory?.dispose()
        } catch (_: Exception) {
        }
        factory = null
        try {
            audioModule?.release()
        } catch (_: Exception) {
        }
        audioModule = null
        try {
            eglBase?.release()
        } catch (_: Exception) {
        }
        eglBase = null
    }

    private fun abortIfStopped() {
        if (stopRequested || isStopping) throw StreamStopped()
    }

    /** Waits for [latch] while staying responsive to a stop request (polled every 100 ms). */
    private fun awaitLatch(latch: CountDownLatch, timeoutMillis: Long, timeoutMessage: String) {
        if (!awaitOrTimeout(latch, timeoutMillis)) {
            abortIfStopped()
            throw IllegalStateException(timeoutMessage)
        }
        abortIfStopped()
    }

    private fun awaitOrTimeout(latch: CountDownLatch, timeoutMillis: Long): Boolean {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis)
        while (System.nanoTime() < deadline) {
            abortIfStopped()
            if (latch.await(100, TimeUnit.MILLISECONDS)) return true
        }
        return latch.count == 0L
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "葱直播屏幕推流", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun buildNotification(message: String): Notification = NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle("葱直播")
        .setContentText(message)
        .setSmallIcon(android.R.drawable.presence_video_online)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .build()

    private fun sendStatus(message: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(message))
        }
        sendBroadcast(Intent(ACTION_STATUS).setPackage(packageName).putExtra(EXTRA_MESSAGE, message))
    }

    override fun onDestroy() {
        if (!isStopping && (peer != null || isStarting || mediaWorker != null)) {
            stopStreaming("直播服务已关闭")
        }
        http.dispatcher.executorService.shutdown()
        super.onDestroy()
    }
}
