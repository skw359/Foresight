/*
 * Owns the LiveKit connection for one Home room (`home:<homeId>`). Subscribes
 * to camera video tracks, routes control commands over the reliable DATA
 * channel (ForesightCodec + CommandMessage), ingests `state`/`telemetry` data
 * messages, and manages push-to-talk mic publishing. Port of the iOS
 * RoomManager.
 *
 * E2EE (plan §7.4, §3.2 — the locked contract):
 *  - keyEpoch ≥ 1 requires an unlocked identity + our sealed HMK BEFORE
 *    connecting; never connect plaintext into an activated Home.
 *  - The HMK is applied as setSharedKey(base64(HMK)) — a base64 STRING
 *    (LiveKit's PBKDF2 path), never raw bytes — ALWAYS at key index 0.
 *  - One BaseKeyProvider reused across reconnects and rotations, so a live
 *    re-setSharedKey re-keys the in-flight frame cryptors.
 *  - Media-only: E2EEOptions encrypts frames; the SDK's @Beta
 *    dataChannelEncryptionEnabled stays FALSE so commands/telemetry/rekey stay
 *    readable by all Foresight clients (plan §2.3 — do not change this until
 *    every client migrates together).
 */
package com.foresight.viewer.realtime

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.foresight.viewer.contract.CameraDTO
import com.foresight.viewer.contract.CameraStatus
import com.foresight.viewer.contract.CommandAction
import com.foresight.viewer.contract.CommandArgs
import com.foresight.viewer.contract.CommandMessage
import com.foresight.viewer.contract.DataMessage
import com.foresight.viewer.contract.Foresight
import com.foresight.viewer.contract.ForesightCodec
import com.foresight.viewer.contract.ForesightE2EE
import com.foresight.viewer.contract.ParticipantRole
import com.foresight.viewer.contract.QualityPreset
import com.foresight.viewer.contract.RekeyMessage
import com.foresight.viewer.contract.StateMessage
import com.foresight.viewer.contract.TelemetryMessage
import com.foresight.viewer.crypto.B64
import com.foresight.viewer.network.ApiClient
import com.foresight.viewer.network.ApiException
import com.foresight.viewer.session.Session
import io.livekit.android.LiveKit
import io.livekit.android.RoomOptions
import io.livekit.android.e2ee.BaseKeyProvider
import io.livekit.android.e2ee.E2EEOptions
import io.livekit.android.e2ee.E2EEState
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.participant.RemoteParticipant
import io.livekit.android.room.track.DataPublishReliability
import io.livekit.android.room.track.RemoteTrackPublication
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoQuality
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import livekit.LivekitModels.Encryption
import livekit.org.webrtc.FrameCryptorKeyDerivationAlgorithm

class RoomManager(
    context: Context,
    private val homeId: String,
    private val api: ApiClient,
    private val session: Session,
) {
    sealed interface ConnectionPhase {
        data object Idle : ConnectionPhase
        data object Connecting : ConnectionPhase
        data object Connected : ConnectionPhase
        data class Failed(val message: String) : ConnectionPhase
        data object Disconnected : ConnectionPhase

        /**
         * E2EE-activated Home, but our sealed Home Media Key hasn't arrived yet
         * (a member on the web must grant this device access — plan §10.3).
         */
        data object AwaitingKey : ConnectionPhase

        /**
         * E2EE-activated Home, but the identity key isn't in memory — the user
         * must re-unlock (biometric / password) before we can decrypt (§7.4).
         */
        data object Locked : ConnectionPhase
    }

    var phase: ConnectionPhase by mutableStateOf(ConnectionPhase.Idle)
        private set

    /** Live cameras keyed by cameraId, ordered for stable grid layout. */
    var cameras: List<LiveCamera> by mutableStateOf(emptyList())
        private set

    /** True while the local mic is published (push-to-talk active). */
    var isTalking: Boolean by mutableStateOf(false)
        private set

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val camerasById = mutableMapOf<String, LiveCamera>()

    val room: Room = LiveKit.create(
        appContext = context.applicationContext,
        options = RoomOptions(adaptiveStream = true, dynacast = true),
    )

    // E2EE (plan §7.4)
    /**
     * Shared-key provider fed to LiveKit. Created once when the Home is E2EE-
     * activated; the SAME instance is reused across reconnects and rotations so
     * re-setSharedKey-ing it live re-keys the in-flight cryptors.
     */
    private var keyProvider: BaseKeyProvider? = null

    /** True once we've applied a Home Media Key (i.e. an activated Home). */
    private var e2eeActive = false

    /** Server-side epoch bookkeeping — NEVER a LiveKit key index (locked to 0). */
    private var currentEpoch = 0

    /** Retries the token fetch while we're activated but not yet keyed. */
    private var keyRetryJob: Job? = null

    /**
     * Audio playback ("listen") toggle per camera id. Remote audio plays only
     * while its publication is subscribed, so listen == subscription state.
     */
    private val listenEnabled = mutableMapOf<String, Boolean>()

    init {
        scope.launch {
            room.events.collect { event -> onRoomEvent(event) }
        }
    }

    // MARK: - Seeding from REST

    /**
     * Seed/refresh the camera list from the REST registry. Live data already
     * gathered from the room is preserved.
     */
    fun setRestCameras(rest: List<CameraDTO>) {
        val order = mutableListOf<LiveCamera>()
        for (dto in rest) {
            val existing = camerasById[dto.id]
            if (existing != null) {
                existing.merge(dto)
                order.add(existing)
            } else {
                val cam = LiveCamera(dto)
                camerasById[dto.id] = cam
                order.add(cam)
            }
        }
        // Drop cameras that no longer exist in the registry.
        val liveIds = rest.map { it.id }.toSet()
        camerasById.keys.retainAll { it in liveIds }
        cameras = order
        // Reconcile against any participants already in the room.
        reconcileParticipants()
    }

    // MARK: - Connection lifecycle

    suspend fun connect() {
        val canConnect = phase == ConnectionPhase.Idle ||
            phase == ConnectionPhase.Disconnected ||
            phase is ConnectionPhase.Failed ||
            phase == ConnectionPhase.AwaitingKey ||
            phase == ConnectionPhase.Locked
        if (!canConnect) return

        keyRetryJob?.cancel()
        phase = ConnectionPhase.Connecting
        try {
            val rt = api.rtToken(homeId, ParticipantRole.VIEWER)
            val epoch = rt.keyEpoch ?: 0

            if (epoch >= 1) {
                // E2EE-activated Home. Set up the key BEFORE connecting so the
                // frame cryptors decrypt from the first frame (plan §3.2, §7.4).

                // 1) The identity key must be in memory. On a cold launch this
                //    triggers the biometric / password re-unlock path (§7.4).
                if (!session.ensureIdentityUnlocked()) {
                    phase = ConnectionPhase.Locked
                    return
                }

                // 2) Our sealed HMK rides the token (zero extra round-trips). A
                //    null copy in an activated Home ⇒ "awaiting key" — never
                //    connect plaintext into an E2EE Home (§6).
                val sealed = rt.sealedHomeKey
                if (sealed == null) {
                    phase = ConnectionPhase.AwaitingKey
                    scheduleKeyRetry()
                    return
                }

                // 3) Unseal with our identity, apply as a base64 string @ index 0.
                val hmk = session.vault.unsealRetained(sealed.ciphertext)
                if (hmk == null) {
                    phase = ConnectionPhase.Failed("Could not unseal the camera key. Try unlocking again.")
                    return
                }
                val provider = applyHomeMediaKey(hmk)
                currentEpoch = sealed.epoch

                // Media-only E2EE: frame encryption only; the data channel stays
                // plaintext (dataChannelEncryptionEnabled is never touched).
                room.e2eeOptions = E2EEOptions(
                    keyProvider = provider,
                    encryptionType = Encryption.Type.GCM,
                )
            } else {
                // Not activated (epoch 0/null): connect exactly as today, no e2ee.
                room.e2eeOptions = null
            }

            room.connect(url = rt.livekitUrl, token = rt.token)
            phase = ConnectionPhase.Connected
            reconcileParticipants()
        } catch (e: Exception) {
            phase = ConnectionPhase.Failed((e as? ApiException)?.message ?: (e.message ?: "Connection failed."))
        }
    }

    fun disconnect() {
        keyRetryJob?.cancel()
        keyRetryJob = null
        listenEnabled.clear()
        camerasById.values.forEach { it.e2eeDecrypting = false }
        room.disconnect()
        phase = ConnectionPhase.Disconnected
    }

    /** Final teardown; the manager must not be used afterwards. */
    fun release() {
        disconnect()
        scope.cancel()
        room.release()
    }

    // MARK: - E2EE key application (plan §3.2 — the locked contract)

    /**
     * Build the shared-key provider (once) and apply the Home Media Key.
     *
     * LOCKED CONTRACT: the HMK is applied as a base64 STRING (LiveKit's PBKDF2
     * path), never raw bytes; the key index is 0 on every application including
     * rotation; ratchetSalt/ratchetWindowSize come from ForesightE2EE, never
     * SDK defaults (the Android default ratchetWindowSize is 16 — wrong for us).
     */
    private fun applyHomeMediaKey(hmk: ByteArray): BaseKeyProvider {
        val provider = keyProvider ?: makeKeyProvider().also { keyProvider = it }
        provider.setSharedKey(B64.encode(hmk), ForesightE2EE.KEY_INDEX)
        e2eeActive = true
        return provider
    }

    private fun makeKeyProvider(): BaseKeyProvider = BaseKeyProvider(
        ratchetSalt = ForesightE2EE.RATCHET_SALT,
        ratchetWindowSize = ForesightE2EE.RATCHET_WINDOW_SIZE,
        enableSharedKey = true,
        keyRingSize = ForesightE2EE.KEY_RING_SIZE,
        keyDerivationAlgorithm = FrameCryptorKeyDerivationAlgorithm.PBKDF2,
    )

    /**
     * Retry the token fetch (which carries the sealed key) while we're activated
     * but not yet keyed — a member on the web will seal to us shortly (§6/§10.3).
     */
    private fun scheduleKeyRetry() {
        keyRetryJob?.cancel()
        keyRetryJob = scope.launch {
            delay(6_000)
            if (phase == ConnectionPhase.AwaitingKey) connect()
        }
    }

    // MARK: - Rotation (plan §6 / §10.2 — sub-second blip accepted)

    /**
     * A `rekey` arrived. Re-fetch the sealed HMK for the new epoch, unseal, and
     * re-setSharedKey on the SAME provider (still index 0). If the new epoch
     * isn't sealed to us yet, surface "awaiting key" and retry.
     *
     * `epoch` 0 means the owner turned E2EE off. If the server confirms it,
     * reconnect plaintext: frame encryption is fixed when the room connects.
     */
    private suspend fun handleRekey(epoch: Int) {
        if (!e2eeActive || (epoch != 0 && epoch <= currentEpoch)) return
        try {
            val resp = api.homeKey(homeId)
            if (resp.epoch == 0) {
                // A concurrent rekey may have switched already.
                if (!e2eeActive) return
                e2eeActive = false
                currentEpoch = 0
                disconnect()
                connect()
                return
            }
            val sealedB64 = resp.sealedKey
            if (sealedB64 == null) {
                phase = ConnectionPhase.AwaitingKey
                scheduleKeyRetry()
                return
            }
            // Ensure the identity is still available (it should be while connected).
            if (!session.vault.isUnlocked()) {
                if (!session.ensureIdentityUnlocked()) {
                    phase = ConnectionPhase.Locked
                    return
                }
            }
            val hmk = session.vault.unsealRetained(sealedB64) ?: return
            applyHomeMediaKey(hmk)
            currentEpoch = resp.epoch
        } catch (_: Exception) {
            // Keep the current key; a reconnect will reconcile the epoch.
        }
    }

    // MARK: - Track subscription (grid = low, full-screen = high/max)

    /**
     * Subscribe to a camera's video and request a layer for its current context.
     * With adaptiveStream on, the SDK auto-manages layers from renderer size;
     * these calls still cover the non-adaptive (Pure 4K single-layer) case.
     */
    fun subscribeVideo(camera: LiveCamera, quality: VideoQuality) {
        val publication = videoPublication(camera) ?: return
        runCatching {
            publication.setSubscribed(true)
            publication.setEnabled(true)
            publication.setVideoQuality(quality)
        }
    }

    /** Pause a camera's video (grid tile off-screen / left full-screen). */
    fun pauseVideo(camera: LiveCamera) {
        val publication = videoPublication(camera) ?: return
        runCatching { publication.setEnabled(false) }
    }

    /** Set the preferred layer for an already-subscribed camera. */
    fun setVideoQuality(camera: LiveCamera, quality: VideoQuality) {
        val publication = videoPublication(camera) ?: return
        runCatching { publication.setVideoQuality(quality) }
    }

    private fun videoPublication(camera: LiveCamera): RemoteTrackPublication? {
        val participant = camera.participant ?: return null
        val pubs = participant.videoTrackPublications
        val cameraSource = pubs.firstOrNull { it.first.source == Track.Source.CAMERA }?.first
        return (cameraSource ?: pubs.firstOrNull()?.first) as? RemoteTrackPublication
    }

    private fun audioPublication(camera: LiveCamera): RemoteTrackPublication? {
        val participant = camera.participant ?: return null
        return participant.audioTrackPublications.firstOrNull()?.first as? RemoteTrackPublication
    }

    // MARK: - Listen (remote audio playback)

    /**
     * Toggle whether we hear this camera's audio: remote audio plays exactly
     * while its publication is subscribed.
     */
    fun setListen(camera: LiveCamera, enabled: Boolean) {
        listenEnabled[camera.id] = enabled
        applyListenPreference(camera.participant, camera.id)
    }

    fun isListening(camera: LiveCamera): Boolean = listenEnabled[camera.id] ?: false

    /**
     * Reconcile a camera's audio subscription with the stored listen preference.
     * Re-applied whenever an audio track (re)publishes, so auto-listen still
     * takes effect if the track arrives after the live view opened.
     */
    private fun applyListenPreference(participant: RemoteParticipant?, cameraId: String) {
        participant ?: return
        val publication = participant.audioTrackPublications.firstOrNull()?.first
            as? RemoteTrackPublication ?: return
        val enabled = listenEnabled[cameraId] ?: false
        runCatching { publication.setSubscribed(enabled) }
    }

    private fun reconcileListen(participant: RemoteParticipant, kind: Track.Kind?) {
        if (kind != Track.Kind.AUDIO) return
        val identity = participant.identity?.value ?: return
        val parsed = Foresight.parseIdentity(identity) ?: return
        if (parsed.role != ParticipantRole.CAMERA) return
        applyListenPreference(participant, parsed.id)
    }

    // MARK: - Commands (DATA channel)

    /**
     * Send a command to a specific camera over the reliable data channel,
     * addressed via destinationIdentities (matches web + iOS exactly).
     */
    suspend fun send(action: CommandAction, camera: LiveCamera, args: CommandArgs? = null): Boolean {
        val command = CommandMessage(target = camera.id, action = action, args = args)
        val data = ForesightCodec.encode(command)
        return room.localParticipant.publishData(
            data = data,
            reliability = DataPublishReliability.RELIABLE,
            identities = listOf(Participant.Identity(camera.identity)),
        ).isSuccess
    }

    // Convenience wrappers mirroring the control set.
    suspend fun setTorch(camera: LiveCamera, on: Boolean) {
        send(CommandAction.TORCH, camera, CommandArgs(on = on))
    }

    suspend fun switchLens(camera: LiveCamera, lens: Double) {
        send(CommandAction.SWITCH_LENS, camera, CommandArgs(lens = lens))
    }

    suspend fun setZoom(camera: LiveCamera, zoom: Double) {
        send(CommandAction.SET_ZOOM, camera, CommandArgs(zoom = zoom))
    }

    suspend fun setQuality(camera: LiveCamera, quality: QualityPreset) {
        send(CommandAction.SET_QUALITY, camera, CommandArgs(quality = quality))
        // Mirror to the local subscription layer per the preset mapping.
        setVideoQuality(camera, videoQualityFor(quality))
    }

    suspend fun snapshotHint(camera: LiveCamera) {
        send(CommandAction.SNAPSHOT_HINT, camera)
    }

    suspend fun startRecord(camera: LiveCamera) {
        send(CommandAction.START_RECORD, camera)
    }

    suspend fun stopRecord(camera: LiveCamera) {
        send(CommandAction.STOP_RECORD, camera)
    }

    suspend fun alarm(camera: LiveCamera, on: Boolean) {
        send(CommandAction.ALARM, camera, CommandArgs(on = on))
    }

    // MARK: - Push-to-talk

    /** Begin push-to-talk: publish the mic and notify the camera to play it. */
    suspend fun startTalking(camera: LiveCamera) {
        try {
            room.localParticipant.setMicrophoneEnabled(true)
            isTalking = true
            send(CommandAction.TALK_START, camera)
        } catch (_: Exception) {
            isTalking = false
        }
    }

    /** End push-to-talk: notify the camera, then unpublish the mic. */
    suspend fun stopTalking(camera: LiveCamera) {
        send(CommandAction.TALK_STOP, camera)
        runCatching { room.localParticipant.setMicrophoneEnabled(false) }
        isTalking = false
    }

    // MARK: - Preset → simulcast layer mapping (per PROTOCOL §5)

    companion object {
        /**
         * auto → adaptive (medium as a sensible default while adaptiveStream is
         * active), 480p → low, 1080p → high, max → high (highest available).
         * pure4k publishes a single (non-simulcast) layer, so HIGH is the only
         * layer to request.
         */
        fun videoQualityFor(preset: QualityPreset): VideoQuality = when (preset) {
            QualityPreset.AUTO -> VideoQuality.MEDIUM
            QualityPreset.P480 -> VideoQuality.LOW
            QualityPreset.P1080 -> VideoQuality.HIGH
            QualityPreset.MAX -> VideoQuality.HIGH
            QualityPreset.PURE4K -> VideoQuality.HIGH
        }
    }

    // MARK: - Participant reconciliation

    private fun reconcileParticipants() {
        room.remoteParticipants.values.forEach { attach(it) }
    }

    private fun attach(participant: RemoteParticipant) {
        val identity = participant.identity?.value ?: return
        val parsed = Foresight.parseIdentity(identity) ?: return
        if (parsed.role != ParticipantRole.CAMERA) return
        val cameraId = parsed.id
        val cam = camerasById.getOrPut(cameraId) {
            // A camera we don't yet have REST metadata for (newly paired). Create
            // a placeholder; a subsequent REST refresh fills in capabilities/name.
            val placeholder = CameraDTO(
                id = cameraId, homeId = homeId, name = "Camera",
                online = true, status = CameraStatus(), capabilities = null,
                createdAt = "",
            )
            LiveCamera(placeholder).also { cameras = cameras + it }
        }
        cam.participant = participant
        cam.isConnected = true
        cam.videoTrack = firstCameraVideoTrack(participant)
    }

    private fun detach(participant: RemoteParticipant) {
        val identity = participant.identity?.value ?: return
        val parsed = Foresight.parseIdentity(identity) ?: return
        if (parsed.role != ParticipantRole.CAMERA) return
        val cam = camerasById[parsed.id] ?: return
        cam.participant = null
        cam.isConnected = false
        cam.videoTrack = null
        cam.e2eeDecrypting = false
    }

    private fun firstCameraVideoTrack(participant: RemoteParticipant): VideoTrack? {
        val pubs = participant.videoTrackPublications
        val cameraPub = pubs.firstOrNull { it.first.source == Track.Source.CAMERA } ?: pubs.firstOrNull()
        return cameraPub?.second as? VideoTrack
    }

    private fun handleData(data: ByteArray) {
        when (val message: DataMessage? = ForesightCodec.decode(data)) {
            is StateMessage -> camerasById[message.cameraId]?.apply(message)
            is TelemetryMessage -> camerasById[message.cameraId]?.apply(message)
            is RekeyMessage ->
                // The Home Media Key rotated: re-fetch our sealed copy and re-apply
                // it. Handled deliberately (plan §6) — never ignored.
                scope.launch { handleRekey(message.epoch) }
            else -> Unit // acks/commands are not acted on by the viewer in v1
        }
    }

    // MARK: - Room events

    private suspend fun onRoomEvent(event: RoomEvent) {
        when (event) {
            is RoomEvent.Disconnected -> {
                if (phase == ConnectionPhase.Connected) phase = ConnectionPhase.Disconnected
            }

            is RoomEvent.Reconnected -> reconcileParticipants()

            is RoomEvent.ParticipantConnected -> attach(event.participant)

            is RoomEvent.ParticipantDisconnected -> detach(event.participant)

            is RoomEvent.TrackSubscribed -> {
                attach(event.participant)
                reconcileListen(event.participant, event.publication.kind)
                // A camera video publication can arrive fresh after a republish
                // (Pure 4K boundary) or a reconnect. Re-apply the camera's pinned
                // simulcast layer so the pin survives.
                if (event.publication.kind == Track.Kind.VIDEO) {
                    val identity = event.participant.identity?.value
                    val parsed = identity?.let { Foresight.parseIdentity(it) }
                    if (parsed?.role == ParticipantRole.CAMERA) {
                        camerasById[parsed.id]?.let { cam ->
                            setVideoQuality(cam, videoQualityFor(cam.quality))
                        }
                    }
                }
            }

            is RoomEvent.TrackUnsubscribed -> {
                // Refresh the track reference (may have lost the video track).
                val identity = event.participant.identity?.value
                val parsed = identity?.let { Foresight.parseIdentity(it) }
                if (parsed != null) {
                    camerasById[parsed.id]?.videoTrack = firstCameraVideoTrack(event.participant)
                }
            }

            is RoomEvent.TrackPublished -> {
                (event.participant as? RemoteParticipant)?.let { participant ->
                    attach(participant)
                    reconcileListen(participant, event.publication.kind)
                }
            }

            is RoomEvent.TrackMuted, is RoomEvent.TrackUnmuted -> {
                val participant = when (event) {
                    is RoomEvent.TrackMuted -> event.participant
                    is RoomEvent.TrackUnmuted -> event.participant
                    else -> null
                } as? RemoteParticipant
                participant?.let { p ->
                    val parsed = p.identity?.value?.let { Foresight.parseIdentity(it) }
                    if (parsed != null) {
                        camerasById[parsed.id]?.videoTrack = firstCameraVideoTrack(p)
                    }
                }
            }

            is RoomEvent.DataReceived -> handleData(event.data)

            is RoomEvent.TrackE2EEStateEvent -> applyE2EEState(event.state, event.participant)

            else -> Unit
        }
    }

    /**
     * LiveKit frame-cryptor state per track. Surfaces "Decrypting…" instead of
     * black video when we can't (yet) decrypt a camera (plan §10.3).
     * MISSING_KEY / DECRYPTION_FAILED ⇒ we don't (yet) have the right key;
     * publisher-side states and OK clear it.
     */
    private fun applyE2EEState(state: E2EEState, participant: Participant) {
        val identity = participant.identity?.value ?: return
        val parsed = Foresight.parseIdentity(identity) ?: return
        if (parsed.role != ParticipantRole.CAMERA) return
        val cam = camerasById[parsed.id] ?: return
        cam.e2eeDecrypting = state == E2EEState.MISSING_KEY ||
            state == E2EEState.DECRYPTION_FAILED ||
            state == E2EEState.INTERNAL_ERROR
    }

}
