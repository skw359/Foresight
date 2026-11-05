/**
 * Owns LiveKit room connections. One RoomSession per Home (a single rtc-node
 * Room), and within it one CameraRecorder per armed camera. Connects lazily on
 * the first arm and disconnects when the last camera disarms, so idle Homes hold
 * no media sockets.
 *
 * Subscription is manual (autoSubscribe:false): we subscribe ONLY to armed
 * cameras' tracks. Being a permanent subscriber is what keeps the phone
 * publishing 24/7 (dynacast pauses unsubscribed layers).
 *
 * Every video subscription is also PINNED to one simulcast layer
 * (config.recordLayer, default "high" — see livekit/layerPin.ts). Without the
 * pin the SFU forwards and demotes layers at will, and the recorder ends up
 * writing 240x135 footage for a phone that is publishing 1080p.
 *
 * ── E2EE (Model B, E2EE_MODEL_B_PLAN.md §8) ──
 * The connect + key decision is driven by the KeyManager's per-Home state:
 *   epoch 0 / unknown  → plaintext home, connect exactly as today (no e2ee).
 *   epoch ≥ 1 + HMK    → connect with the locked encryption options (§3.2).
 *   epoch ≥ 1 + no HMK → awaiting_consent: do NOT connect, do NOT spawn ffmpeg
 *                        (keyless homes burn zero CPU — §8.2).
 *   revoked            → finalize + disconnect, hold `revoked`.
 * A new HMK at a higher epoch on a connected home is applied live via
 * KeyProvider.setSharedKey(key, 0) with a clean segment boundary (§8.2/§8.4).
 * E2EE turned off (epoch back to 0) on a keyed connection → reconnect plaintext.
 *
 * ── Self-healing (REC-01) ──
 * A room can drop for good (LiveKit restarted, a partition longer than the
 * SDK's own retry window). Recording must not depend on a webhook to come back:
 * a terminal Disconnected schedules a reconnect with capped exponential backoff
 * while any camera is armed, and every reconcile pass runs healthCheck(), which
 * re-syncs any armed Home whose room is not connected.
 */
import {
  Room,
  RoomEvent,
  TrackKind,
  EncryptionType,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RoomOptions,
  type E2EEOptions,
} from "@livekit/rtc-node";
import {
  parseIdentity,
  E2EE_KEY_INDEX,
  E2EE_KEY_RING_SIZE,
  E2EE_RATCHET_SALT,
  E2EE_RATCHET_WINDOW_SIZE,
} from "@foresight/contract";
import { recorderToken, type RecorderToken } from "./token.js";
import { CameraRecorder } from "./cameraRecorder.js";
import { pinVideoQuality } from "./layerPin.js";
import { KeyManager, liveKitSharedKey } from "../crypto/keyManager.js";
import { config } from "../config.js";
import { log as rootLog, type Logger } from "../log.js";

/**
 * Finite so a keyless/revoked stream surfaces as a decrypt failure rather than
 * silently retrying forever (§8.2). rtc-node's default is -1 (infinite) — the
 * plan requires we override it explicitly.
 */
const FAILURE_TOLERANCE = 300;
const RATCHET_SALT_BYTES = new TextEncoder().encode(E2EE_RATCHET_SALT);
/** livekit.proto.KeyDerivationFunction.PBKDF2 — the §3.2 string-key parity path. */
const KEY_DERIVATION_FUNCTION_PBKDF2 = 0;

/**
 * rtc-node 0.13.29's TS KeyProviderOptions predates its own pinned FFI proto
 * (@livekit/rtc-ffi-bindings 0.12.60), whose proto2 KeyProviderOptions marks
 * key_ring_size and key_derivation_function `required` — leaving them unset
 * makes every encrypted connect throw at encode time ("cannot encode field
 * livekit.proto.KeyProviderOptions.key_ring_size to binary"). The options
 * object is fed straight into the proto constructor, which picks fields up by
 * name, so supplying them here works even though the TS type omits them.
 */
type FfiKeyProviderOptions = E2EEOptions["keyProviderOptions"] & {
  keyRingSize: number;
  keyDerivationFunction: number;
};

/**
 * Build the locked E2EE connect options (§3.2). Every value is set explicitly —
 * rtc-node's defaultKeyProviderOptions (ratchetWindowSize 16, failureTolerance
 * -1) must NOT be trusted.
 */
function encryptionOptions(hmkBase64: string): E2EEOptions {
  const keyProviderOptions: FfiKeyProviderOptions = {
    // ⚠ utf8 bytes of the base64 STRING — NOT the raw 32 HMK bytes (§3.2).
    sharedKey: liveKitSharedKey(hmkBase64),
    ratchetSalt: RATCHET_SALT_BYTES,
    ratchetWindowSize: E2EE_RATCHET_WINDOW_SIZE, // 0 — no auto-ratcheting in v1
    failureTolerance: FAILURE_TOLERANCE,
    // Ring CAPACITY of the native key provider (web hardcodes the same 16).
    // Key indices stay locked to E2EE_KEY_INDEX = 0 in v1 regardless (§3.2).
    keyRingSize: E2EE_KEY_RING_SIZE,
    // PBKDF2, not HKDF — must match the derivation web/Swift apply to the
    // base64-string key, or frames silently fail to decrypt (§3.2).
    keyDerivationFunction: KEY_DERIVATION_FUNCTION_PBKDF2,
  };
  return {
    keyProviderOptions,
    encryptionType: EncryptionType.GCM,
  };
}

/** Reconnect backoff after a terminal room disconnect: 1 s doubling to 30 s, ±20 % jitter. */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + 0.4 * random()));
}

/** Injection points (tests use fakes; production uses the real SDK). */
export interface RoomManagerDeps {
  createRoom?: () => Room;
  mintToken?: (homeId: string) => Promise<RecorderToken>;
  createRecorder?: (homeId: string, cameraId: string) => CameraRecorder;
}

class RoomSession {
  private room: Room | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  /** True while held keyless on purpose (awaiting consent / revoked) — not a fault to heal. */
  private heldKeyless = false;
  private readonly recorders = new Map<string, CameraRecorder>(); // cameraId → recorder
  /** epoch we are currently connected with (0 = plaintext), or null if not connected. */
  private connectedEpoch: number | null = null;
  /** base64(HMK) currently applied to the key provider, or null when plaintext/keyless. */
  private appliedHmk: string | null = null;
  /**
   * Publications already pinned, so a republish pins once rather than on every
   * subscribe/reconnect callback. Weak so a gone publication is collectable.
   */
  private readonly pinned = new WeakSet<RemoteTrackPublication>();
  private readonly log: Logger;

  constructor(
    private readonly homeId: string,
    private readonly keyManager: KeyManager,
    private readonly deps: RoomManagerDeps = {},
  ) {
    this.log = rootLog.child({ mod: "room", homeId });
  }

  get armedCameraIds(): string[] {
    return [...this.recorders.keys()];
  }

  isEmpty(): boolean {
    return this.recorders.size === 0;
  }

  statuses() {
    return [...this.recorders.values()].map((r) => r.status());
  }

  async arm(cameraId: string): Promise<void> {
    if (!this.recorders.has(cameraId)) {
      this.recorders.set(
        cameraId,
        this.deps.createRecorder?.(this.homeId, cameraId) ?? new CameraRecorder(this.homeId, cameraId),
      );
    }
    await this.syncKey();
  }

  async disarm(cameraId: string): Promise<void> {
    const rec = this.recorders.get(cameraId);
    if (!rec) return;
    this.recorders.delete(cameraId);
    this.setSubscribed(cameraId, false);
    await rec.stop();
    if (this.isEmpty()) {
      this.cancelReconnect();
      await this.disconnect();
    }
  }

  async stopAll(): Promise<void> {
    this.cancelReconnect();
    for (const rec of this.recorders.values()) await rec.stop();
    this.recorders.clear();
    await this.disconnect();
  }

  /**
   * Reconcile backstop: an armed session whose room is not connected (and is
   * not deliberately held keyless or already connecting) is re-synced now.
   */
  async healthCheck(): Promise<void> {
    if (this.isEmpty() || this.connecting || this.heldKeyless) return;
    if (this.room?.isConnected) return;
    this.log.warn("armed but not connected — reconnecting", { attempt: this.reconnectAttempt });
    await this.syncKey();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.isEmpty()) return;
    const delay = reconnectDelayMs(this.reconnectAttempt++);
    this.log.info("scheduling room reconnect", { delayMs: delay, attempt: this.reconnectAttempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.syncKey().catch((err) => {
        this.log.warn("room reconnect failed", { err: String(err) });
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref();
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** A room dropped without us asking: pause recorders, then reconnect with backoff. */
  private onRoomDisconnected(room: Room): void {
    if (this.room !== room) return; // our own disconnect()/reconnect — not a fault
    this.log.warn("room disconnected unexpectedly — will reconnect", { armed: this.recorders.size });
    this.room = null;
    this.connectedEpoch = null;
    this.appliedHmk = null;
    for (const rec of this.recorders.values()) rec.onTrackGone();
    this.scheduleReconnect();
  }

  /**
   * Reconcile the live room connection + key to the KeyManager's current state
   * for this Home. The single entry point for connect / hold / rotate / revoke;
   * safe to call repeatedly (idempotent).
   */
  async syncKey(): Promise<void> {
    if (this.isEmpty()) {
      this.cancelReconnect();
      return;
    }
    const key = this.keyManager.getHomeKey(this.homeId);

    // Not activated (epoch 0) or unknown → plaintext home, connect as today.
    if (!key || key.epoch === 0) {
      await this.activate(null, 0);
      return;
    }
    if (key.revoked) {
      await this.holdKeyless("revoked");
      return;
    }
    if (key.hmkBase64 === null) {
      await this.holdKeyless("awaiting_consent");
      return;
    }
    await this.activate(key.hmkBase64, key.epoch);
  }

  /**
   * Bring the room up (or forward) for a plaintext (hmk=null) or keyed home, and
   * mark every recorder active. Handles first connect, live rotation, and the
   * plaintext↔activated transitions.
   */
  private async activate(hmkBase64: string | null, epoch: number): Promise<void> {
    this.heldKeyless = false;
    if (!this.room?.isConnected) {
      try {
        await this.ensureConnected(hmkBase64, epoch);
      } catch (err) {
        this.scheduleReconnect();
        throw err;
      }
    } else if (this.connectedEpoch === 0 && hmkBase64 !== null) {
      // Home activated while we were connected plaintext — cannot add E2EE to a
      // live plaintext room; reconnect with encryption.
      this.log.info("home activated while connected plaintext — reconnecting with e2ee");
      await this.reconnect(hmkBase64, epoch);
    } else if (hmkBase64 === null && this.connectedEpoch !== 0) {
      // E2EE turned off while we were connected with encryption — the cameras
      // now publish plaintext, which a keyed connection can't record.
      this.log.info("e2ee turned off while connected encrypted — reconnecting plaintext");
      await this.reconnect(null, 0);
    } else if (hmkBase64 !== null && this.appliedHmk !== hmkBase64) {
      await this.rotate(hmkBase64, epoch);
    }

    for (const [cameraId, rec] of this.recorders) {
      rec.arm();
      this.trySubscribe(cameraId);
    }
  }

  /** Keyless (awaiting_consent / revoked): never connect; hold recorders + drop any live room. */
  private async holdKeyless(state: "awaiting_consent" | "revoked"): Promise<void> {
    this.heldKeyless = true;
    this.cancelReconnect();
    for (const rec of this.recorders.values()) rec.enterGate(state);
    if (this.room) await this.disconnect();
    this.connectedEpoch = null;
    this.appliedHmk = null;
  }

  /** Live key rotation at index 0 (§3.2/§8.4). Falls back to reconnect if the cast fails. */
  private async rotate(hmkBase64: string, epoch: number): Promise<void> {
    const room = this.room;
    const mgr = room?.e2eeManager;
    if (mgr) {
      try {
        // The installed @livekit/rtc-node types E2EEManager.keyProvider as
        // `private` (dist/e2ee.d.ts). It is a normal runtime property; access it
        // via one localized cast (plan §8.4 — prefer the cast, reconnect only if
        // it fails). keyIndex is ALWAYS 0 in v1 (§3.2) — epoch is bookkeeping.
        const kp = (mgr as unknown as {
          keyProvider: { setSharedKey(key: Uint8Array, keyIndex: number): void };
        }).keyProvider;
        kp.setSharedKey(liveKitSharedKey(hmkBase64), E2EE_KEY_INDEX);
        this.appliedHmk = hmkBase64;
        this.connectedEpoch = epoch;
        for (const rec of this.recorders.values()) rec.cutSegment();
        this.log.info("rotated shared key live", { epoch, keyIndex: E2EE_KEY_INDEX });
        return;
      } catch (err) {
        this.log.warn("live rotation cast failed — reconnecting", { err: String(err) });
      }
    }
    await this.reconnect(hmkBase64, epoch);
  }

  private async reconnect(hmkBase64: string | null, epoch: number): Promise<void> {
    await this.disconnect();
    await this.ensureConnected(hmkBase64, epoch);
    for (const [cameraId, rec] of this.recorders) {
      rec.arm();
      this.trySubscribe(cameraId);
    }
  }

  private async ensureConnected(hmkBase64: string | null, epoch: number): Promise<void> {
    if (this.room?.isConnected) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const tok = await (this.deps.mintToken ?? recorderToken)(this.homeId);
      const room = this.deps.createRoom?.() ?? new Room();
      this.wireEvents(room);
      const opts: RoomOptions = { autoSubscribe: false, dynacast: true };
      if (hmkBase64 !== null) opts.encryption = encryptionOptions(hmkBase64);
      try {
        await room.connect(tok.url, tok.token, opts);
      } catch (err) {
        room.removeAllListeners();
        throw err;
      }
      this.room = room;
      this.connectedEpoch = hmkBase64 !== null ? epoch : 0;
      this.appliedHmk = hmkBase64;
      this.reconnectAttempt = 0;
      this.cancelReconnect();
      this.log.info("connected to room", {
        room: tok.room,
        identity: tok.identity,
        e2ee: hmkBase64 !== null,
        epoch: this.connectedEpoch,
      });
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private wireEvents(room: Room): void {
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub, participant) => {
      const cameraId = cameraIdOf(participant);
      const rec = cameraId ? this.recorders.get(cameraId) : undefined;
      if (!rec) return;
      if (track.kind === TrackKind.KIND_VIDEO) {
        // Re-pin here as well as at subscribe time: this is the point at which
        // the SFU actually has a downtrack to apply the preference to.
        this.pinLayer(pub as RemoteTrackPublication);
        // The publication's own geometry is the resolution the phone says it is
        // sending, and so the geometry we encode every segment at.
        rec.onVideoTrack(track, publishedGeometry(pub as RemoteTrackPublication));
      }
      // Audio is captured only when enabled (v1: off). M4 wires the audio pump.
    });

    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, participant) => {
      const cameraId = cameraIdOf(participant);
      const rec = cameraId ? this.recorders.get(cameraId) : undefined;
      if (rec && track.kind === TrackKind.KIND_VIDEO) rec.onTrackGone();
    });

    // A camera (re)published a track — subscribe if it is armed.
    room.on(RoomEvent.TrackPublished, (pub: RemoteTrackPublication, participant) => {
      const cameraId = cameraIdOf(participant);
      if (cameraId && this.recorders.has(cameraId)) this.subscribePublication(pub);
    });

    room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
      const cameraId = cameraIdOf(participant);
      if (cameraId && this.recorders.has(cameraId)) this.trySubscribe(cameraId);
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      const cameraId = cameraIdOf(participant);
      const rec = cameraId ? this.recorders.get(cameraId) : undefined;
      rec?.onTrackGone();
    });

    // E2EE observability (§8.2): a keyless/revoked stream goes silent rather than
    // erroring, but when the SDK DOES surface a decrypt failure, use it as a fast
    // explicit signal into the same finalize-and-stall path as the watchdog.
    room.on(RoomEvent.ParticipantEncryptionStatusChanged, (isEncrypted, participant) => {
      if (isEncrypted) return;
      const cameraId = cameraIdOf(participant);
      const rec = cameraId ? this.recorders.get(cameraId) : undefined;
      rec?.onEncryptionStall("participant_unencrypted");
    });

    room.on(RoomEvent.EncryptionError, (err: Error) => {
      this.log.warn("encryption error", { err: String(err) });
      for (const rec of this.recorders.values()) rec.onEncryptionStall("encryption_error");
    });

    room.on(RoomEvent.Disconnected, () => this.onRoomDisconnected(room));
    room.on(RoomEvent.Reconnecting, () => this.log.warn("room reconnecting"));
    room.on(RoomEvent.Reconnected, () => {
      this.log.info("room reconnected — resubscribing");
      for (const cameraId of this.recorders.keys()) this.trySubscribe(cameraId);
    });
  }

  /** Look up a camera's participant by identity (no Map-key assumption). */
  private participantOf(cameraId: string): RemoteParticipant | undefined {
    const room = this.room;
    if (!room) return undefined;
    for (const p of room.remoteParticipants.values()) {
      if (cameraIdOf(p) === cameraId) return p;
    }
    return undefined;
  }

  private trySubscribe(cameraId: string): void {
    const participant = this.participantOf(cameraId);
    if (!participant) return; // not joined yet — handled on connect/publish
    for (const pub of participant.trackPublications.values()) {
      this.subscribePublication(pub as RemoteTrackPublication);
    }
  }

  private subscribePublication(pub: RemoteTrackPublication): void {
    if (pub.kind === TrackKind.KIND_VIDEO) {
      pub.setSubscribed(true);
      this.pinLayer(pub);
    } else if (config.recordAudio && pub.kind === TrackKind.KIND_AUDIO) {
      pub.setSubscribed(true);
    }
  }

  /**
   * Pin this video publication to config.recordLayer. Logged once per
   * publication so a recorder silently stuck on a low layer is diagnosable,
   * then never retried — an unpinned subscription still records.
   */
  private pinLayer(pub: RemoteTrackPublication): void {
    if (this.pinned.has(pub)) return;
    this.pinned.add(pub);
    const ok = pinVideoQuality(pub, config.recordLayer, this.log);
    this.log.info("pinned subscription layer", {
      layer: config.recordLayer,
      sid: pub.sid,
      declared: publishedGeometry(pub),
      ok,
    });
  }

  private setSubscribed(cameraId: string, subscribed: boolean): void {
    const participant = this.participantOf(cameraId);
    if (!participant) return;
    for (const pub of participant.trackPublications.values()) {
      (pub as RemoteTrackPublication).setSubscribed(subscribed);
    }
  }

  private async disconnect(): Promise<void> {
    const room = this.room;
    this.room = null;
    this.connectedEpoch = null;
    this.appliedHmk = null;
    if (room) {
      try {
        await room.disconnect();
      } catch {
        /* already gone */
      }
      this.log.info("disconnected from room");
    }
  }
}

/**
 * The publication's declared geometry (TrackInfo width/height), or null when the
 * SFU reports none — the recorder then falls back to the largest frame it sees.
 */
function publishedGeometry(pub: RemoteTrackPublication): { w: number; h: number } | null {
  const w = pub.width ?? 0;
  const h = pub.height ?? 0;
  return w > 0 && h > 0 ? { w, h } : null;
}

// Accepts any participant-like (RemoteParticipant or the base Participant that
// the encryption-status event carries) — we only read the identity.
function cameraIdOf(participant: { identity: string }): string | null {
  const parsed = parseIdentity(participant.identity);
  return parsed?.role === "camera" ? parsed.id : null;
}

/** Top-level: routes arm/disarm to the right per-Home session. */
export class RoomManager {
  private readonly sessions = new Map<string, RoomSession>(); // homeId → session
  private readonly log = rootLog.child({ mod: "roomManager" });

  constructor(
    private readonly keyManager: KeyManager,
    private readonly deps: RoomManagerDeps = {},
  ) {}

  async arm(homeId: string, cameraId: string): Promise<void> {
    let session = this.sessions.get(homeId);
    if (!session) {
      session = new RoomSession(homeId, this.keyManager, this.deps);
      this.sessions.set(homeId, session);
    }
    await session.arm(cameraId);
    this.log.info("armed", { homeId, cameraId });
  }

  async disarm(homeId: string, cameraId: string): Promise<void> {
    const session = this.sessions.get(homeId);
    if (!session) return;
    await session.disarm(cameraId);
    if (session.isEmpty()) this.sessions.delete(homeId);
    this.log.info("disarmed", { homeId, cameraId });
  }

  /**
   * Re-sync a Home's live room to the current key state (called after a reconcile
   * detects a rotation / revocation / grant, or on a control push).
   */
  async syncHome(homeId: string): Promise<void> {
    const session = this.sessions.get(homeId);
    if (!session) return;
    await session.syncKey();
    if (session.isEmpty()) this.sessions.delete(homeId);
  }

  /** Reconcile backstop: re-sync every armed Home whose room isn't connected (REC-01). */
  async healthCheck(): Promise<void> {
    for (const [homeId, session] of this.sessions) {
      await session.healthCheck().catch((err) =>
        this.log.warn("health check reconnect failed", { homeId, err: String(err) }),
      );
    }
  }

  /** Set of "homeId/cameraId" currently armed (for reconcile diffing). */
  armedKeys(): Set<string> {
    const out = new Set<string>();
    for (const [homeId, session] of this.sessions) {
      for (const cameraId of session.armedCameraIds) out.add(`${homeId}/${cameraId}`);
    }
    return out;
  }

  status() {
    const homes: Record<string, unknown[]> = {};
    for (const [homeId, session] of this.sessions) homes[homeId] = session.statuses();
    return { homes, homeKeys: this.keyManager.summary() };
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) await session.stopAll();
    this.sessions.clear();
  }
}
