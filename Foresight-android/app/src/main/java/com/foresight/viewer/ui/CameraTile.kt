/*
 * A single camera tile in the Home grid. Shows live video (LOW layer), the
 * camera name + online dot, a health badge strip, and a recording indicator.
 * Subscribes while in composition and pauses when it leaves. Port of the iOS
 * CameraTile.
 */
package com.foresight.viewer.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.foresight.viewer.realtime.CameraVideoView
import com.foresight.viewer.realtime.LiveCamera
import com.foresight.viewer.realtime.RoomManager
import io.livekit.android.room.track.VideoQuality

@Composable
fun CameraTile(room: RoomManager, camera: LiveCamera, onClick: () -> Unit) {
    // Grid tiles use the LOW layer to keep bandwidth down (PROTOCOL §5); with
    // adaptiveStream the small renderer size enforces the same thing.
    LaunchedEffect(camera.id, camera.participant) {
        room.subscribeVideo(camera, VideoQuality.LOW)
    }
    DisposableEffect(camera.id) {
        onDispose { room.pauseVideo(camera) }
    }

    Box(
        modifier = Modifier
            .aspectRatio(16f / 9f)
            .clip(RoundedCornerShape(12.dp))
            .background(Color.Black)
            .clickable(onClick = onClick),
    ) {
        CameraVideoView(room = room.room, camera = camera, modifier = Modifier.fillMaxSize())

        // Top overlay: REC + online dot.
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .align(Alignment.TopCenter)
                .padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (camera.recording) RecordingDot()
            androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
            OnlineDot(online = camera.isOnline)
        }

        // Bottom overlay: name + health strip over a scrim.
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .align(Alignment.BottomCenter)
                .background(
                    Brush.verticalGradient(
                        colors = listOf(Color.Transparent, Color.Black.copy(alpha = 0.55f)),
                    ),
                )
                .padding(8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                camera.name,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                color = Color.White,
                maxLines = 1,
            )
            HealthStrip(camera = camera, modifier = Modifier.fillMaxWidth())
        }
    }
}
