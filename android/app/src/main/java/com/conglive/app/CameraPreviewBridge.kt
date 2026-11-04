package com.conglive.app

import android.util.Log
import org.webrtc.EglBase
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack
import java.util.Collections
import java.util.WeakHashMap

/** Shares the active local camera track with the Activity's optional preview renderer.
 *
 * Ownership rules:
 * - The bridge only ever *initializes* a renderer it receives through [attach]; the
 *   Activity keeps ownership of the View but must not release it itself.
 * - [clear] is called by [ScreenStreamService] when the streaming session ends and it
 *   must release the attached renderer *before* the session's [EglBase] is released.
 * - [detach] may be called later by the Activity for the same (already released)
 *   renderer; it is idempotent and never releases the same renderer twice. */
object CameraPreviewBridge {
    @Volatile private var activeTrack: VideoTrack? = null
    /** v0.7.7: language for the user-visible preview status. */
    @Volatile private var language: Lang = Lang.fromSystem()
    /** Optional localized status sink wired by [MainActivity]. */
    @Volatile var onStatus: ((String) -> Unit)? = null
    @Volatile private var sharedEglContext: EglBase.Context? = null
    @Volatile private var mirrorPreview: Boolean = true
    private var attachedRenderer: SurfaceViewRenderer? = null

    /** Renderers already released by [clear]/[detach]; releasing an EglRenderer twice
     * would touch a torn-down EGL surface, so remember identity here. Weak keys keep
     * this from leaking the views after the Activity drops them. */
    private val releasedRenderers: MutableSet<SurfaceViewRenderer> =
        Collections.newSetFromMap(WeakHashMap<SurfaceViewRenderer, Boolean>())

    /** v0.7.7: keeps the preview status in the language selected in the app. */
    fun setLanguage(lang: Lang) {
        language = lang
    }

    private fun report(key: String, vararg args: Any?) {
        val message = L10n.t(language, key, *args)
        Log.i("CongLive", message)
        onStatus?.invoke(message)
    }

    @Synchronized
    fun publish(track: VideoTrack, eglContext: EglBase.Context, mirror: Boolean) {
        activeTrack = track
        sharedEglContext = eglContext
        mirrorPreview = mirror
    }

    @Synchronized
    fun setMirror(mirror: Boolean) {
        mirrorPreview = mirror
        attachedRenderer?.setMirror(mirror)
    }

    /** Attaches [renderer] to the active camera track. Returns false when no camera
     * session is published yet or the renderer was already released. Safe to call
     * repeatedly with the same instance: it will not init/addSink twice. */
    @Synchronized
    fun attach(renderer: SurfaceViewRenderer): Boolean {
        val context = sharedEglContext ?: return false
        val track = activeTrack ?: return false
        if (releasedRenderers.contains(renderer)) return false
        if (attachedRenderer === renderer) {
            renderer.setMirror(mirrorPreview)
            return true
        }
        attachedRenderer?.let { previous ->
            try {
                track.removeSink(previous)
            } catch (_: Exception) {
            }
            releaseLocked(previous)
        }
        renderer.init(context, object : RendererCommon.RendererEvents {
            override fun onFirstFrameRendered() {
                report("bridge.firstFrame")
            }
            override fun onFrameResolutionChanged(width: Int, height: Int, rotation: Int) {
                Log.i("CongLive", "camera preview frame ${width}x${height} rotation=$rotation")
            }
        })
        renderer.setEnableHardwareScaler(true)
        renderer.setMirror(mirrorPreview)
        track.addSink(renderer)
        attachedRenderer = renderer
        return true
    }

    /** Detaches and releases [renderer] if the bridge owns it. Idempotent: a second
     * call (e.g. after [clear] released it) is a no-op. */
    @Synchronized
    fun detach(renderer: SurfaceViewRenderer) {
        if (attachedRenderer === renderer) {
            try {
                activeTrack?.removeSink(renderer)
            } catch (_: Exception) {
            }
            attachedRenderer = null
            releaseLocked(renderer)
        }
        // Otherwise: either the bridge never initialized this view (nothing to
        // release), or clear() already released it and it is in releasedRenderers.
    }

    /** Releases the preview renderer while the shared EGL context is still alive.
     * Must run before the streaming session releases its [EglBase]. */
    @Synchronized
    fun clear() {
        val renderer = attachedRenderer
        attachedRenderer = null
        if (renderer != null) {
            try {
                activeTrack?.removeSink(renderer)
            } catch (_: Exception) {
            }
            releaseLocked(renderer)
        }
        activeTrack = null
        sharedEglContext = null
    }

    private fun releaseLocked(renderer: SurfaceViewRenderer) {
        if (!releasedRenderers.add(renderer)) return
        try {
            renderer.release()
        } catch (_: Exception) {
        }
    }
}
