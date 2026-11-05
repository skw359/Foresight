/*
 * Viewer-side snapshot + recording (per PROTOCOL §4: capture is viewer-side in
 * v1). Both attach a lightweight VideoSink to the incoming LiveKit track:
 *  - FrameGrabber: captures one frame → Bitmap.
 *  - TrackRecorder: writes incoming frames to an .mp4 via MediaCodec+MediaMuxer
 *    (video-only, matching the web dashboard's track capture and the iOS
 *    AVAssetWriter recorder).
 *
 * E2EE note: frames arriving here are already decrypted by the LiveKit frame
 * cryptor, so snapshot/recording work unchanged in encrypted Homes.
 */
package com.foresight.viewer.media

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.YuvImage
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Handler
import android.os.Looper
import io.livekit.android.room.track.VideoTrack
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import livekit.org.webrtc.VideoFrame
import livekit.org.webrtc.VideoSink

/** Copy an I420 buffer into a packed NV21 byte array (Y plane, then interleaved VU). */
private fun i420ToNv21(i420: VideoFrame.I420Buffer): ByteArray {
    val width = i420.width
    val height = i420.height
    val chromaWidth = (width + 1) / 2
    val chromaHeight = (height + 1) / 2
    val out = ByteArray(width * height + 2 * chromaWidth * chromaHeight)

    copyPlane(i420.dataY, i420.strideY, out, 0, width, height, 1)

    // NV21 chroma: interleaved V then U.
    var offset = width * height
    val dataU = i420.dataU
    val dataV = i420.dataV
    for (row in 0 until chromaHeight) {
        val uRow = i420.strideU * row
        val vRow = i420.strideV * row
        for (col in 0 until chromaWidth) {
            out[offset++] = dataV.get(vRow + col)
            out[offset++] = dataU.get(uRow + col)
        }
    }
    return out
}

private fun copyPlane(
    source: ByteBuffer,
    sourceStride: Int,
    dest: ByteArray,
    destOffset: Int,
    width: Int,
    height: Int,
    @Suppress("SameParameterValue") pixelStride: Int,
) {
    var out = destOffset
    for (row in 0 until height) {
        val base = sourceStride * row
        for (col in 0 until width) {
            dest[out] = source.get(base + col * pixelStride)
            out++
        }
    }
}

/**
 * Attaches to a VideoTrack, captures the next frame as a Bitmap (rotated
 * upright), then detaches. Falls back to null after [timeoutMs] with no frame.
 * The completion runs on the main thread, exactly once.
 */
class FrameGrabber(
    private val track: VideoTrack,
    timeoutMs: Long = 3_000,
    private val onImage: (Bitmap?) -> Unit,
) : VideoSink {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val delivered = java.util.concurrent.atomic.AtomicBoolean(false)
    private val captureStarted = java.util.concurrent.atomic.AtomicBoolean(false)

    init {
        track.addRenderer(this)
        mainHandler.postDelayed({ deliver(null) }, timeoutMs)
    }

    override fun onFrame(frame: VideoFrame) {
        // Only the first frame is converted; later frames before detach are ignored.
        if (!captureStarted.compareAndSet(false, true)) return
        val bitmap: Bitmap? = try {
            val i420 = frame.buffer.toI420() ?: return
            try {
                val nv21 = i420ToNv21(i420)
                val yuv = YuvImage(nv21, ImageFormat.NV21, i420.width, i420.height, null)
                val jpeg = ByteArrayOutputStream()
                yuv.compressToJpeg(Rect(0, 0, i420.width, i420.height), 95, jpeg)
                val raw = jpeg.toByteArray()
                val decoded = BitmapFactory.decodeByteArray(raw, 0, raw.size)
                if (decoded != null && frame.rotation != 0) {
                    val matrix = Matrix().apply { postRotate(frame.rotation.toFloat()) }
                    Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
                } else {
                    decoded
                }
            } finally {
                i420.release()
            }
        } catch (_: Exception) {
            null
        }
        mainHandler.post { deliver(bitmap) }
    }

    private fun deliver(bitmap: Bitmap?) {
        if (!delivered.compareAndSet(false, true)) return
        track.removeRenderer(this)
        onImage(bitmap)
    }
}

/**
 * Records an incoming VideoTrack to an .mp4 (H.264, video-only in v1). Frames
 * are encoded through MediaCodec's flexible-YUV input path and muxed with
 * MediaMuxer; the first frame fixes the encode size and the muxer's
 * orientation hint. Frames arriving at a different size (simulcast layer
 * switch mid-recording) are nearest-neighbor scaled to the configured size.
 */
class TrackRecorder(private val track: VideoTrack, cacheDir: File) : VideoSink {

    private val outputFile: File =
        File(cacheDir, "foresight-${System.currentTimeMillis() / 1000}.mp4")

    private var codec: MediaCodec? = null
    private var muxer: MediaMuxer? = null
    private var muxerTrack = -1
    private var muxerStarted = false
    private var configuredWidth = 0
    private var configuredHeight = 0
    private var firstTimestampNs = -1L
    private var stopped = false
    private var attached = false

    var isRecording = false
        private set

    fun start() {
        isRecording = true
        attached = true
        track.addRenderer(this)
    }

    /**
     * Stops recording and finalizes the file. Returns the finished .mp4, or
     * null when nothing was captured. Runs the finalize on the calling thread —
     * call off the main thread.
     */
    fun stop(): File? {
        synchronized(this) {
            if (stopped) return null
            stopped = true
            isRecording = false
        }
        if (attached) {
            track.removeRenderer(this)
            attached = false
        }
        synchronized(this) {
            val codec = codec ?: run { cleanup(); return null }
            return try {
                // Signal EOS through an empty input buffer, then drain fully.
                val inputIndex = codec.dequeueInputBuffer(100_000)
                if (inputIndex >= 0) {
                    codec.queueInputBuffer(inputIndex, 0, 0, lastPtsUs + 33_000, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                }
                drain(untilEos = true)
                if (muxerStarted) {
                    muxer?.stop()
                }
                outputFile.takeIf { muxerStarted && it.length() > 0 }
            } catch (_: Exception) {
                null
            } finally {
                cleanup()
            }
        }
    }

    private fun cleanup() {
        runCatching { codec?.release() }
        runCatching { muxer?.release() }
        codec = null
        muxer = null
        if (!muxerStarted) outputFile.delete()
    }

    private var lastPtsUs = 0L

    override fun onFrame(frame: VideoFrame) {
        synchronized(this) {
            if (!isRecording || stopped) return
            try {
                val i420 = frame.buffer.toI420() ?: return
                try {
                    if (codec == null) {
                        configure(i420.width, i420.height, frame.rotation)
                    }
                    encode(i420, frame.timestampNs)
                } finally {
                    i420.release()
                }
            } catch (_: Exception) {
                // Drop the frame; the recorder keeps going.
            }
        }
    }

    private fun configure(width: Int, height: Int, rotation: Int) {
        // Encoders want even dimensions.
        configuredWidth = width and 1.inv()
        configuredHeight = height and 1.inv()
        val format = MediaFormat.createVideoFormat(
            MediaFormat.MIMETYPE_VIDEO_AVC, configuredWidth, configuredHeight,
        ).apply {
            setInteger(
                MediaFormat.KEY_COLOR_FORMAT,
                MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible,
            )
            setInteger(MediaFormat.KEY_BIT_RATE, (configuredWidth * configuredHeight * 4).coerceAtMost(12_000_000))
            setInteger(MediaFormat.KEY_FRAME_RATE, 30)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
        }
        val created = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        created.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        created.start()
        codec = created

        val createdMuxer = MediaMuxer(outputFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        // Players rotate on playback; frames are written unrotated.
        if (rotation != 0) createdMuxer.setOrientationHint(rotation)
        muxer = createdMuxer
    }

    private fun encode(i420: VideoFrame.I420Buffer, timestampNs: Long) {
        val codec = codec ?: return
        val inputIndex = codec.dequeueInputBuffer(10_000)
        if (inputIndex >= 0) {
            val image = codec.getInputImage(inputIndex)
            if (image != null) {
                fillImage(image, i420)
            }
            if (firstTimestampNs < 0) firstTimestampNs = timestampNs
            val ptsUs = (timestampNs - firstTimestampNs) / 1_000
            lastPtsUs = ptsUs
            val bufferSize = configuredWidth * configuredHeight * 3 / 2
            codec.queueInputBuffer(inputIndex, 0, bufferSize, ptsUs, 0)
        }
        drain(untilEos = false)
    }

    /** Copy (and if needed nearest-neighbor scale) I420 planes into the codec image. */
    private fun fillImage(image: android.media.Image, i420: VideoFrame.I420Buffer) {
        val cropW = configuredWidth
        val cropH = configuredHeight
        val planes = image.planes
        // Plane 0 = Y, 1 = U, 2 = V per YUV_420_888.
        fillPlane(planes[0], i420.dataY, i420.strideY, i420.width, i420.height, cropW, cropH)
        fillPlane(planes[1], i420.dataU, i420.strideU, (i420.width + 1) / 2, (i420.height + 1) / 2, (cropW + 1) / 2, (cropH + 1) / 2)
        fillPlane(planes[2], i420.dataV, i420.strideV, (i420.width + 1) / 2, (i420.height + 1) / 2, (cropW + 1) / 2, (cropH + 1) / 2)
    }

    private fun fillPlane(
        plane: android.media.Image.Plane,
        source: ByteBuffer,
        sourceStride: Int,
        sourceWidth: Int,
        sourceHeight: Int,
        destWidth: Int,
        destHeight: Int,
    ) {
        val dest = plane.buffer
        val rowStride = plane.rowStride
        val pixelStride = plane.pixelStride
        val scaled = sourceWidth != destWidth || sourceHeight != destHeight
        val row = ByteArray(rowStride)
        for (y in 0 until destHeight) {
            val srcY = if (scaled) (y * sourceHeight / destHeight).coerceAtMost(sourceHeight - 1) else y
            val srcBase = sourceStride * srcY
            if (pixelStride == 1 && !scaled) {
                for (x in 0 until destWidth) row[x] = source.get(srcBase + x)
                dest.position(y * rowStride)
                dest.put(row, 0, destWidth)
            } else {
                dest.position(y * rowStride)
                var written = 0
                for (x in 0 until destWidth) {
                    val srcX = if (scaled) (x * sourceWidth / destWidth).coerceAtMost(sourceWidth - 1) else x
                    row[written] = source.get(srcBase + srcX)
                    written += pixelStride
                    if (pixelStride > 1 && x < destWidth - 1) row[written - pixelStride + 1] = 0
                }
                dest.put(row, 0, ((destWidth - 1) * pixelStride + 1).coerceAtMost(rowStride))
            }
        }
    }

    private fun drain(untilEos: Boolean) {
        val codec = codec ?: return
        val info = MediaCodec.BufferInfo()
        while (true) {
            val outIndex = codec.dequeueOutputBuffer(info, if (untilEos) 100_000 else 0)
            when {
                outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    val muxer = muxer ?: return
                    muxerTrack = muxer.addTrack(codec.outputFormat)
                    muxer.start()
                    muxerStarted = true
                }

                outIndex >= 0 -> {
                    val buffer = codec.getOutputBuffer(outIndex)
                    if (buffer != null && info.size > 0 && muxerStarted &&
                        (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0
                    ) {
                        muxer?.writeSampleData(muxerTrack, buffer, info)
                    }
                    codec.releaseOutputBuffer(outIndex, false)
                    if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return
                }

                else -> if (!untilEos) return else if (outIndex == MediaCodec.INFO_TRY_AGAIN_LATER) return
            }
        }
    }
}
