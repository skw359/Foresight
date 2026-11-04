/*
 * Foresight Security — realtime control protocol (Kotlin mirror).
 *
 * Hand-kept in sync with shared/ts/src/realtime.ts (canonical). Control
 * commands, acks, state, telemetry and rekey travel over LiveKit's RELIABLE
 * data channel — deliberately decoupled from the media stream, and (per plan
 * §2.3) deliberately NOT E2EE-encrypted in v1.
 */
package com.foresight.viewer.contract

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.UUID

/** Bump when the wire format changes incompatibly. */
const val PROTOCOL_VERSION = 1

/** Actions a viewer can request of a camera. */
@Serializable
enum class CommandAction {
    @SerialName("torch") TORCH,                 // args.on
    @SerialName("switchLens") SWITCH_LENS,      // args.lens (optical factor)
    @SerialName("setZoom") SET_ZOOM,            // args.zoom (digital, >= 1)
    @SerialName("setQuality") SET_QUALITY,      // args.quality
    @SerialName("snapshotHint") SNAPSHOT_HINT,  // advisory; capture is viewer-side in v1
    @SerialName("startRecord") START_RECORD,    // advisory; recording is viewer-side in v1
    @SerialName("stopRecord") STOP_RECORD,
    @SerialName("talkStart") TALK_START,        // push-to-talk begin
    @SerialName("talkStop") TALK_STOP,          // push-to-talk end
    @SerialName("alarm") ALARM,                 // emergency sound (stubbed)
}

@Serializable
data class CommandArgs(
    val on: Boolean? = null,
    val lens: Double? = null,
    val zoom: Double? = null,
    val quality: QualityPreset? = null,
)

/** Discriminated union over `type`, mirroring DataMessage in realtime.ts. */
sealed interface DataMessage

/** viewer → camera (addressed via destinationIdentities). */
@Serializable
data class CommandMessage(
    val v: Int = PROTOCOL_VERSION,
    val type: String = "command",
    /** Unique command id (for ack correlation). */
    val id: String = UUID.randomUUID().toString(),
    /** Target camera id. */
    val target: String,
    val action: CommandAction,
    val args: CommandArgs? = null,
) : DataMessage

/** camera → viewer (in response to a command). */
@Serializable
data class AckMessage(
    val v: Int = PROTOCOL_VERSION,
    val type: String = "ack",
    val commandId: String,
    val ok: Boolean,
    val error: String? = null,
) : DataMessage

/** camera → room (broadcast on change) so every viewer stays in sync. */
@Serializable
data class StateMessage(
    val v: Int = PROTOCOL_VERSION,
    val type: String = "state",
    val cameraId: String,
    val torchOn: Boolean,
    /** Current optical lens factor. */
    val lens: Double,
    /** Current digital zoom factor (>= 1). */
    val zoom: Double,
    val quality: QualityPreset,
    val recording: Boolean,
    /** True while a viewer is speaking via push-to-talk. */
    val talking: Boolean,
) : DataMessage

/** camera → room (periodic heartbeat with health). */
@Serializable
data class TelemetryMessage(
    val v: Int = PROTOCOL_VERSION,
    val type: String = "telemetry",
    val cameraId: String,
    val battery: Double? = null,
    val charging: Boolean? = null,
    val wifi: WifiInfo? = null,
    val thermal: ThermalState? = null,
    /** Number of viewers currently subscribed. */
    val viewerCount: Int,
) : DataMessage

/**
 * rotating-client → room (reliable, broadcast). The Home Media Key rotated to
 * `epoch`: re-fetch the sealed copy and re-apply setKey(base64(HMK′)) — still
 * at LiveKit key index 0 (`epoch` is server bookkeeping, never a key index).
 * `epoch` 0 (sent by the server) means E2EE was turned off: if the server
 * confirms it, a keyed client reconnects plaintext.
 */
@Serializable
data class RekeyMessage(
    val v: Int = PROTOCOL_VERSION,
    val type: String = "rekey",
    /** The new Home.keyEpoch. */
    val epoch: Int,
) : DataMessage

// MARK: - Participant identity helpers (mirror realtime.ts)

object Foresight {
    fun homeRoom(homeId: String): String = "home:$homeId"
    fun cameraIdentity(cameraId: String): String = "camera:$cameraId"
    fun viewerIdentity(userId: String, session: String): String = "user:$userId:$session"

    data class ParsedIdentity(val role: ParticipantRole, val id: String)

    /**
     * Inverse of the *Identity helpers; null for unknown formats. Mirrors the
     * canonical TS `identity.split(":")` destructure: the id is the SECOND
     * segment only (for `user:<userId>:<sessionId>` that is the userId — the
     * session suffix is dropped, exactly like the web client).
     */
    fun parseIdentity(identity: String): ParsedIdentity? {
        val parts = identity.split(":")
        if (parts.size < 2 || parts[1].isEmpty()) return null
        return when (parts[0]) {
            "camera" -> ParsedIdentity(ParticipantRole.CAMERA, parts[1])
            "user" -> ParsedIdentity(ParticipantRole.VIEWER, parts[1])
            else -> null
        }
    }
}

// MARK: - (de)serialization

/**
 * JSON (de)serialization for LiveKit data payloads. Mirrors ForesightCodec in
 * the Swift apps / encodeDataMessage-decodeDataMessage in TS: UTF-8 JSON with a
 * `type` discriminator; unknown or malformed messages decode to null (older
 * clients must ignore newer message types).
 */
object ForesightCodec {
    private val json: Json = ForesightJson

    fun encode(message: DataMessage): ByteArray = when (message) {
        is CommandMessage -> json.encodeToString(CommandMessage.serializer(), message)
        is AckMessage -> json.encodeToString(AckMessage.serializer(), message)
        is StateMessage -> json.encodeToString(StateMessage.serializer(), message)
        is TelemetryMessage -> json.encodeToString(TelemetryMessage.serializer(), message)
        is RekeyMessage -> json.encodeToString(RekeyMessage.serializer(), message)
    }.encodeToByteArray()

    fun decode(bytes: ByteArray): DataMessage? = try {
        val element = json.parseToJsonElement(bytes.decodeToString())
        when (element.jsonObject["type"]?.jsonPrimitive?.content) {
            "command" -> json.decodeFromJsonElement(CommandMessage.serializer(), element)
            "ack" -> json.decodeFromJsonElement(AckMessage.serializer(), element)
            "state" -> json.decodeFromJsonElement(StateMessage.serializer(), element)
            "telemetry" -> json.decodeFromJsonElement(TelemetryMessage.serializer(), element)
            "rekey" -> json.decodeFromJsonElement(RekeyMessage.serializer(), element)
            else -> null
        }
    } catch (_: Exception) {
        null
    }
}
