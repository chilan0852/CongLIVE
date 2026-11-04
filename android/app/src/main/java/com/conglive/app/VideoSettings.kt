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

    // ---------------------------------------------------------------- v0.7.9
    /** The only profile that is allowed to use the high bitrate / frame rate. */
    const val HIGH_RESOLUTION_ID = "1080p"
    const val HIGH_FPS = 60
    /** 1080p60 keeps its full 6 Mbps profile; every other choice stays low bandwidth. */
    const val LOW_BITRATE_CEILING = 2_000_000
    /** Hard encoder ceiling for the 1080p60 profile (service side bitrate clamping). */
    const val HIGH_BITRATE_CEILING = 8_000_000
    /** Smallest bitrate the encoder is asked to use, even for 360p. */
    const val MIN_BITRATE = 400_000

    data class Resolution(
        val id: String,
        val label: String,
        val width: Int,
        val height: Int,
        val bitrateBps: Int
    ) {
        val bitrateKbps: Int get() = bitrateBps / 1000
    }

    /** 1080p 1920x1080 @ 6 Mbps, 720p @ 2 Mbps, 540p @ 1.2 Mbps, 360p @ 800 kbps. */
    val RESOLUTIONS: List<Resolution> = listOf(
        Resolution("1080p", "1080p", 1920, 1080, 6_000_000),
        Resolution("720p", "720p", 1280, 720, 2_000_000),
        Resolution("540p", "540p", 960, 540, 1_200_000),
        Resolution("360p", "360p", 640, 360, 800_000)
    )

    /** v0.7.9: 60 fps is offered next to the existing 30 / 24 / 15 options. */
    val FPS_OPTIONS: List<Int> = listOf(60, 30, 24, 15)

    fun defaultResolution(): Resolution = RESOLUTIONS.first { it.id == DEFAULT_RESOLUTION_ID }

    fun resolution(id: String?): Resolution =
        RESOLUTIONS.firstOrNull { it.id == id } ?: defaultResolution()

    fun normalizedFps(fps: Int): Int = if (fps in FPS_OPTIONS) fps else DEFAULT_FPS

    /**
     * v0.7.9: 1080p and 60 fps are only offered when GET /api/capacity reports
     * `allow1080p60 = true` (the current 2C/2G server returns false).
     */
    fun requiresHighCapacity(resolution: Resolution?, fps: Int): Boolean =
        resolution?.id == HIGH_RESOLUTION_ID || fps >= HIGH_FPS

    /**
     * Bitrate clamp used by both the broadcast page (before it sends the Intent)
     * and by [ScreenStreamService] (defensively, when an Intent carries an
     * arbitrary bitrate): only the "1080p + 60 fps" profile may exceed
     * [LOW_BITRATE_CEILING]; everything else is kept at 2 Mbps or below.
     */
    fun effectiveBitrate(resolution: Resolution?, fps: Int, requestedBps: Int = 0): Int {
        val base = if (requestedBps > 0) requestedBps else (resolution ?: defaultResolution()).bitrateBps
        val highProfile = resolution?.id == HIGH_RESOLUTION_ID && fps >= HIGH_FPS
        val ceiling = if (highProfile) HIGH_BITRATE_CEILING else LOW_BITRATE_CEILING
        return base.coerceIn(MIN_BITRATE, ceiling)
    }

    /**
     * Service-side variant: the service only knows the capture dimensions and
     * frame rate, not the resolution id, so 1080p (or larger) + 60 fps is
     * inferred from the dimensions.
     */
    fun effectiveBitrate(width: Int, height: Int, fps: Int, requestedBps: Int): Int {
        val hiRes = width.toLong() * height.toLong() >= 1920L * 1080L
        val highProfile = hiRes && fps >= HIGH_FPS
        val ceiling = if (highProfile) HIGH_BITRATE_CEILING else LOW_BITRATE_CEILING
        return requestedBps.coerceIn(MIN_BITRATE, ceiling)
    }

    fun loadResolution(context: Context): Resolution {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return resolution(prefs.getString(KEY_RESOLUTION, DEFAULT_RESOLUTION_ID))
    }

    fun loadFps(context: Context): Int {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return normalizedFps(prefs.getInt(KEY_FPS, DEFAULT_FPS))
    }
}
