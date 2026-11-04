/*
 * Observable per-camera live model. Combines the REST CameraDTO (identity,
 * capabilities) with realtime data fed in from `state`/`telemetry` messages and
 * the subscribed video track. Drives the grid tiles and full-screen view.
 * Port of the iOS LiveCamera (@Published → Compose snapshot state; all writes
 * happen on the main thread via RoomManager's scope).
 */
package com.foresight.viewer.realtime

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.foresight.viewer.contract.CameraCapabilities
import com.foresight.viewer.contract.CameraDTO
import com.foresight.viewer.contract.Foresight
import com.foresight.viewer.contract.QualityPreset
import com.foresight.viewer.contract.StateMessage
import com.foresight.viewer.contract.TelemetryMessage
import com.foresight.viewer.contract.ThermalState
import com.foresight.viewer.contract.WifiInfo
import io.livekit.android.room.participant.RemoteParticipant
import io.livekit.android.room.track.VideoTrack

@Stable
class LiveCamera(info: CameraDTO) {
    val id: String = info.id

    /** Last-known REST metadata (name, capabilities, etc.). */
    var info: CameraDTO by mutableStateOf(info)
        private set

    /** The remote participant publishing this camera, once present in the room. */
    var participant: RemoteParticipant? by mutableStateOf(null)

    /** The subscribed video track (null until subscribed / while paused). */
    var videoTrack: VideoTrack? by mutableStateOf(null)

    /** Whether the camera participant is currently connected to the room. */
    var isConnected: Boolean by mutableStateOf(false)

    /**
     * True when LiveKit reports we can't (yet) decrypt this camera's E2EE frames
     * (missing/rotating key). Drives the "Decrypting…" overlay instead of black
     * video (plan §10.3). Cleared once frames decrypt (OK).
     */
    var e2eeDecrypting: Boolean by mutableStateOf(false)

    // Realtime control state (from StateMessage)
    var torchOn: Boolean by mutableStateOf(false)
        private set
    var lens: Double by mutableStateOf(1.0)
        private set
    var zoom: Double by mutableStateOf(1.0)
        private set
    var quality: QualityPreset by mutableStateOf(QualityPreset.AUTO)
        private set
    var recording: Boolean by mutableStateOf(false)
        private set
    var talking: Boolean by mutableStateOf(false)
        private set

    // Telemetry (from TelemetryMessage; overrides stale REST status)
    var battery: Double? by mutableStateOf(info.status.battery)
        private set
    var charging: Boolean? by mutableStateOf(info.status.charging)
        private set
    var wifi: WifiInfo? by mutableStateOf(info.status.wifi)
        private set
    var thermal: ThermalState? by mutableStateOf(info.status.thermal)
        private set
    var viewerCount: Int by mutableStateOf(0)
        private set

    val name: String get() = info.name
    val capabilities: CameraCapabilities? get() = info.capabilities

    /** LiveKit participant identity for this camera (`camera:<id>`). */
    val identity: String get() = Foresight.cameraIdentity(id)

    /** Online = connected in the room OR the REST registry says online. */
    val isOnline: Boolean get() = isConnected || info.online

    fun apply(message: StateMessage) {
        torchOn = message.torchOn
        lens = message.lens
        zoom = message.zoom
        quality = message.quality
        recording = message.recording
        talking = message.talking
    }

    fun apply(message: TelemetryMessage) {
        battery = message.battery
        charging = message.charging
        wifi = message.wifi
        thermal = message.thermal
        viewerCount = message.viewerCount
    }

    /** Merge fresh REST metadata (e.g. after rename) without clobbering live data. */
    fun merge(rest: CameraDTO) {
        info = rest
        if (!isConnected) { // only trust REST status while the camera is offline
            battery = rest.status.battery
            charging = rest.status.charging
            wifi = rest.status.wifi
            thermal = rest.status.thermal
        }
    }
}
