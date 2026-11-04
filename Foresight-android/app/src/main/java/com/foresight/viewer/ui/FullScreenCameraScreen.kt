/*
 * Full-screen live view for a single camera. Pins the HIGH simulcast layer,
 * shows health telemetry, and exposes the viewer control set over the LiveKit
 * data channel: torch, lens switch, digital zoom (throttled ~120 ms), quality
 * presets, listen (remote audio), push-to-talk (hold), plus
 * viewer-side snapshot and video-only recording saved via MediaStore, local
 * pinch-to-zoom/pan, and rename/remove. Port of the iOS FullScreenCameraView.
 */
package com.foresight.viewer.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material.icons.filled.FlashlightOff
import androidx.compose.material.icons.filled.FlashlightOn
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicNone
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import com.foresight.viewer.contract.QualityPreset
import com.foresight.viewer.media.FrameGrabber
import com.foresight.viewer.media.MediaStoreSaver
import com.foresight.viewer.media.TrackRecorder
import com.foresight.viewer.realtime.CameraVideoView
import com.foresight.viewer.realtime.LiveCamera
import com.foresight.viewer.realtime.RoomManager
import com.foresight.viewer.realtime.VideoLayoutMode
import com.foresight.viewer.session.Session
import io.livekit.android.room.track.VideoQuality
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val MAX_FRAME_ZOOM = 6f
private const val ZOOM_SEND_INTERVAL_MS = 120L

@Composable
fun FullScreenCameraScreen(
    session: Session,
    room: RoomManager,
    camera: LiveCamera,
    /**
     * A scope that OUTLIVES this composable (the grid screen's). Exit work in
     * onDispose — stop talking, finalize the recording, restore 4K → 1080p —
     * must not die with this screen's own composition scope.
     */
    exitScope: kotlinx.coroutines.CoroutineScope,
    onDismiss: () -> Unit,
    onRemoved: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var showControls by remember { mutableStateOf(true) }
    var showMore by remember { mutableStateOf(false) }
    var isListening by remember { mutableStateOf(false) }
    var isTalking by remember { mutableStateOf(false) }
    var statusMessage by remember { mutableStateOf<String?>(null) }
    var statusGeneration by remember { mutableLongStateOf(0L) }

    // True while the user requested Max (true 4K) on a 4K-capable camera and
    // we're waiting to see whether it actually starts (falls back to 1080p with
    // a toast).
    var requested4K by remember { mutableStateOf(false) }

    // Digital zoom: drive the UI from the draft while dragging; throttle sends.
    var zoomDraft by remember { mutableStateOf<Double?>(null) }
    var lastZoomSentAt by remember { mutableLongStateOf(0L) }

    // Local pinch-to-zoom/pan: purely on-device magnification of the rendered
    // frame, independent of the camera's digital zoom.
    var frameZoom by remember { mutableFloatStateOf(1f) }
    var frameOffset by remember { mutableStateOf(Offset.Zero) }
    var viewSize by remember { mutableStateOf(IntSize.Zero) }

    // Snapshot / recording (viewer-side capture per PROTOCOL §4).
    var recorder by remember { mutableStateOf<TrackRecorder?>(null) }
    var isRecording by remember { mutableStateOf(false) }

    // Rename / remove.
    var showRename by remember { mutableStateOf(false) }
    var renameText by remember { mutableStateOf("") }
    var showRemoveConfirm by remember { mutableStateOf(false) }
    var showMenu by remember { mutableStateOf(false) }

    val maxDigitalZoom = maxOf(1.0, camera.capabilities?.maxDigitalZoom ?: 1.0)
    val supportsDigitalZoom = maxDigitalZoom > 1.0
    val supports4K = (camera.capabilities?.maxResolution?.let { it.width >= 3840 || it.height >= 2160 }) == true
    val supportsAudio = camera.capabilities?.supportsAudio == true
    val displayZoom = zoomDraft ?: camera.zoom

    fun flash(message: String) {
        statusMessage = message
        statusGeneration++
    }

    LaunchedEffect(statusGeneration) {
        if (statusMessage != null) {
            delay(2_000)
            statusMessage = null
        }
    }

    fun sendZoom(value: Double, force: Boolean) {
        val now = System.currentTimeMillis()
        if (!force && now - lastZoomSentAt < ZOOM_SEND_INTERVAL_MS) return
        lastZoomSentAt = now
        val target = value.coerceIn(1.0, maxDigitalZoom)
        scope.launch { room.setZoom(camera, target) }
    }

    fun commitZoom() {
        zoomDraft?.let { sendZoom(it, force = true) }
        zoomDraft = null
    }

    fun clampedOffset(offset: Offset, zoom: Float): Offset {
        val maxX = maxOf(0f, viewSize.width * (zoom - 1f) / 2f)
        val maxY = maxOf(0f, viewSize.height * (zoom - 1f) / 2f)
        return Offset(offset.x.coerceIn(-maxX, maxX), offset.y.coerceIn(-maxY, maxY))
    }

    fun stopRecording() {
        val active = recorder ?: return
        recorder = null
        isRecording = false
        // exitScope: this also runs from onDispose, after this screen's own
        // composition scope is cancelled — the recording must still finalize.
        exitScope.launch { room.stopRecord(camera) }
        exitScope.launch {
            val file = withContext(Dispatchers.IO) { active.stop() }
            if (file == null) {
                flash("Recording failed")
                return@launch
            }
            try {
                val name = "foresight-${SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())}.mp4"
                MediaStoreSaver.saveVideo(context, file, name)
                flash("Saved to gallery")
            } catch (e: Exception) {
                flash(e.message ?: "Could not save the recording")
            }
        }
    }

    fun startRecording() {
        val track = camera.videoTrack
        if (track == null) {
            flash("No video to record")
            return
        }
        val newRecorder = TrackRecorder(track, context.cacheDir)
        recorder = newRecorder
        newRecorder.start()
        isRecording = true
        scope.launch { room.startRecord(camera) }
        flash("Recording…")
    }

    fun takeSnapshot() {
        val track = camera.videoTrack
        if (track == null) {
            flash("No video to capture")
            return
        }
        // Hint the camera so it can persist a high-res still on its side too.
        scope.launch { room.snapshotHint(camera) }
        FrameGrabber(track) { bitmap ->
            if (bitmap == null) {
                flash("Snapshot failed")
                return@FrameGrabber
            }
            scope.launch {
                try {
                    val name = "foresight-${SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())}.jpg"
                    MediaStoreSaver.saveImage(context, bitmap, name)
                    flash("Saved to gallery")
                } catch (e: Exception) {
                    flash(e.message ?: "Could not save the snapshot")
                }
            }
        }
    }

    // Push-to-talk requires the mic permission; request lazily on first hold.
    var pendingTalkStart by remember { mutableStateOf(false) }
    val micPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted && pendingTalkStart) {
            isTalking = true
            scope.launch { room.startTalking(camera) }
        } else if (!granted) {
            flash("Microphone permission is needed to talk")
        }
        pendingTalkStart = false
    }

    fun beginTalk() {
        if (isTalking) return
        val granted = context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) {
            isTalking = true
            scope.launch { room.startTalking(camera) }
        } else {
            pendingTalkStart = true
            micPermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    fun endTalk() {
        if (!isTalking) return
        isTalking = false
        scope.launch { room.stopTalking(camera) }
    }

    // Entry: pin the HIGH layer; auto-start audio (a live camera should sound
    // live too — the Listen button stays available as a mute toggle).
    LaunchedEffect(camera.id) {
        room.subscribeVideo(camera, VideoQuality.HIGH)
        if (supportsAudio) {
            room.setListen(camera, enabled = true)
        }
        isListening = room.isListening(camera)
    }

    // 4K request watcher: the camera's broadcast state tells us what actually
    // started. PURE4K is the legacy wire value for the same single-layer 4K.
    LaunchedEffect(camera.quality) {
        if (!requested4K) return@LaunchedEffect
        when (camera.quality) {
            QualityPreset.MAX, QualityPreset.PURE4K -> requested4K = false // 4K started cleanly
            QualityPreset.P1080 -> {
                requested4K = false // camera fell back to 1080p
                flash("An error occurred while starting 4K streaming.")
            }
            else -> Unit
        }
    }

    // Exit: stop talk/recording/listen, restore single-layer 4K → 1080p (the grid
    // tile has no smaller simulcast layer to fall back to under 4K), drop to LOW.
    // All async exit work rides exitScope — this screen's scope is already
    // cancelled when onDispose runs.
    DisposableEffect(camera.id) {
        onDispose {
            if (isTalking) exitScope.launch { room.stopTalking(camera) }
            if (isRecording) stopRecording()
            if (room.isListening(camera)) room.setListen(camera, enabled = false)
            if (camera.quality == QualityPreset.MAX || camera.quality == QualityPreset.PURE4K) {
                exitScope.launch { room.setQuality(camera, QualityPreset.P1080) }
            }
            room.subscribeVideo(camera, VideoQuality.LOW)
        }
    }

    val effectiveZoom = frameZoom.coerceIn(1f, MAX_FRAME_ZOOM)

    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        CameraVideoView(
            room = room.room,
            camera = camera,
            layoutMode = VideoLayoutMode.FIT,
            modifier = Modifier
                .fillMaxSize()
                .onSizeChanged { viewSize = it }
                // Gestures sit OUTSIDE the graphicsLayer: inside it, pointer
                // deltas are divided by the current scale, so panning would lag
                // the finger by 1/zoom. Out here pan is in screen pixels — the
                // same unit as the layer's translation.
                .pointerInput(Unit) {
                    detectTapGestures {
                        showControls = !showControls
                        if (!showControls) showMore = false
                    }
                }
                .pointerInput(Unit) {
                    detectTransformGestures { _, pan, gestureZoom, _ ->
                        val newZoom = (frameZoom * gestureZoom).coerceIn(1f, MAX_FRAME_ZOOM)
                        frameZoom = newZoom
                        frameOffset = clampedOffset(frameOffset + pan, newZoom)
                    }
                }
                .graphicsLayer(
                    scaleX = effectiveZoom,
                    scaleY = effectiveZoom,
                    translationX = frameOffset.x,
                    translationY = frameOffset.y,
                ),
        )

        if (showControls) {
            Column(modifier = Modifier.fillMaxSize().padding(vertical = 12.dp)) {
                // Top bar
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ControlCircleButton(Icons.Filled.KeyboardArrowDown, "Close") { onDismiss() }
                    OnlineDot(online = camera.isOnline)
                    Text(
                        camera.name,
                        style = MaterialTheme.typography.titleMedium,
                        color = Color.White,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Spacer(Modifier.weight(1f))
                    if (isRecording) RecordingDot()
                    Box {
                        ControlCircleButton(Icons.Filled.MoreVert, "Camera options") { showMenu = true }
                        DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }) {
                            DropdownMenuItem(
                                text = { Text("Rename") },
                                leadingIcon = { Icon(Icons.Filled.Edit, contentDescription = null) },
                                onClick = {
                                    showMenu = false
                                    renameText = camera.name
                                    showRename = true
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("Remove Camera", color = MaterialTheme.colorScheme.error) },
                                leadingIcon = {
                                    Icon(
                                        Icons.Filled.Delete,
                                        contentDescription = null,
                                        tint = MaterialTheme.colorScheme.error,
                                    )
                                },
                                onClick = {
                                    showMenu = false
                                    showRemoveConfirm = true
                                },
                            )
                        }
                    }
                }

                Spacer(Modifier.weight(1f))

                HealthStrip(
                    camera = camera,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                )

                // Control bar
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp)
                        .padding(top = 8.dp)
                        .background(Color.Black.copy(alpha = 0.35f), RoundedCornerShape(20.dp))
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    if (showMore) {
                        MoreControls(
                            camera = camera,
                            room = room,
                            supports4K = supports4K,
                            supportsDigitalZoom = supportsDigitalZoom,
                            maxDigitalZoom = maxDigitalZoom,
                            displayZoom = displayZoom,
                            isRecording = isRecording,
                            onZoomDraft = { value ->
                                zoomDraft = value
                                sendZoom(value, force = false)
                            },
                            onZoomCommit = { commitZoom() },
                            onPreset = { preset ->
                                requested4K = supports4K && preset == QualityPreset.MAX
                                scope.launch { room.setQuality(camera, preset) }
                            },
                            onSnapshot = { takeSnapshot() },
                            onToggleRecord = { if (isRecording) stopRecording() else startRecording() },
                        )
                    }

                    // Primary controls: flashlight, listen, More.
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(28.dp, Alignment.CenterHorizontally),
                    ) {
                        if (camera.capabilities?.torch == true) {
                            LabeledControlButton(
                                icon = if (camera.torchOn) Icons.Filled.FlashlightOn else Icons.Filled.FlashlightOff,
                                label = "Flashlight",
                                active = camera.torchOn,
                            ) {
                                scope.launch { room.setTorch(camera, !camera.torchOn) }
                            }
                        }
                        if (supportsAudio) {
                            LabeledControlButton(
                                icon = if (isListening) Icons.AutoMirrored.Filled.VolumeUp else Icons.AutoMirrored.Filled.VolumeOff,
                                label = "Listen",
                                active = isListening,
                            ) {
                                val next = !isListening
                                isListening = next
                                room.setListen(camera, next)
                            }
                        }
                        LabeledControlButton(
                            icon = if (showMore) Icons.Filled.ExpandMore else Icons.Filled.MoreHoriz,
                            label = if (showMore) "Less" else "More",
                            active = showMore,
                        ) {
                            showMore = !showMore
                        }
                    }

                    // Push-to-talk: the hero control, always within thumb reach.
                    if (supportsAudio) {
                        Row(
                            modifier = Modifier
                                .align(Alignment.CenterHorizontally)
                                .background(
                                    if (isTalking) Color.Red else Color.White.copy(alpha = 0.15f),
                                    CircleShape,
                                )
                                .pointerInput(Unit) {
                                    detectTapGestures(
                                        onPress = {
                                            beginTalk()
                                            tryAwaitRelease()
                                            endTalk()
                                        },
                                    )
                                }
                                .padding(horizontal = 22.dp, vertical = 9.dp),
                            horizontalArrangement = Arrangement.spacedBy(7.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                if (isTalking) Icons.Filled.Mic else Icons.Filled.MicNone,
                                contentDescription = "Push to talk",
                                tint = Color.White,
                                modifier = Modifier.size(18.dp),
                            )
                            Text(
                                "Hold to Talk",
                                style = MaterialTheme.typography.titleSmall,
                                color = Color.White,
                            )
                        }
                    }
                }
            }
        }

        statusMessage?.let { message ->
            Box(
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 120.dp),
            ) {
                Text(
                    message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color.White,
                    modifier = Modifier
                        .background(Color.Black.copy(alpha = 0.7f), CircleShape)
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                )
            }
        }
    }

    if (showRename) {
        AlertDialog(
            onDismissRequest = { showRename = false },
            title = { Text("Rename Camera") },
            text = {
                OutlinedTextField(
                    value = renameText,
                    onValueChange = { renameText = it },
                    label = { Text("Name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val trimmed = renameText.trim()
                    if (trimmed.isNotEmpty()) {
                        scope.launch {
                            try {
                                val updated = session.api.renameCamera(camera.id, trimmed)
                                camera.merge(updated)
                            } catch (e: Exception) {
                                flash(e.message ?: "Rename failed")
                            }
                        }
                    }
                    showRename = false
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { showRename = false }) { Text("Cancel") } },
        )
    }

    if (showRemoveConfirm) {
        AlertDialog(
            onDismissRequest = { showRemoveConfirm = false },
            title = { Text("Remove ${camera.name}?") },
            text = { Text("This unpairs the camera from this Home. You can pair it again later.") },
            confirmButton = {
                TextButton(onClick = {
                    showRemoveConfirm = false
                    scope.launch {
                        try {
                            session.api.removeCamera(camera.id)
                            onRemoved()
                        } catch (e: Exception) {
                            flash(e.message ?: "Remove failed")
                        }
                    }
                }) { Text("Remove Camera", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { showRemoveConfirm = false }) { Text("Cancel") } },
        )
    }
}

/** Expanded secondary controls: quality, zoom, lens, snapshot, record. */
@Composable
private fun MoreControls(
    camera: LiveCamera,
    room: RoomManager,
    supports4K: Boolean,
    supportsDigitalZoom: Boolean,
    maxDigitalZoom: Double,
    displayZoom: Double,
    isRecording: Boolean,
    onZoomDraft: (Double) -> Unit,
    onZoomCommit: () -> Unit,
    onPreset: (QualityPreset) -> Unit,
    onSnapshot: () -> Unit,
    onToggleRecord: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        // Four presets. "Max" is single-layer true 4K on a 4K-capable camera;
        // PURE4K is the legacy wire value for the same thing, so a camera
        // reporting it still shows Max selected.
        val effectivePreset = if (camera.quality == QualityPreset.PURE4K) QualityPreset.MAX else camera.quality
        val presets = listOf(
            QualityPreset.AUTO to "Auto",
            QualityPreset.P480 to "480p",
            QualityPreset.P1080 to "1080p",
            QualityPreset.MAX to "Max",
        )
        SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
            presets.forEachIndexed { index, (preset, label) ->
                SegmentedButton(
                    selected = effectivePreset == preset,
                    onClick = { onPreset(preset) },
                    shape = SegmentedButtonDefaults.itemShape(index = index, count = presets.size),
                ) { Text(label) }
            }
        }

        // On a 4K-capable camera, "Max" is single-layer true 4K.
        if (supports4K) {
            Text(
                "Max streams true 4K on this camera.",
                style = MaterialTheme.typography.bodySmall,
                color = Color.White.copy(alpha = 0.7f),
                modifier = Modifier.fillMaxWidth(),
            )
        }

        // Digital zoom slider (distinct from the optical lens switcher).
        if (supportsDigitalZoom) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Slider(
                    value = displayZoom.coerceIn(1.0, maxDigitalZoom).toFloat(),
                    onValueChange = { onZoomDraft(it.toDouble()) },
                    onValueChangeFinished = onZoomCommit,
                    valueRange = 1f..maxDigitalZoom.toFloat(),
                    modifier = Modifier.weight(1f),
                )
                Text(
                    String.format(Locale.US, "%.1f×", displayZoom),
                    style = MaterialTheme.typography.labelMedium,
                    color = Color.White,
                    modifier = Modifier.width(44.dp),
                )
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(28.dp, Alignment.CenterHorizontally),
        ) {
            val lenses = camera.capabilities?.lenses.orEmpty()
            if (lenses.size > 1) {
                LabeledControlButton(icon = Icons.Filled.Cameraswitch, label = "Lens") {
                    val sorted = lenses.sorted()
                    val index = sorted.indexOf(camera.lens)
                    val next = if (index >= 0) sorted[(index + 1) % sorted.size] else (sorted.firstOrNull() ?: 1.0)
                    scope.launch { room.switchLens(camera, next) }
                }
            }
            LabeledControlButton(icon = Icons.Filled.CameraAlt, label = "Snapshot", onClick = onSnapshot)
            LabeledControlButton(
                icon = if (isRecording) Icons.Filled.Stop else Icons.Filled.FiberManualRecord,
                label = if (isRecording) "Stop" else "Record",
                active = isRecording,
                onClick = onToggleRecord,
            )
        }
    }
}

@Composable
private fun LabeledControlButton(
    icon: ImageVector,
    label: String,
    active: Boolean = false,
    onClick: () -> Unit,
) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        IconButton(
            onClick = onClick,
            modifier = Modifier
                .size(44.dp)
                .background(
                    if (active) MaterialTheme.colorScheme.primary else Color.White.copy(alpha = 0.15f),
                    CircleShape,
                ),
        ) {
            Icon(icon, contentDescription = label, tint = Color.White)
        }
        Text(label, style = MaterialTheme.typography.labelSmall, color = Color.White)
    }
}

@Composable
private fun ControlCircleButton(icon: ImageVector, contentDescription: String, onClick: () -> Unit) {
    IconButton(
        onClick = onClick,
        modifier = Modifier
            .size(40.dp)
            .background(Color.Black.copy(alpha = 0.4f), CircleShape),
    ) {
        Icon(icon, contentDescription = contentDescription, tint = Color.White)
    }
}
