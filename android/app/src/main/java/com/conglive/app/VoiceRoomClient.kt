package com.conglive.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RTCStatsCollectorCallback
import org.webrtc.RTCStatsReport
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.audio.JavaAudioDeviceModule
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** v0.8.0 voice-room state, mirrored from the web client (`web/src/voice.ts`). */
enum class VoicePhase { IDLE, CONNECTING, JOINING, JOINED, ERROR }

enum class VoicePeerState { CONNECTING, CONNECTED, FAILED }

data class VoicePeerInfo(
    val peerId: String,
    val userId: Long,
    val username: String
)

/** Immutable UI snapshot; the Activity only rebuilds the voice card when this changes. */
data class VoiceSnapshot(
    val phase: VoicePhase = VoicePhase.IDLE,
    val self: VoicePeerInfo? = null,
    val peers: List<VoicePeerInfo> = emptyList(),
    val peerStates: Map<String, VoicePeerState> = emptyMap(),
    val muted: Boolean = false,
    val localLevel: Float = 0f,
    val speaking: Map<String, Boolean> = emptyMap(),
    val error: String? = null
)

/**
 * Full-duplex audio-only mesh for the standalone room page (v0.8.0).
 *
 * Signaling reuse the already authenticated room `/ws/chat` WebSocket through
 * [sendSignal]; the message formats match `web/src/voice.ts` / `backend/src/voice.js`:
 *
 *   C→S: voice-join | voice-leave | voice-offer {target} | voice-answer {target}
 *        | voice-candidate {target, candidate|null}
 *   S→C: voice-peers {self, peers} | voice-peer-joined {peer}
 *        | voice-peer-left {peer} | voice-offer/answer/candidate {from}
 *        | voice-error {code, message}
 *
 * The microphone is captured in [join] only; no PeerConnection, AudioSource or
 * AudioTrack exists before that. Every remote participant gets one audio-only
 * PeerConnection that publishes the same local microphone track; remote audio
 * tracks are played by the WebRTC AudioDeviceModule, so the existing WHEP player
 * keeps its own independent audio path. [leave]/[dispose] send voice-leave and
 * release every PeerConnection, track and native object.
 */
class VoiceRoomClient(
    context: Context,
    private val sendSignal: (JSONObject) -> Boolean,
    private val lang: Lang = L10n.read(context),
    private val onUpdate: (VoiceSnapshot) -> Unit,
) {
    companion object {
        private const val STATS_INTERVAL_MS = 500L
        private const val SPEAKING_THRESHOLD = 0.06f
        private const val ENERGY_SPEAKING_THRESHOLD = 0.0004
        private const val STUN_URL = "stun:stun.l.google.com:19302"
        private const val AUDIO_TRACK_ID = "conglive-voice-mic"
        private const val AUDIO_STREAM_ID = "conglive-voice"
        /** Upper bound for one SDP callback so a leave cannot block the worker forever. */
        private const val SDP_TIMEOUT_SECONDS = 6L
    }

    private fun tr(key: String, vararg args: Any?): String = L10n.t(lang, key, *args)

    private val appContext = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    private val worker: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "CongLive-Voice").apply { isDaemon = true }
    }
    private val lock = Any()

    private var snapshot = VoiceSnapshot()
    @Volatile private var phase = VoicePhase.IDLE
    private var muted = false
    /** v0.8.0: raw microphone RMS level (0..1) from the ADM PCM callback. */
    @Volatile private var micLevel = 0f
    @Volatile private var disposed = false

    /** Bumped by join/leave so stale worker continuations can bail out. */
    @Volatile private var generation = 0

    // Native WebRTC objects, created in join() and released in releaseNative().
    private var eglBase: EglBase? = null
    private var audioModule: JavaAudioDeviceModule? = null
    private var factory: PeerConnectionFactory? = null
    private var audioSource: AudioSource? = null
    private var localTrack: AudioTrack? = null
    private var selfInfo: VoicePeerInfo? = null

    private val peers = java.util.concurrent.ConcurrentHashMap<String, PeerSession>()
    private val previousEnergy = java.util.concurrent.ConcurrentHashMap<String, Double>()
    private var statsRunnable: Runnable? = null

    /** PeerConnection per remote participant plus its signaling bookkeeping. */
    private inner class PeerSession(val info: VoicePeerInfo) {
        lateinit var pc: PeerConnection
        @Volatile var state: VoicePeerState = VoicePeerState.CONNECTING
        var hasRemoteDescription = false
        var remoteTrack: AudioTrack? = null
        val pendingCandidates = mutableListOf<IceCandidate?>()
    }

    // ------------------------------------------------------------------
    // Public API (called from the Activity / UI thread)
    // ------------------------------------------------------------------

    fun isActive(): Boolean = phase != VoicePhase.IDLE

    fun currentPhase(): VoicePhase = phase

    /**
     * Requests microphone capture and joins the room. Called only after the
     * Activity granted RECORD_AUDIO, and only when the authenticated room
     * WebSocket is ready.
     */
    fun join() {
        if (disposed) return
        if (phase == VoicePhase.CONNECTING || phase == VoicePhase.JOINING || phase == VoicePhase.JOINED) return
        val gen = synchronized(lock) {
            generation += 1
            generation
        }
        phase = VoicePhase.CONNECTING
        publish(VoiceSnapshot(phase = VoicePhase.CONNECTING, muted = muted))
        worker.execute {
            if (generation != gen || disposed) return@execute
            try {
                synchronized(lock) { createAudioLocked() }
                if (generation != gen || disposed) {
                    releaseNative()
                    return@execute
                }
                if (!send(JSONObject().put("type", "voice-join"))) {
                    fail(tr("voice.error.connectFailed"))
                    return@execute
                }
                phase = VoicePhase.JOINING
                publish(VoiceSnapshot(phase = VoicePhase.JOINING, muted = muted))
            } catch (error: Exception) {
                if (generation == gen && !disposed) {
                    fail(describeCaptureFailure(error))
                }
            }
        }
    }

    /** Leaves the voice room: sends voice-leave and releases everything (idempotent). */
    fun leave() {
        if (disposed) return
        val wasActive = phase != VoicePhase.IDLE
        synchronized(lock) { generation += 1 }
        if (wasActive) send(JSONObject().put("type", "voice-leave"))
        phase = VoicePhase.IDLE
        stopStatsPolling()
        releaseNativeAsync()
        if (wasActive) publish(VoiceSnapshot(phase = VoicePhase.IDLE, muted = muted))
    }

    /** Final teardown used by the Activity when the room page is destroyed. */
    fun dispose() {
        if (disposed) return
        // Send voice-leave while our caller's socket may still be open, then release.
        if (phase != VoicePhase.IDLE) send(JSONObject().put("type", "voice-leave"))
        disposed = true
        phase = VoicePhase.IDLE
        stopStatsPolling()
        mainHandler.removeCallbacksAndMessages(null)
        releaseNativeAsync()
        try {
            worker.shutdown()
        } catch (_: Exception) {
        }
    }

    fun toggleMute(): Boolean {
        muted = !muted
        try {
            localTrack?.setEnabled(!muted)
        } catch (_: Exception) {
        }
        publish(
            snapshot.copy(
                muted = muted,
                localLevel = if (muted) 0f else snapshot.localLevel
            )
        )
        return muted
    }

    // ------------------------------------------------------------------
    // Signaling entry point (called from the room WebSocket listener)
    // ------------------------------------------------------------------

    /** Routes one `voice-*` message; safe to call from the WebSocket thread. */
    fun handleSignal(data: JSONObject) {
        if (disposed) return
        val gen = generation
        worker.execute {
            if (disposed || generation != gen) return@execute
            if (phase == VoicePhase.IDLE || phase == VoicePhase.ERROR) return@execute
            try {
                handleSignalLocked(data)
            } catch (error: Exception) {
                publish(snapshot.copy(error = tr("voice.error.signal")))
            }
        }
    }

    private fun handleSignalLocked(data: JSONObject) {
        when (data.optString("type")) {
            "voice-peers" -> handlePeers(data)
            "voice-peer-joined" -> {
                val peer = parsePeer(data.optJSONObject("peer")) ?: return
                if (peer.peerId == selfInfo?.peerId) return
                ensurePeer(peer)
                // Glare-free mesh: only the lexicographically smaller peerId offers.
                val self = selfInfo
                if (self != null && self.peerId < peer.peerId) initiateOffer(peer.peerId)
                publishJoined()
            }
            "voice-peer-left" -> {
                val peer = parsePeer(data.optJSONObject("peer")) ?: return
                removePeer(peer.peerId)
                publishJoined()
            }
            "voice-offer" -> handleOffer(data)
            "voice-answer" -> handleAnswer(data)
            "voice-candidate" -> handleCandidate(data)
            "voice-error" -> {
                val code = data.optString("code")
                publish(snapshot.copy(error = signalErrorText(code, data.optString("message"))))
            }
            else -> Unit
        }
    }

    private fun handlePeers(data: JSONObject) {
        val self = parsePeer(data.optJSONObject("self"))
        if (self != null) selfInfo = self
        phase = VoicePhase.JOINED
        val incoming = mutableListOf<VoicePeerInfo>()
        val array = data.optJSONArray("peers")
        if (array != null) {
            for (i in 0 until array.length()) {
                parsePeer(array.optJSONObject(i))?.let { incoming.add(it) }
            }
        }
        val selfPeerId = selfInfo?.peerId
        incoming.forEach { peer ->
            if (peer.peerId == selfPeerId) return@forEach
            ensurePeer(peer)
            if (selfPeerId != null && selfPeerId < peer.peerId) initiateOffer(peer.peerId)
        }
        publishJoined()
        mainHandler.post { startStatsPolling() }
    }

    // ------------------------------------------------------------------
    // SDP / ICE
    // ------------------------------------------------------------------

    private fun ensurePeer(info: VoicePeerInfo): PeerSession? {
        peers[info.peerId]?.let { return it }
        val pcFactory = factory ?: return null
        val local = localTrack
        val iceServer = PeerConnection.IceServer.builder(STUN_URL).createIceServer()
        val config = PeerConnection.RTCConfiguration(listOf(iceServer)).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val session = PeerSession(info)
        val connection = try {
            pcFactory.createPeerConnection(config, createObserver(session))
        } catch (_: Exception) {
            null
        } ?: return null
        session.pc = connection
        peers[info.peerId] = session
        if (local != null) {
            try {
                connection.addTrack(local, listOf(AUDIO_STREAM_ID))
            } catch (_: Exception) {
            }
        }
        return session
    }

    private fun initiateOffer(peerId: String) {
        val session = peers[peerId] ?: return
        val pc = session.pc
        if (pc.signalingState() != PeerConnection.SignalingState.STABLE) return
        val offer = createOfferBlocking(pc) ?: return
        if (!setLocalDescriptionBlocking(pc, offer)) return
        val sdp = pc.localDescription?.description ?: offer.description
        sendSdp("voice-offer", peerId, "offer", sdp)
    }

    private fun handleOffer(data: JSONObject) {
        val from = parsePeer(data.optJSONObject("from")) ?: return
        val sdp = sdpText(data.opt("sdp")) ?: return
        val session = ensurePeer(from) ?: return
        // The smaller peerId always offers; ignore a conflicting offer in glare.
        if (session.pc.signalingState() != PeerConnection.SignalingState.STABLE) return
        if (!setRemoteDescriptionBlocking(session.pc, SessionDescription(SessionDescription.Type.OFFER, sdp))) return
        session.hasRemoteDescription = true
        flushCandidates(session)
        val answer = createAnswerBlocking(session.pc) ?: return
        if (!setLocalDescriptionBlocking(session.pc, answer)) return
        val answerSdp = session.pc.localDescription?.description ?: answer.description
        sendSdp("voice-answer", from.peerId, "answer", answerSdp)
    }

    private fun handleAnswer(data: JSONObject) {
        val from = parsePeer(data.optJSONObject("from")) ?: return
        val sdp = sdpText(data.opt("sdp")) ?: return
        val session = peers[from.peerId] ?: return
        if (session.pc.signalingState() != PeerConnection.SignalingState.HAVE_LOCAL_OFFER) return
        if (!setRemoteDescriptionBlocking(session.pc, SessionDescription(SessionDescription.Type.ANSWER, sdp))) return
        session.hasRemoteDescription = true
        flushCandidates(session)
    }

    private fun handleCandidate(data: JSONObject) {
        val from = parsePeer(data.optJSONObject("from")) ?: return
        val session = peers[from.peerId] ?: return
        val candidate = parseCandidate(data.opt("candidate"))
        if (!session.hasRemoteDescription) {
            session.pendingCandidates.add(candidate)
            return
        }
        try {
            session.pc.addIceCandidate(candidate)
        } catch (_: Exception) {
        }
    }

    private fun flushCandidates(session: PeerSession) {
        val pending = session.pendingCandidates.toList()
        session.pendingCandidates.clear()
        pending.forEach { candidate ->
            try {
                session.pc.addIceCandidate(candidate)
            } catch (_: Exception) {
            }
        }
    }

    private fun sendSdp(type: String, target: String, sdpType: String, sdp: String) {
        if (sdp.isBlank()) return
        send(
            JSONObject()
                .put("type", type)
                .put("target", target)
                .put("sdp", JSONObject().put("type", sdpType).put("sdp", sdp))
        )
    }

    private fun send(payload: JSONObject): Boolean = try {
        sendSignal(payload)
    } catch (_: Exception) {
        false
    }

    private fun createObserver(session: PeerSession) = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            when (state) {
                PeerConnection.IceConnectionState.CONNECTED,
                PeerConnection.IceConnectionState.COMPLETED -> updatePeerState(session, VoicePeerState.CONNECTED)

                PeerConnection.IceConnectionState.FAILED -> updatePeerState(session, VoicePeerState.FAILED)
                PeerConnection.IceConnectionState.DISCONNECTED -> updatePeerState(session, VoicePeerState.CONNECTING)
                else -> Unit
            }
        }

        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit
        override fun onIceCandidate(candidate: IceCandidate) {
            if (disposed) return
            val target = session.info.peerId
            val payload = JSONObject()
                .put("type", "voice-candidate")
                .put("target", target)
                .put(
                    "candidate",
                    JSONObject()
                        .put("candidate", candidate.sdp ?: "")
                        .put("sdpMid", candidate.sdpMid ?: JSONObject.NULL)
                        .put("sdpMLineIndex", candidate.sdpMLineIndex)
                )
            send(payload)
        }

        override fun onIceCandidatesRemoved(candidates: Array<IceCandidate>) = Unit
        override fun onAddStream(stream: org.webrtc.MediaStream) = Unit
        override fun onRemoveStream(stream: org.webrtc.MediaStream) = Unit
        override fun onDataChannel(channel: org.webrtc.DataChannel) = Unit
        override fun onRenegotiationNeeded() = Unit
        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out org.webrtc.MediaStream>) {
            attachRemoteAudio(session, receiver.track())
        }

        override fun onTrack(transceiver: RtpTransceiver) {
            attachRemoteAudio(session, transceiver.receiver.track())
        }
    }

    /** Remote audio is played by the WebRTC AudioDeviceModule; keep only the track ref. */
    private fun attachRemoteAudio(session: PeerSession, track: MediaStreamTrack?) {
        if (track is AudioTrack) {
            session.remoteTrack = track
            try {
                track.setEnabled(true)
            } catch (_: Exception) {
            }
        }
    }

    private fun updatePeerState(session: PeerSession, state: VoicePeerState) {
        if (session.state == state) return
        session.state = state
        publishJoined()
    }

    private fun removePeer(peerId: String) {
        val session = peers.remove(peerId) ?: return
        try {
            session.pc.close()
        } catch (_: Exception) {
        }
        try {
            session.pc.dispose()
        } catch (_: Exception) {
        }
        try {
            session.remoteTrack?.setEnabled(false)
        } catch (_: Exception) {
        }
        session.remoteTrack = null
    }

    // ------------------------------------------------------------------
    // Blocking SDP helpers (run on the dedicated voice worker)
    // ------------------------------------------------------------------

    private fun createOfferBlocking(pc: PeerConnection): SessionDescription? {
        var result: SessionDescription? = null
        val latch = CountDownLatch(1)
        pc.createOffer(object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) {
                result = description
                latch.countDown()
            }

            override fun onSetSuccess() = Unit
            override fun onCreateFailure(message: String) = latch.countDown()
            override fun onSetFailure(message: String) = Unit
        }, MediaConstraints())
        return if (awaitLatch(latch)) result else null
    }

    private fun createAnswerBlocking(pc: PeerConnection): SessionDescription? {
        var result: SessionDescription? = null
        val latch = CountDownLatch(1)
        pc.createAnswer(object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) {
                result = description
                latch.countDown()
            }

            override fun onSetSuccess() = Unit
            override fun onCreateFailure(message: String) = latch.countDown()
            override fun onSetFailure(message: String) = Unit
        }, MediaConstraints())
        return if (awaitLatch(latch)) result else null
    }

    private fun setLocalDescriptionBlocking(pc: PeerConnection, description: SessionDescription): Boolean {
        val latch = CountDownLatch(1)
        var ok = false
        pc.setLocalDescription(object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) = Unit
            override fun onSetSuccess() {
                ok = true
                latch.countDown()
            }

            override fun onCreateFailure(message: String) = Unit
            override fun onSetFailure(message: String) = latch.countDown()
        }, description)
        return awaitLatch(latch) && ok
    }

    private fun setRemoteDescriptionBlocking(pc: PeerConnection, description: SessionDescription): Boolean {
        val latch = CountDownLatch(1)
        var ok = false
        pc.setRemoteDescription(object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) = Unit
            override fun onSetSuccess() {
                ok = true
                latch.countDown()
            }

            override fun onCreateFailure(message: String) = Unit
            override fun onSetFailure(message: String) = latch.countDown()
        }, description)
        return awaitLatch(latch) && ok
    }

    private fun awaitLatch(latch: CountDownLatch): Boolean = try {
        latch.await(SDP_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        false
    }

    // ------------------------------------------------------------------
    // Microphone capture
    // ------------------------------------------------------------------

    /** Creates the audio device module + local microphone track (join only). */
    private fun createAudioLocked() {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(appContext).createInitializationOptions()
        )
        val egl = EglBase.create()
        eglBase = egl
        val admBuilder = JavaAudioDeviceModule.builder(appContext)
        admBuilder.setAudioRecordErrorCallback(object : JavaAudioDeviceModule.AudioRecordErrorCallback {
            override fun onWebRtcAudioRecordInitError(errorMessage: String) = reportMicError(errorMessage)
            override fun onWebRtcAudioRecordStartError(
                errorCode: JavaAudioDeviceModule.AudioRecordStartErrorCode,
                errorMessage: String
            ) = reportMicError(errorMessage)
            override fun onWebRtcAudioRecordError(errorMessage: String) = reportMicError(errorMessage)
        })
        // PCM samples give an accurate local level without a second AudioRecord.
        admBuilder.setSamplesReadyCallback(object : JavaAudioDeviceModule.SamplesReadyCallback {
            override fun onWebRtcAudioRecordSamplesReady(samples: JavaAudioDeviceModule.AudioSamples) =
                updateMicLevel(samples)
        })
        val adm = admBuilder.createAudioDeviceModule()
        audioModule = adm
        val pcFactory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(adm)
            // Audio-only mesh, but the factory needs valid video factories to build.
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, false))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()
        factory = pcFactory
        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true"))
        }
        val source = pcFactory.createAudioSource(constraints)
        audioSource = source
        val track = pcFactory.createAudioTrack(AUDIO_TRACK_ID, source)
        localTrack = track
        track.setEnabled(!muted)
    }

    /** Maps native capture problems to the voice-room dictionary. */
    private fun describeCaptureFailure(error: Exception): String {
        val detail = error.message ?: error.javaClass.simpleName
        val text = detail.lowercase()
        return when {
            "permission" in text || "not allowed" in text || "security" in text -> tr("voice.error.micDenied")
            "no such device" in text || "not found" in text || "no audio" in text -> tr("voice.error.micNotFound")
            "busy" in text || "in use" in text || "unavailable" in text -> tr("voice.error.micBusy")
            else -> tr("voice.error.micFailed", detail)
        }
    }

    /** v0.8.0: PCM RMS from the ADM drives the local microphone level. */
    private fun updateMicLevel(samples: JavaAudioDeviceModule.AudioSamples) {
        if (disposed || muted) {
            micLevel = 0f
            return
        }
        val data = samples.data
        if (data.size < 2) return
        val buffer = java.nio.ByteBuffer.wrap(data).order(java.nio.ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        var sum = 0.0
        var count = 0
        while (buffer.hasRemaining() && count < 2048) {
            val sample = buffer.get() / 32768.0
            sum += sample * sample
            count++
        }
        if (count <= 0) return
        micLevel = (kotlin.math.sqrt(sum / count) * 4.0).toFloat().coerceIn(0f, 1f)
    }

    /** AudioRecord init/start/runtime errors are surfaced in the voice panel. */
    private fun reportMicError(errorMessage: String) {
        if (disposed) return
        publish(snapshot.copy(error = describeCaptureFailure(RuntimeException(errorMessage))))
    }

    // ------------------------------------------------------------------
    // Speaking levels (500 ms getStats poll + PCM mic level)
    // ------------------------------------------------------------------

    private fun startStatsPolling() {
        stopStatsPolling()
        if (disposed || phase != VoicePhase.JOINED) return
        val runnable = object : Runnable {
            override fun run() {
                if (disposed || phase != VoicePhase.JOINED) return
                pollLevels()
                mainHandler.postDelayed(this, STATS_INTERVAL_MS)
            }
        }
        statsRunnable = runnable
        mainHandler.postDelayed(runnable, STATS_INTERVAL_MS)
    }

    private fun stopStatsPolling() {
        statsRunnable?.let { mainHandler.removeCallbacks(it) }
        statsRunnable = null
    }

    private fun pollLevels() {
        val sessions = try {
            synchronized(lock) { peers.values.toList() }
        } catch (_: Exception) {
            return
        }
        if (sessions.isEmpty()) return
        val pending = AtomicInteger(sessions.size)
        val speaking = mutableMapOf<String, Boolean>()
        val finish = {
            if (pending.decrementAndGet() == 0 && !disposed) {
                val nextLocal = if (muted) 0f else micLevel
                if (speaking != snapshot.speaking || kotlin.math.abs(nextLocal - snapshot.localLevel) > 0.04f) {
                    publish(snapshot.copy(speaking = speaking.toMap(), localLevel = nextLocal))
                }
            }
        }
        sessions.forEach { session ->
            try {
                session.pc.getStats(object : RTCStatsCollectorCallback {
                    override fun onStatsDelivered(report: RTCStatsReport) {
                        try {
                            val inboundLevel = audioLevel(report, "inbound-rtp")
                            if (inboundLevel != null) {
                                speaking[session.info.peerId] = inboundLevel > SPEAKING_THRESHOLD
                            }
                        } catch (_: Exception) {
                        } finally {
                            finish()
                        }
                    }
                })
            } catch (_: Exception) {
                finish()
            }
        }
    }

    /**
     * Reads the audio level (0..1) of the first audio `inbound-rtp`/`outbound-rtp`
     * stats entry; falls back to the `totalAudioEnergy` delta when the SDK does
     * not expose `audioLevel`.
     */
    private fun audioLevel(report: RTCStatsReport, type: String): Float? {
        for (stats in report.statsMap.values) {
            if (stats.type != type) continue
            val members = stats.members
            val kind = (members["kind"] as? String) ?: (members["mediaType"] as? String)
            if (kind != "audio") continue
            val level = (members["audioLevel"] as? Number)?.toFloat()
            if (level != null) return level.coerceIn(0f, 1f)
            val energy = (members["totalAudioEnergy"] as? Number)?.toDouble() ?: continue
            val key = type + ":" + stats.id
            val previous = previousEnergy[key] ?: 0.0
            previousEnergy[key] = energy
            val delta = energy - previous
            return if (delta > ENERGY_SPEAKING_THRESHOLD) 1f else 0f
        }
        return null
    }

    // ------------------------------------------------------------------
    // Snapshot publishing / teardown
    // ------------------------------------------------------------------

    private fun fail(message: String) {
        phase = VoicePhase.ERROR
        stopStatsPolling()
        publish(VoiceSnapshot(phase = VoicePhase.ERROR, muted = muted, error = message))
        releaseNativeAsync()
    }

    private fun publishJoined() {
        val states = mutableMapOf<String, VoicePeerState>()
        val infos = mutableListOf<VoicePeerInfo>()
        peers.forEach { (peerId, session) ->
            states[peerId] = session.state
            infos.add(session.info)
        }
        publish(
            snapshot.copy(
                phase = if (phase == VoicePhase.ERROR) phase else VoicePhase.JOINED,
                self = selfInfo,
                peers = infos,
                peerStates = states
            )
        )
    }

    private fun publish(next: VoiceSnapshot) {
        snapshot = next
        if (disposed) return
        mainHandler.post { if (!disposed) onUpdate(next) }
    }

    /** Releases native objects after the currently queued signaling task finished. */
    private fun releaseNativeAsync() {
        try {
            worker.execute { releaseNative() }
        } catch (_: Exception) {
            releaseNative()
        }
    }

    private fun releaseNative() {
        stopStatsPolling()
        synchronized(lock) {
            val sessions = peers.values.toList()
            peers.clear()
            previousEnergy.clear()
            micLevel = 0f
            sessions.forEach { session ->
                try {
                    session.pc.close()
                } catch (_: Exception) {
                }
                try {
                    session.pc.dispose()
                } catch (_: Exception) {
                }
                session.remoteTrack = null
            }
            try {
                localTrack?.setEnabled(false)
            } catch (_: Exception) {
            }
            try {
                localTrack?.dispose()
            } catch (_: Exception) {
            }
            localTrack = null
            try {
                audioSource?.dispose()
            } catch (_: Exception) {
            }
            audioSource = null
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
            selfInfo = null
        }
    }

    // ------------------------------------------------------------------
    // JSON helpers
    // ------------------------------------------------------------------

    private fun parsePeer(obj: JSONObject?): VoicePeerInfo? {
        if (obj == null || obj == JSONObject.NULL) return null
        val peerId = obj.optString("peerId", "")
        if (peerId.isBlank()) return null
        return VoicePeerInfo(peerId, obj.optLong("userId", 0L), obj.optString("username", ""))
    }

    private fun sdpText(value: Any?): String? = when (value) {
        is String -> value.ifBlank { null }
        is JSONObject -> value.optString("sdp", "").ifBlank { null }
        else -> null
    }

    private fun parseCandidate(value: Any?): IceCandidate? = when (value) {
        null, JSONObject.NULL -> null
        is String -> if (value.isBlank()) null else IceCandidate("", 0, value)
        is JSONObject -> {
            val raw = value.optString("candidate", "")
            if (raw.isBlank()) null
            else IceCandidate(
                value.opt("sdpMid") as? String,
                value.optInt("sdpMLineIndex", 0),
                raw
            )
        }
        else -> null
    }

    private fun signalErrorText(code: String, message: String): String = when (code) {
        "not-joined" -> tr("voice.error.notJoined")
        "target-not-found" -> tr("voice.error.targetLeft")
        "invalid-payload", "invalid-target", "unknown-message" -> tr("voice.error.invalidSignal")
        "sdp-too-long", "candidate-too-long" -> tr("voice.error.signalTooLarge")
        "rate-limited" -> tr("voice.error.rateLimited")
        "invalid-session" -> tr("voice.error.auth")
        else -> if (message.isNotBlank()) L10n.serverError(lang, message) else tr("voice.error.signal")
    }
}
