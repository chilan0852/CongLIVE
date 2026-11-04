package com.conglive.app

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.LruCache
import android.view.View
import android.widget.ImageView
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Cover (直播封面) helpers.
 *
 * Upload: pick an image with ACTION_OPEN_DOCUMENT, downscale it to a sane
 * long edge, re-encode as JPEG and return a `data:image/jpeg;base64,...` data
 * URL that is guaranteed to stay at or below the backend's 2 MB decoded limit.
 *
 * Display: the backend serves `/covers/...` as plain images. Instead of pulling
 * in Glide/Coil we download them with HttpURLConnection + BitmapFactory and keep
 * a small in-memory LRU cache. Cards fall back to a gradient + title initial
 * when no cover exists or the download fails.
 */
object CoverSupport {
    /** Backend rejects anything above 2 MB after base64 decoding. */
    const val MAX_BYTES: Int = 2 * 1024 * 1024

    /** Keep the long edge modest: 1280px JPEG q80 is typically a few hundred KB. */
    const val MAX_EDGE: Int = 1280

    data class PreparedCover(
        val dataUrl: String,
        val bitmap: Bitmap,
        val byteCount: Int
    ) {
        val sizeLabel: String
            get() = if (byteCount >= 1024 * 1024) {
                String.format("%.1f MB", byteCount / (1024.0 * 1024.0))
            } else {
                "${byteCount / 1024} KB"
            }
    }

    /** Reads [uri], downscales it and encodes a JPEG data URL <= [MAX_BYTES]. */
    fun prepare(resolver: ContentResolver, uri: Uri): PreparedCover? {
        val raw = try {
            resolver.openInputStream(uri)?.use { it.readBytes() }
        } catch (_: Exception) {
            null
        } ?: return null
        if (raw.isEmpty()) return null

        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

        var sampleSize = 1
        while (bounds.outWidth / sampleSize > MAX_EDGE || bounds.outHeight / sampleSize > MAX_EDGE) {
            sampleSize *= 2
        }
        var bitmap = try {
            BitmapFactory.decodeByteArray(
                raw,
                0,
                raw.size,
                BitmapFactory.Options().apply { inSampleSize = sampleSize }
            )
        } catch (_: OutOfMemoryError) {
            null
        } ?: return null

        // Phone cameras often store a rotation in EXIF instead of rotating pixels,
        // so apply it before scaling down (framework ExifInterface, no extra dependency).
        val (rotation, mirrored) = readOrientation(raw)
        if (rotation != 0 || mirrored) {
            val matrix = Matrix()
            if (rotation != 0) matrix.postRotate(rotation.toFloat())
            if (mirrored) matrix.postScale(-1f, 1f)
            bitmap = try {
                Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
            } catch (_: Exception) {
                bitmap
            }
        }

        val longEdge = maxOf(bitmap.width, bitmap.height)
        if (longEdge > MAX_EDGE) {
            val ratio = MAX_EDGE.toFloat() / longEdge
            bitmap = Bitmap.createScaledBitmap(
                bitmap,
                (bitmap.width * ratio).toInt().coerceAtLeast(1),
                (bitmap.height * ratio).toInt().coerceAtLeast(1),
                true
            )
        }

        var quality = 84
        while (true) {
            val bytes = encodeJpeg(bitmap, quality)
            if (bytes.size <= MAX_BYTES) {
                val dataUrl = "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
                return PreparedCover(dataUrl, bitmap, bytes.size)
            }
            if (quality > 48) {
                quality -= 10
                continue
            }
            if (bitmap.width <= 480 || bitmap.height <= 480) return null
            bitmap = Bitmap.createScaledBitmap(
                bitmap,
                (bitmap.width * 0.72f).toInt().coerceAtLeast(1),
                (bitmap.height * 0.72f).toInt().coerceAtLeast(1),
                true
            )
            quality = 78
        }
    }

    /** Returns EXIF rotation degrees and whether the image is mirrored. */
    private fun readOrientation(raw: ByteArray): Pair<Int, Boolean> = try {
        val exif = ExifInterface(ByteArrayInputStream(raw))
        when (exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90 to false
            ExifInterface.ORIENTATION_ROTATE_180 -> 180 to false
            ExifInterface.ORIENTATION_ROTATE_270 -> 270 to false
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> 0 to true
            ExifInterface.ORIENTATION_TRANSPOSE -> 90 to true
            ExifInterface.ORIENTATION_TRANSVERSE -> 270 to true
            else -> 0 to false
        }
    } catch (_: Exception) {
        0 to false
    }

    private fun encodeJpeg(bitmap: Bitmap, quality: Int): ByteArray {
        val output = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, quality, output)
        return output.toByteArray()
    }
}

/** Downloads and caches lobby/record cover images without Glide or Coil. */
object CoverLoader {
    private const val MAX_DOWNLOAD_BYTES = 6 * 1024 * 1024

    private val cache = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }
    private val executor = Executors.newFixedThreadPool(3)
    private val mainHandler = Handler(Looper.getMainLooper())

    fun put(url: String, bitmap: Bitmap) {
        if (url.isNotBlank()) cache.put(url, bitmap)
    }

    fun get(url: String): Bitmap? = if (url.isBlank()) null else cache.get(url)

    /**
     * Loads [url] into [view] asynchronously. [view]'s tag is used as a
     * generation guard: when a card is rebound (render() rebuilds the lobby),
     * a stale download never paints over the new image.
     */
    fun load(url: String, view: ImageView) {
        view.tag = url
        if (url.isBlank()) {
            view.setImageDrawable(null)
            view.visibility = View.GONE
            return
        }
        val cached = cache.get(url)
        if (cached != null) {
            view.setImageBitmap(cached)
            view.visibility = View.VISIBLE
            return
        }
        view.setImageDrawable(null)
        view.visibility = View.GONE
        executor.execute {
            val bitmap = download(url)
            if (bitmap != null) cache.put(url, bitmap)
            mainHandler.post {
                if (view.tag == url && bitmap != null) {
                    view.setImageBitmap(bitmap)
                    view.visibility = View.VISIBLE
                }
            }
        }
    }

    private fun download(url: String): Bitmap? {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 8000
                readTimeout = 10000
                instanceFollowRedirects = true
                setRequestProperty("Accept", "image/*")
            }
            if (connection.responseCode !in 200..299) return null
            val raw = connection.inputStream.use { readCapped(it) } ?: return null
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
            var sampleSize = 1
            while (bounds.outWidth / sampleSize > 1280 || bounds.outHeight / sampleSize > 1280) {
                sampleSize *= 2
            }
            BitmapFactory.decodeByteArray(
                raw,
                0,
                raw.size,
                BitmapFactory.Options().apply { inSampleSize = sampleSize }
            )
        } catch (_: Exception) {
            null
        } catch (_: OutOfMemoryError) {
            null
        } finally {
            connection?.disconnect()
        }
    }

    private fun readCapped(stream: InputStream): ByteArray? {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        var total = 0
        while (true) {
            val read = stream.read(buffer)
            if (read <= 0) break
            total += read
            if (total > MAX_DOWNLOAD_BYTES) return null
            output.write(buffer, 0, read)
        }
        return output.toByteArray()
    }
}
