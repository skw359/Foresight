/**
 * Per-camera recording state machine (one per armed camera, owned by a
 * RoomSession). Turns a sequence of remote video tracks into a continuous,
 * crash-tolerant HLS recording.
 *
 *         arm()
 *   IDLE ───────▶ AWAITING_TRACK ──onVideoTrack──▶ RECORDING
 *                      ▲                               │  │ frame → ffmpeg
 *      onTrackGone     │                               │  ▼ geometry change → restart ffmpeg
 *   (republish, blip)  └──────── REACQUIRING ◀─────────┘     (clean segment boundary)
 *                                   │ onVideoTrack
 *                              stop()│
 *                                   ▼
 *                                STOPPED
 *
 * Track churn is EXPECTED: the iOS client unpublishes+republishes its video
 * track on every quality change, so TrackUnsubscribed means "pause, keep the
 * session" and the next TrackSubscribed means "resume into a fresh segment" —
 * never crash the session or corrupt a file.
 *
 * ── E2EE gate + watchdog states (E2EE_MODEL_B_PLAN.md §8.2) ──
 * A Home the recorder holds no key for is held keyless — the RoomSession does
 * not even connect it, so it burns zero CPU:
 *   AWAITING_CONSENT — activated Home (epoch ≥ 1) with no HMK sealed to us.
 *   REVOKED          — recorder consent was revoked for this Home.
 * A keyed recorder that goes silent (revocation mid-session, or a decrypt
 * failure) does NOT error — VideoStream just stops yielding. The frame watchdog
 * catches that: no frame for `frameStallSeconds` while RECORDING ⇒ finalize the
 * open segment and mark STALLED (frames resuming return it to RECORDING).
 */
import fs from "node:fs";
import type { RemoteTrack } from "@livekit/rtc-node";
import { buildHlsArgs, FfmpegProcess } from "../media/ffmpeg.js";
import {
  isLarger,
  resolveTargetGeometry,
  type Geometry,
} from "../media/geometry.js";
import { pumpVideo } from "../media/videoPipe.js";
import { cameraDir, livePlaylistPath, segmentTemplate } from "../storage/layout.js";
import { config } from "../config.js";
import { log as rootLog, type Logger } from "../log.js";

export type RecorderState =
  | "idle"
  | "awaiting_track"
  | "recording"
  | "reacquiring"
  | "stalled"
  | "awaiting_consent"
  | "revoked"
  | "stopped";

/** Gate states set by the RoomSession when a Home has no usable key. */
export type GateState = "awaiting_consent" | "revoked";

/** Minimum gap between ffmpeg (re)spawn attempts, to avoid spawn storms. */
const SPAWN_BACKOFF_MS = 1000;

export class CameraRecorder {
  state: RecorderState = "idle";
  private ffmpeg: FfmpegProcess | null = null;
  /** Geometry of the frames the LIVE encoder was spawned for (its rawvideo -s). */
  private geometry: Geometry | null = null;
  /** Geometry the LIVE encoder is writing segments at (see media/geometry.ts). */
  private target: Geometry | null = null;
  /** Publication geometry from the SFU's TrackInfo — what the phone says it sends. */
  private declared: Geometry | null = null;
  /** Largest frame seen for this camera; the target fallback when nothing is declared. */
  private largestSeen: Geometry | null = null;
  private pumpAbort: AbortController | null = null;
  private droppedFrames = 0;
  private writtenFrames = 0;
  private lastSpawnAt = 0;
  private startedAt: number | null = null;
  private lastFrameAt = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private readonly frameStallMs = Math.max(1000, config.frameStallSeconds * 1000);
  private readonly log: Logger;

  constructor(
    private readonly homeId: string,
    private readonly cameraId: string,
  ) {
    this.log = rootLog.child({ mod: "cameraRecorder", homeId, cameraId });
  }

  /** Armed: room is connected, waiting for the camera's video track to arrive. */
  arm(): void {
    if (this.state === "stopped") return;
    if (this.state === "idle" || this.state === "awaiting_consent" || this.state === "revoked") {
      this.state = "awaiting_track";
    }
    try {
      fs.mkdirSync(cameraDir(this.homeId, this.cameraId), { recursive: true });
    } catch (err) {
      this.log.error("failed to create camera dir", { err: String(err) });
    }
  }

  /**
   * Hold this camera keyless (no key sealed to the recorder, or revoked). The
   * RoomSession does not connect a keyless Home, so no frames arrive; we just
   * finalize any open segment and park in the gate state for /status (§8.2).
   */
  enterGate(state: GateState): void {
    if (this.state === "stopped") return;
    this.pumpAbort?.abort();
    this.pumpAbort = null;
    this.clearWatchdog();
    this.state = state;
    void this.finalizeFfmpeg();
    this.log.info("held keyless", { state });
  }

  /**
   * A video track became available — begin (or resume) capture into a segment.
   *
   * `declared` is the publication's geometry as the SFU reports it (TrackInfo
   * width/height): the resolution the phone says it is publishing, which is the
   * resolution we encode at no matter which layer actually arrives.
   */
  onVideoTrack(track: RemoteTrack, declared?: Geometry | null): void {
    if (this.state === "stopped" || this.state === "awaiting_consent" || this.state === "revoked") {
      return;
    }
    if (declared && declared.w > 0 && declared.h > 0) this.declared = declared;
    // Replace any previous pump (defensive; normally there is none).
    this.pumpAbort?.abort();
    const abort = new AbortController();
    this.pumpAbort = abort;
    this.state = "recording";
    this.startedAt ??= Date.now();
    this.lastFrameAt = Date.now();
    this.startWatchdog();
    this.log.info("recording started/resumed");

    void pumpVideo(track, (data, w, h) => this.sink(data, w, h), abort.signal, this.log).finally(
      () => {
        // Pump ended: either the track went away or we aborted. If this was the
        // active pump (not superseded), drop to reacquiring and close the segment.
        if (this.pumpAbort === abort && this.state !== "stopped") {
          this.onTrackGone();
        }
      },
    );
  }

  /** The track went away (republish on quality change, blip). Pause cleanly. */
  onTrackGone(): void {
    if (this.state === "stopped" || this.state === "awaiting_consent" || this.state === "revoked") {
      return;
    }
    this.pumpAbort?.abort();
    this.pumpAbort = null;
    this.clearWatchdog();
    this.state = "reacquiring";
    this.log.info("track gone — pausing, awaiting republish");
    void this.finalizeFfmpeg(); // close the current segment cleanly
  }

  /**
   * Explicit encryption signal from the SDK (EncryptionError /
   * ParticipantEncryptionStatusChanged(false)) — a faster, non-timeout path into
   * the same finalize-and-stall behaviour as the frame watchdog (§8.2).
   */
  onEncryptionStall(reason: string): void {
    this.stall(reason);
  }

  /**
   * Cut a clean HLS segment boundary (used at a live key rotation, §8.2): finalize
   * the current encoder so its last segment closes; the next frame spawns a fresh
   * encoder → a new segment at the rotation timestamp.
   */
  cutSegment(): void {
    if (this.state !== "recording") return;
    void this.finalizeFfmpeg();
    this.log.info("cut segment boundary (rotation)");
  }

  /** Stop for good (disarm / session teardown). Flushes the last segment. */
  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "stopped";
    this.pumpAbort?.abort();
    this.pumpAbort = null;
    this.clearWatchdog();
    await this.finalizeFfmpeg();
    this.log.info("recording stopped", {
      written: this.writtenFrames,
      dropped: this.droppedFrames,
    });
  }

  status() {
    return {
      cameraId: this.cameraId,
      homeId: this.homeId,
      state: this.state,
      // `geometry` is the INPUT (the layer the SFU is forwarding); `target` is
      // what lands on disk. They differ whenever a layer is being scaled up.
      geometry: this.geometry,
      target: this.target,
      declared: this.declared,
      writtenFrames: this.writtenFrames,
      droppedFrames: this.droppedFrames,
      startedAt: this.startedAt,
    };
  }

  // --- frame sink: geometry handling + backpressure + crash respawn ---------
  private sink(data: Uint8Array, w: number, h: number): void {
    if (this.state === "stopped" || this.state === "awaiting_consent" || this.state === "revoked") {
      return;
    }
    this.lastFrameAt = Date.now();
    if (this.state === "stalled") {
      this.state = "recording";
      this.log.info("frames resumed after stall");
    }
    this.startWatchdog();

    if (isLarger({ w, h }, this.largestSeen)) this.largestSeen = { w, h };
    const target = resolveTargetGeometry({
      declared: this.declared,
      largestSeen: this.largestSeen ?? { w, h },
      maxHeight: config.recordMaxHeight,
    });

    const needSpawn =
      !this.ffmpeg ||
      this.ffmpeg.isClosed ||
      !this.geometry ||
      this.geometry.w !== w ||
      this.geometry.h !== h ||
      // A target change (the camera republished at a different resolution) must
      // also cut a new encoder — the output geometry is baked into the SPS.
      this.target?.w !== target.w ||
      this.target?.h !== target.h;

    if (needSpawn) {
      const now = Date.now();
      // Crash respawn / geometry change. Throttle to avoid spawn storms when
      // ffmpeg fails to start (e.g. bad path).
      if (this.ffmpeg?.isClosed && now - this.lastSpawnAt < SPAWN_BACKOFF_MS) {
        this.droppedFrames++;
        return;
      }
      this.spawnFfmpeg(w, h, target);
    }

    const ff = this.ffmpeg;
    if (!ff || !ff.writable) {
      // Backpressure (or transient): drop this frame rather than buffer unbounded.
      this.droppedFrames++;
      return;
    }
    ff.write(data);
    this.writtenFrames++;
  }

  private spawnFfmpeg(w: number, h: number, target: Geometry): void {
    // Finalize the previous encoder (fire-and-forget) so its last segment closes;
    // a fresh encoder starts a new segment at the new geometry — no corruption.
    const previous = this.ffmpeg;
    if (previous && !previous.isClosed) void previous.finalize();

    const args = buildHlsArgs({
      width: w,
      height: h,
      targetWidth: target.w,
      targetHeight: target.h,
      fps: config.fps,
      encoder: config.encoder,
      segmentSeconds: config.segmentSeconds,
      segmentTemplate: segmentTemplate(this.homeId, this.cameraId),
      playlistPath: livePlaylistPath(this.homeId, this.cameraId),
    });
    const ff = new FfmpegProcess(config.ffmpegPath, args, this.log);
    ff.start();
    this.ffmpeg = ff;
    this.geometry = { w, h };
    this.target = target;
    this.lastSpawnAt = Date.now();
    this.state = "recording";
    this.log.info("ffmpeg encoder started", {
      w,
      h,
      outW: target.w,
      outH: target.h,
      encoder: config.encoder,
    });
  }

  private async finalizeFfmpeg(): Promise<void> {
    const ff = this.ffmpeg;
    this.ffmpeg = null;
    this.geometry = null;
    this.target = null;
    if (ff) await ff.finalize();
  }

  // --- frame watchdog (§8.2): silent-stream detection ------------------------
  /**
   * A self-rescheduling timer (not per-frame churn) that fires when no frame has
   * arrived for `frameStallMs` while RECORDING. `.unref()` so it never keeps the
   * process alive; it self-terminates whenever state leaves "recording".
   */
  private startWatchdog(): void {
    if (this.watchdog) return;
    const tick = (): void => {
      this.watchdog = null;
      if (this.state !== "recording") return;
      const idle = Date.now() - this.lastFrameAt;
      if (idle >= this.frameStallMs) {
        this.stall("no_frames");
        return;
      }
      this.watchdog = setTimeout(tick, Math.max(1000, this.frameStallMs - idle));
      this.watchdog.unref();
    };
    this.watchdog = setTimeout(tick, this.frameStallMs);
    this.watchdog.unref();
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  /** Finalize the open segment and park in STALLED (recoverable on next frame). */
  private stall(reason: string): void {
    if (this.state !== "recording") return;
    this.clearWatchdog();
    this.state = "stalled";
    this.log.warn("frame watchdog: stalled — finalizing open segment", {
      reason,
      idleMs: Date.now() - this.lastFrameAt,
    });
    void this.finalizeFfmpeg();
  }
}
