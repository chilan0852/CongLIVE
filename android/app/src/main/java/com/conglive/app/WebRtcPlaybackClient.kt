package com.conglive.app

import android.content.Context
import org.webrtc.AudioTrack
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import android.util.Log
import org.webrtc.EglBase
import org.webrtc.RendererCommon
import org.webrtc.IceCandidate
import org.webrtc.audio.JavaAudioDeviceModule
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Native WHEP receiver for a single live stream. The renderer can be reattached
 * whenever MainActivity redraws its view hierarchy without renegotiating media.
 *
 * Threading: the signalling session runs on a dedicated thread; [close] may be
 * called concurrently from the UI thread. [close] marks the session closed,
 * cancels the in-flight HTTP call, waits for the signalling thread to unwind and
 * only then releases the native EGL/PeerConnectionFactory objects. Every native
 * object touched by the signalling thread is guarded by [lock] and re-checked
 * against [closed] so native memory is never used after release. */
class WebRtcPlaybackClient(
    context: Context,
    private val whepUrl: String,
    private val authToken: String,
    private val onStatus: (String) -> Unit,
) {
    private val appContext = context.applicationContext
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(25, TimeUnit.SECONDS)
        .build()
    private val eglBase = EglBase.create()
    private val audioModule = JavaAudioDeviceModule.builder(appContext).createAudioDeviceModule()
    private val factory: PeerConnectionFactory

    /** Guards [peer], [remoteVideo], [renderer] and the native dispose sequence. */
    private val lock = Any()
    private var peer: PeerConnection? = null
    private var remoteVideo: VideoTrack? = null
    private var renderer: SurfaceViewRenderer? = null
    @Volatile private var closed = false
    @Volatile private var sessionThread: Thread? = null
    @Volatile private var pendingCall: Call? = null

    /** Internal control-flow exception: the session was closed while it was setting up. */
    private class SessionAborted : RuntimeException()

    init {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(appContext).createInitializationOptions()
        )
        factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(audioModule)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, false))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()
    }

    fun attachRenderer(newRenderer: SurfaceViewRenderer) {
        synchronized(lock) {
            if (closed) return
            if (renderer === newRenderer) {
                newRenderer.setMirror(false)
                return
            }
            val previous = renderer
            // Initialize the new renderer before it receives frames so the first
            // frame is never dropped, then swap the sink and release the old one.
            newRenderer.init(eglBase.eglBaseContext, object : RendererCommon.RendererEvents {
            override fun onFirstFrameRendered() {
                Log.i("CongLive", "whep first frame rendered")
                if (!closed) onStatus("已收到视频首帧")
            }
            override fun onFrameResolutionChanged(width: Int, height: Int, rotation: Int) {
                Log.i("CongLive", "whep frame ${width}x${height} rotation=$rotation")
            }
        })
            newRenderer.setEnableHardwareScaler(true)
            newRenderer.setMirror(false)
            renderer = newRenderer
            remoteVideo?.addSink(newRenderer)
            if (previous != null) {
                try {
                    remoteVideo?.removeSink(previous)
                } catch (_: Exception) {
                }
                try {
                    previous.release()
                } catch (_: Exception) {
                }
            }
        }
    }

    fun start() {
        synchronized(lock) {
            if (closed || sessionThread != null) return
            val thread = Thread({ runSession() }, "CongLive-WhepPlayback").apply { isDaemon = true }
            sessionThread = thread
            thread.start()
        }
    }

    private fun runSession() {
        try {
            val servers = listOf(
                PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer()
            )
            val config = PeerConnection.RTCConfiguration(servers).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            }
            val iceGatheringComplete = CountDownLatch(1)
            val connection = synchronized(lock) {
                abortIfClosed()
                factory.createPeerConnection(config, createObserver(iceGatheringComplete))
            } ?: throw IllegalStateException("无法创建 WebRTC 播放连接")
            synchronized(lock) {
                if (closed) {
                    connection.close()
                    connection.dispose()
                    throw SessionAborted()
                }
                peer = connection
            }

            connection.addTransceiver(
                org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO,
                RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.RECV_ONLY)
            )
            connection.addTransceiver(
                org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO,
                RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.RECV_ONLY)
            )

            var offer: SessionDescription? = null
            var createError: String? = null
            val createLatch = CountDownLatch(1)
            abortIfClosed()
            connection.createOffer(object : SdpObserver {
                override fun onCreateSuccess(description: SessionDescription) {
                    offer = description
                    createLatch.countDown()
                }

                override fun onSetSuccess() = Unit
                override fun onCreateFailure(message: String) {
                    createError = message
                    createLatch.countDown()
                }

                override fun onSetFailure(message: String) = Unit
            }, MediaConstraints())
            awaitLatch(createLatch, 20_000, "创建 WHEP Offer 超时")
            val localOffer = offer ?: throw IllegalStateException("创建 WHEP Offer 失败：${createError ?: "未知错误"}")

            var localError: String? = null
            val localLatch = CountDownLatch(1)
            abortIfClosed()
            connection.setLocalDescription(object : SdpObserver {
                override fun onCreateSuccess(description: SessionDescription) = Unit
                override fun onSetSuccess() {
                    localLatch.countDown()
                }

                override fun onCreateFailure(message: String) = Unit
                override fun onSetFailure(message: String) {
                    localError = message
                    localLatch.countDown()
                }
            }, localOffer)
            awaitLatch(localLatch, 15_000, "设置本地 SDP 超时")
            if (localError != null) throw IllegalStateException("本地 SDP 失败：$localError")
            if (!awaitOrTimeout(iceGatheringComplete, 15_000)) {
                abortIfClosed()
                onStatus("ICE 候选收集超时，继续尝试当前候选")
            }

            abortIfClosed()
            val localSdp = synchronized(lock) {
                abortIfClosed()
                connection.localDescription?.description
            } ?: throw IllegalStateException("本地 SDP 为空")
            val request = Request.Builder().url(whepUrl)
                .header("Authorization", "Bearer $authToken")
                .header("Accept", "application/sdp")
                .post(localSdp.toRequestBody("application/sdp".toMediaType())).build()
            val answer = executeWhep(request)

            var remoteError: String? = null
            val remoteLatch = CountDownLatch(1)
            abortIfClosed()
            connection.setRemoteDescription(object : SdpObserver {
                override fun onCreateSuccess(description: SessionDescription) = Unit
                override fun onSetSuccess() {
                    remoteLatch.countDown()
                }

                override fun onCreateFailure(message: String) = Unit
                override fun onSetFailure(message: String) {
                    remoteError = message
                    remoteLatch.countDown()
                }
            }, SessionDescription(SessionDescription.Type.ANSWER, answer))
            awaitLatch(remoteLatch, 15_000, "设置远端 SDP 超时")
            if (remoteError != null) throw IllegalStateException("远端 SDP 失败：$remoteError")
            if (!closed) onStatus("WHEP 信令已完成，正在连接媒体…")
        } catch (_: SessionAborted) {
            // close() was requested while negotiating; close() owns the cleanup.
        } catch (exception: Exception) {
            if (!closed) onStatus("WebRTC 播放失败：${exception.message ?: exception.javaClass.simpleName}")
        } finally {
            sessionThread = null
        }
    }

    private fun createObserver(iceGatheringComplete: CountDownLatch) = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            if (closed) return
            onStatus(
                when (state) {
                    PeerConnection.IceConnectionState.CONNECTED,
                    PeerConnection.IceConnectionState.COMPLETED -> "WebRTC 已连接 · 低延迟播放中"

                    PeerConnection.IceConnectionState.FAILED -> "WebRTC ICE 失败，请检查候选 IP 和 8000 端口"
                    PeerConnection.IceConnectionState.DISCONNECTED -> "WebRTC 播放暂时断开"
                    else -> "WebRTC：${state.name}"
                }
            )
        }

        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
            if (state == PeerConnection.IceGatheringState.COMPLETE) iceGatheringComplete.countDown()
        }

        override fun onIceCandidate(candidate: IceCandidate) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<IceCandidate>) = Unit
        override fun onAddStream(stream: org.webrtc.MediaStream) {
            if (closed) return
            stream.videoTracks.firstOrNull()?.let(::attachRemoteVideo)
            stream.audioTracks.forEach { it.setEnabled(true) }
        }

        override fun onRemoveStream(stream: org.webrtc.MediaStream) = Unit
        override fun onDataChannel(channel: org.webrtc.DataChannel) = Unit
        override fun onRenegotiationNeeded() = Unit
        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out org.webrtc.MediaStream>) {
            if (closed) return
            val track = receiver.track()
            if (track is VideoTrack) attachRemoteVideo(track)
            if (track is AudioTrack) track.setEnabled(true)
        }

        override fun onTrack(transceiver: RtpTransceiver) {
            if (closed) return
            val track = transceiver.receiver.track()
            if (track is VideoTrack) attachRemoteVideo(track)
            if (track is AudioTrack) track.setEnabled(true)
        }
    }

    private fun attachRemoteVideo(track: VideoTrack) {
        synchronized(lock) {
            if (closed) return
            val previous = remoteVideo
            val target = renderer
            if (previous != null && target != null && previous !== track) {
                try {
                    previous.removeSink(target)
                } catch (_: Exception) {
                }
            }
            remoteVideo = track
            if (target != null && previous !== track) target.let(track::addSink)
        }
    }

    private fun abortIfClosed() {
        if (closed) throw SessionAborted()
    }

    /** Waits for [latch] while staying responsive to [close] (checked every 100 ms). */
    private fun awaitLatch(latch: CountDownLatch, timeoutMillis: Long, timeoutMessage: String) {
        if (!awaitOrTimeout(latch, timeoutMillis)) {
            abortIfClosed()
            throw IllegalStateException(timeoutMessage)
        }
        abortIfClosed()
    }

    private fun awaitOrTimeout(latch: CountDownLatch, timeoutMillis: Long): Boolean {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis)
        while (System.nanoTime() < deadline) {
            if (closed) throw SessionAborted()
            if (latch.await(100, TimeUnit.MILLISECONDS)) return true
        }
        return latch.count == 0L
    }

    private fun executeWhep(request: Request): String {
        abortIfClosed()
        val call = http.newCall(request)
        pendingCall = call
        try {
            call.execute().use { response ->
                val answer = response.body?.string().orEmpty()
                abortIfClosed()
                if (!response.isSuccessful) throw IllegalStateException("WHEP HTTP ${response.code}：${answer.take(240)}")
                if (!answer.startsWith("v=0")) throw IllegalStateException("服务器 SDP Answer 无效")
                return answer
            }
        } finally {
            pendingCall = null
        }
    }

    fun close() {
        var thread: Thread? = null
        synchronized(lock) {
            if (closed) return
            closed = true
            try {
                pendingCall?.cancel()
            } catch (_: Exception) {
            }
            thread = sessionThread
        }
        // Wait outside the lock: the signalling thread needs it to notice `closed`.
        if (thread != null && thread !== Thread.currentThread()) {
            try {
                thread.join(8_000)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
        synchronized(lock) {
            val track = remoteVideo
            remoteVideo = null
            val view = renderer
            renderer = null
            if (track != null && view != null) {
                try {
                    track.removeSink(view)
                } catch (_: Exception) {
                }
            }
            try {
                view?.release()
            } catch (_: Exception) {
            }
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
                factory.dispose()
            } catch (_: Exception) {
            }
            try {
                audioModule.release()
            } catch (_: Exception) {
            }
            try {
                eglBase.release()
            } catch (_: Exception) {
            }
        }
        try {
            http.dispatcher.executorService.shutdown()
        } catch (_: Exception) {
        }
        sessionThread = null
    }
}
