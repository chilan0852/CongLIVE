package com.conglive.app

import android.content.Context

/**
 * User-selectable stream quality for the broadcast page.
 *
 * The same table is used by [MainActivity] (to render the buttons, persist the
 * choice and build the service Intent) and by [ScreenStreamService] (as the
 * fallback when an Intent arrives without explicit video extras), so the two
 * sides cannot drift apart.
 *
 * Width/height here are the *landscape* dimensions. The broadcast page sends
 * them unchanged; [ScreenStreamService] swaps them for screen capture because
 * a phone screen is captured in portrait, and uses them as-is for the camera.
 */
object VideoSettings {
    const val PREFS_NAME = "conglive"
    const val KEY_RESOLUTION = "video_resolution"
    const val KEY_FPS = "video_fps"

    const val DEFAULT_RESOLUTION_ID = "720p"
    const val DEFAULT_FPS = 24
    /** SRS re-encodes to RTMP/FLV; a 1 second keyframe interval keeps seeking usable. */
    const val DEFAULT_IFRAME_INTERVAL = 1

    data class Resolution(
        val id: String,
        val label: String,
        val width: Int,
        val height: Int,
        val bitrateBps: Int
    ) {
        val bitrateKbps: Int get() = bitrateBps / 1000
    }

    /** 720p 1280x720 @ 2 Mbps, 540p 960x540 @ 1.2 Mbps, 360p 640x360 @ 800 kbps. */
    val RESOLUTIONS: List<Resolution> = listOf(
        Resolution("720p", "720p", 1280, 720, 2_000_000),
        Resolution("540p", "540p", 960, 540, 1_200_000),
        Resolution("360p", "360p", 640, 360, 800_000)
    )

    val FPS_OPTIONS: List<Int> = listOf(30, 24, 15)

    fun defaultResolution(): Resolution = RESOLUTIONS.first { it.id == DEFAULT_RESOLUTION_ID }

    fun resolution(id: String?): Resolution =
        RESOLUTIONS.firstOrNull { it.id == id } ?: defaultResolution()

    fun normalizedFps(fps: Int): Int = if (fps in FPS_OPTIONS) fps else DEFAULT_FPS

    fun loadResolution(context: Context): Resolution {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return resolution(prefs.getString(KEY_RESOLUTION, DEFAULT_RESOLUTION_ID))
    }

    fun loadFps(context: Context): Int {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return normalizedFps(prefs.getInt(KEY_FPS, DEFAULT_FPS))
    }
}
