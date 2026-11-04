/*
 * LiveKit video rendering bridged into Compose, with a graceful placeholder
 * when a camera has no track yet (offline, paused, or still subscribing) and a
 * "Decrypting…" overlay while LiveKit can't decrypt E2EE frames (plan §10.3).
 * Port of the iOS CameraVideoView.
 *
 * TextureViewRenderer (not SurfaceViewRenderer): composes correctly inside
 * scrolling grids without z-order punch-through. With adaptiveStream on, the
 * SDK sizes the subscription from this view's dimensions — a grid tile pulls
 * the LOW layer, full-screen pulls HIGH — which is the PROTOCOL §5 behavior.
 */
package com.foresight.viewer.realtime

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.track.VideoTrack
import livekit.org.webrtc.RendererCommon

/**
 * How the video frame maps onto the available space (the iOS
 * VideoView.LayoutMode): FILL crops to cover (grid tiles), FIT letterboxes so
 * the whole frame is visible (full-screen).
 */
enum class VideoLayoutMode { FILL, FIT }

@Composable
fun CameraVideoView(
    room: Room,
    camera: LiveCamera,
    modifier: Modifier = Modifier,
    layoutMode: VideoLayoutMode = VideoLayoutMode.FILL,
) {
    Box(modifier = modifier.background(Color.Black), contentAlignment = Alignment.Center) {
        val track = camera.videoTrack
        if (track != null) {
            VideoTrackRenderer(
                room = room,
                track = track,
                layoutMode = layoutMode,
                // FIT must NOT force an exact size: with exact constraints the
                // renderer's aspect-ratio measure is overridden and the EGL
                // renderer crops the frame to cover the view. Loose constraints
                // let it measure to the frame's aspect, centered in this Box.
                modifier = if (layoutMode == VideoLayoutMode.FILL) Modifier.fillMaxSize() else Modifier,
            )
            if (camera.e2eeDecrypting) {
                DecryptingOverlay()
            }
        } else {
            Placeholder(isOnline = camera.isOnline)
        }
    }
}

@Composable
private fun VideoTrackRenderer(
    room: Room,
    track: VideoTrack,
    layoutMode: VideoLayoutMode,
    modifier: Modifier = Modifier,
) {
    AndroidView(
        modifier = modifier,
        factory = { context ->
            TextureViewRenderer(context).also { renderer ->
                room.initVideoRenderer(renderer)
                if (layoutMode == VideoLayoutMode.FIT) {
                    renderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
                }
                renderer.tag = null as VideoTrack?
            }
        },
        update = { renderer ->
            val previous = renderer.tag as? VideoTrack
            if (previous !== track) {
                previous?.removeRenderer(renderer)
                track.addRenderer(renderer)
                renderer.tag = track
            }
        },
        onRelease = { renderer ->
            (renderer.tag as? VideoTrack)?.removeRenderer(renderer)
            renderer.tag = null
            renderer.release()
        },
    )
}

/** Shown over a live track while LiveKit can't decrypt it yet. */
@Composable
private fun DecryptingOverlay() {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.55f)),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            CircularProgressIndicator(color = Color.White, modifier = Modifier.size(24.dp))
            Text(
                "Decrypting…",
                style = MaterialTheme.typography.bodySmall,
                color = Color.White.copy(alpha = 0.85f),
            )
        }
    }
}

@Composable
private fun Placeholder(isOnline: Boolean) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(
            imageVector = if (isOnline) Icons.Filled.Videocam else Icons.Filled.VideocamOff,
            contentDescription = null,
            tint = Color.White.copy(alpha = 0.5f),
            modifier = Modifier.size(28.dp),
        )
        Text(
            if (isOnline) "Connecting…" else "Offline",
            style = MaterialTheme.typography.bodySmall,
            color = Color.White.copy(alpha = 0.6f),
        )
    }
}
