package com.conglive.app

import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.MediaSyncEvent
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

/**
 * v0.8.3 (experimental): microphone + system-audio mixer for screen streaming.
 *
 * The `super` AudioRecord is a normal microphone recorder. A second AudioRecord
 * created with AudioPlaybackCaptureConfiguration (screen/app playback, USAGE_MEDIA
 * etc.) is passed in as [systemRecord]. Reads block on the microphone like before,
 * then non-blockingly drain the system recorder and return a 16-bit PCM mono mix:
 *
 *   mixed = clamp(mic * MIC_GAIN + system * SYSTEM_GAIN)
 *
 * When the system recorder has no data (or fails/never starts) the untouched
 * microphone samples are returned, so streaming always keeps working. Both
 * recorders share start/stop/release lifecycle and [release] is idempotent.
 */
@Suppress("DEPRECATION")
class MixedAudioRecord(
    sampleRate: Int,
    channelConfig: Int,
    audioFormat: Int,
    bufferSizeInBytes: Int,
    private val systemRecord: AudioRecord?,
    private val onSystemUnavailable: ((String) -> Unit)? = null,
) : AudioRecord(
    MediaRecorder.AudioSource.MIC,
    sampleRate,
    channelConfig,
    audioFormat,
    bufferSizeInBytes
) {
    companion object {
        /** Each input is attenuated so a loud app + speech cannot clip constantly. */
        const val MIC_GAIN = 0.7f
        const val SYSTEM_GAIN = 0.7f
        /** 16-bit PCM range used for the saturating (soft-clip) mix. */
        private const val PCM_MIN = -32768
        private const val PCM_MAX = 32767
        private const val BYTES_PER_SAMPLE = 2
    }

    private val released = AtomicBoolean(false)
    private val systemUnavailable = AtomicBoolean(systemRecord == null)
    private var systemBuffer = ByteArray(0)
    private var mixBuffer = ByteArray(0)

    init {
        if (systemRecord == null) notifySystemUnavailable("no playback-capture AudioRecord")
    }

    // ------------------------------------------------------------------
    // Dual-recorder lifecycle
    // ------------------------------------------------------------------

    override fun startRecording() {
        super.startRecording()
        startSystemRecording()
    }

    override fun startRecording(syncEvent: MediaSyncEvent) {
        super.startRecording(syncEvent)
        startSystemRecording()
    }

    private fun startSystemRecording() {
        val system = systemRecord ?: return
        if (systemUnavailable.get() || released.get()) return
        try {
            system.startRecording()
            if (system.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                markSystemUnavailable("system recorder did not start")
            }
        } catch (error: Exception) {
            markSystemUnavailable(error.message ?: error.javaClass.simpleName)
        }
    }

    override fun stop() {
        try {
            super.stop()
        } catch (_: Exception) {
        }
        val system = systemRecord ?: return
        if (released.get() || systemUnavailable.get()) return
        try {
            system.stop()
        } catch (_: Exception) {
        }
    }

    /** Releases the microphone and the system recorder exactly once. */
    override fun release() {
        if (!released.compareAndSet(false, true)) return
        try {
            super.release()
        } catch (_: Exception) {
        }
        try {
            systemRecord?.release()
        } catch (_: Exception) {
        }
    }

    override fun getState(): Int = super.getState()

    override fun getRecordingState(): Int = super.getRecordingState()

    // ------------------------------------------------------------------
    // Mixed reads (WebRtcAudioRecord uses read(ByteBuffer, int))
    // ------------------------------------------------------------------

    override fun read(audioBuffer: ByteBuffer, sizeInBytes: Int): Int {
        val micRead = super.read(audioBuffer, sizeInBytes)
        if (micRead > 0) mixSystemIntoBuffer(audioBuffer, micRead)
        return micRead
    }

    override fun read(audioBuffer: ByteBuffer, sizeInBytes: Int, readMode: Int): Int {
        val micRead = super.read(audioBuffer, sizeInBytes, readMode)
        if (micRead > 0) mixSystemIntoBuffer(audioBuffer, micRead)
        return micRead
    }

    override fun read(audioData: ByteArray, offsetInBytes: Int, sizeInBytes: Int): Int {
        val micRead = super.read(audioData, offsetInBytes, sizeInBytes)
        if (micRead > 0) mixSystemIntoArray(audioData, offsetInBytes, micRead)
        return micRead
    }

    override fun read(audioData: ByteArray, offsetInBytes: Int, sizeInBytes: Int, readMode: Int): Int {
        val micRead = super.read(audioData, offsetInBytes, sizeInBytes, readMode)
        if (micRead > 0) mixSystemIntoArray(audioData, offsetInBytes, micRead)
        return micRead
    }

    // ------------------------------------------------------------------
    // Mixing
    // ------------------------------------------------------------------

    /** Mixes the system samples into a ByteBuffer that already holds mic samples. */
    private fun mixSystemIntoBuffer(audioBuffer: ByteBuffer, micBytes: Int) {
        if (micBytes < BYTES_PER_SAMPLE) return
        val systemRead = readSystemSamples(micBytes)
        if (systemRead < BYTES_PER_SAMPLE) return
        val base = audioBuffer.position() - micBytes
        if (base < 0) return
        val view = audioBuffer.duplicate()
        val samples = micBytes / BYTES_PER_SAMPLE
        val systemSamples = systemRead / BYTES_PER_SAMPLE
        if (mixBuffer.size < micBytes) mixBuffer = ByteArray(micBytes)
        val out = mixBuffer
        for (index in 0 until samples) {
            val mic = readShortLe(view, base + index * BYTES_PER_SAMPLE)
            val system = if (index < systemSamples) readShortLe(systemBuffer, index * BYTES_PER_SAMPLE) else 0
            val mixed = mixSample(mic, system)
            out[index * BYTES_PER_SAMPLE] = (mixed and 0xFF).toByte()
            out[index * BYTES_PER_SAMPLE + 1] = ((mixed shr 8) and 0xFF).toByte()
        }
        audioBuffer.position(base)
        audioBuffer.put(out, 0, micBytes)
        audioBuffer.position(base + micBytes)
    }

    /** Byte-array variant used by the other AudioRecord read overloads. */
    private fun mixSystemIntoArray(audioData: ByteArray, offsetInBytes: Int, micBytes: Int) {
        if (micBytes < BYTES_PER_SAMPLE) return
        val systemRead = readSystemSamples(micBytes)
        if (systemRead < BYTES_PER_SAMPLE) return
        val samples = minOf(micBytes, systemRead) / BYTES_PER_SAMPLE
        for (index in 0 until samples) {
            val position = offsetInBytes + index * BYTES_PER_SAMPLE
            val mic = readShortLe(audioData, position)
            val system = readShortLe(systemBuffer, index * BYTES_PER_SAMPLE)
            val mixed = mixSample(mic, system)
            audioData[position] = (mixed and 0xFF).toByte()
            audioData[position + 1] = ((mixed shr 8) and 0xFF).toByte()
        }
    }

    /** Saturated 16-bit mix: mic * 0.7 + system * 0.7, clamped to the PCM range. */
    private fun mixSample(mic: Int, system: Int): Int {
        val mixed = (mic * MIC_GAIN + system * SYSTEM_GAIN).toInt()
        return mixed.coerceIn(PCM_MIN, PCM_MAX)
    }

    /** Drains the playback-capture recorder without ever blocking the mic thread. */
    private fun readSystemSamples(sizeInBytes: Int): Int {
        val system = systemRecord ?: return 0
        if (systemUnavailable.get() || released.get() || sizeInBytes <= 0) return 0
        if (systemBuffer.size < sizeInBytes) systemBuffer = ByteArray(sizeInBytes)
        return try {
            val read = system.read(systemBuffer, 0, sizeInBytes, AudioRecord.READ_NON_BLOCKING)
            when {
                read > 0 -> read
                read == AudioRecord.ERROR_DEAD_OBJECT -> {
                    markSystemUnavailable("system recorder dead")
                    0
                }
                else -> 0
            }
        } catch (error: Exception) {
            markSystemUnavailable(error.message ?: error.javaClass.simpleName)
            0
        }
    }

    private fun readShortLe(buffer: ByteBuffer, index: Int): Int {
        val low = buffer.get(index).toInt() and 0xFF
        val high = buffer.get(index + 1).toInt() shl 8
        return (low or high).toShort().toInt()
    }

    private fun readShortLe(data: ByteArray, index: Int): Int {
        val low = data[index].toInt() and 0xFF
        val high = data[index + 1].toInt() shl 8
        return (low or high).toShort().toInt()
    }

    private fun markSystemUnavailable(reason: String) {
        if (!systemUnavailable.compareAndSet(false, true)) return
        notifySystemUnavailable(reason)
    }

    private fun notifySystemUnavailable(reason: String) {
        try {
            onSystemUnavailable?.invoke(reason)
        } catch (_: Exception) {
        }
    }
}
