/**
 * Per-camera recording state machine (one per armed camera, owned by a
 * RoomSession). Turns a sequence of remote video tracks into a continuous,
 * crash-tolerant HLS recording.
 *
 *         arm()
 *   IDLE ───────▶ AWAITING_TRACK ──onVideoTrack──▶ RECORDING
 *                      ▲                               │  │ frame → pacer → ffmpeg
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
 * ── Timing (REC-02) ──
 * ffmpeg's rawvideo input stamps frame N at N / fps, so every frame goes
 * through a FramePacer that places it on the constant-rate timeline by its REAL
 * timestamp (repeating the previous frame into empty slots, dropping extras).
 * Media time tracks wall time whatever rate the camera, the network or the
 * encoder delivers. A gap too long to fill, or an encoder that can't keep up,
 * starts a fresh encoder (and, for the latter, a lower output frame rate).
 *
 * ── Respawn safety (REC-05) ──
 * Segment names have one-second resolution and a new encoder names its first
 * segment by its spawn second, so a new encoder may only start AFTER the
 * previous one has fully exited and in a LATER wall-clock second — otherwise it
 * would overwrite the previous encoder's last segment.
 *
 * ── Health (REC-04) ──
 * Repeated unexpected encoder exits, or no finished segment for too long while
 * frames are flowing, put the camera in ENCODER_FAILING (logged at error level
 * and shown on /status + the dashboard) instead of silently reporting
 * "recording".
 *
 * ── E2EE gate + watchdog states (shared/E2EE.md §8.2) ──
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
import { buildHlsArgs, FfmpegProcess, type FfmpegExit } from "../media/ffmpeg.js";
import {
  isLarger,
  resolveTargetGeometry,
  type Geometry,
} from "../media/geometry.js";
import { FramePacer } from "../media/pacer.js";
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
  | "encoder_failing"
  | "stopped";

/** Gate states set by the RoomSession when a Home has no usable key. */
export type GateState = "awaiting_consent" | "revoked";

/** The encoder surface CameraRecorder needs (FfmpegProcess; fakes in tests). */
export interface Encoder {
  start(): void;
  write(buf: Uint8Array): boolean;
  readonly writable: boolean;
  readonly isClosed: boolean;
  readonly exited: Promise<void>;
  readonly exitedAt: number | null;
  finalize(): Promise<void>;
}

export interface CameraRecorderDeps {
  createEncoder?: (args: string[], log: Logger, onExit: (exit: FfmpegExit) => void) => Encoder;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** mtime (ms) of the live playlist ffmpeg rewrites after each segment, or null. */
  playlistMtime?: () => number | null;
}

/** Minimum gap between ffmpeg (re)spawn attempts after a crash, to avoid spawn storms. */
const SPAWN_BACKOFF_MS = 1000;
/** Unexpected exits within this long of spawning count toward ENCODER_FAILING. */
const QUICK_EXIT_MS = 30_000;
/** Consecutive quick exits that mark the encoder as failing. */
const FAILING_AFTER_EXITS = 3;
/** Lowest output frame rate the overload back-off will step down to. */
const MIN_FPS = 5;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class CameraRecorder {
  state: RecorderState = "idle";
  private ffmpeg: Encoder | null = null;
  /** The most recently retired/crashed encoder — the next spawn waits on it (REC-05). */
  private previous: Encoder | null = null;
  private spawnPending = false;
  private spawnGeneration = 0;
  private pacer: FramePacer | null = null;
  /** Last frame written (or dropped by the pacer), repeated into empty slots. */
  private lastFrame: Uint8Array | null = null;
  /** Output frame rate of the live encoder; lowered when the host can't keep up. */
  private outFps = config.fps;
  /** Frames had to be skipped because the encoder's stdin was backpressured. */
  private backpressured = false;
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
  private repeatedFrames = 0;
  private lastSpawnAt = 0;
  private startedAt: number | null = null;
  private lastFrameAt = 0;
  private lastSegmentAt: number | null = null;
  private quickExits = 0;
  private encoderSpawns = 0;
  private lastProgressCheckAt = 0;
  private lastEncoderError: string | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private readonly frameStallMs = Math.max(1000, config.frameStallSeconds * 1000);
  /** No finished segment for this long while frames flow ⇒ the encoder is not writing. */
  private readonly segmentStallMs = Math.max(20_000, config.segmentSeconds * 3_000 + 5_000);
  private readonly log: Logger;
  private readonly createEncoder: NonNullable<CameraRecorderDeps["createEncoder"]>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly playlistMtime: () => number | null;

  constructor(
    private readonly homeId: string,
    private readonly cameraId: string,
    deps: CameraRecorderDeps = {},
  ) {
    this.log = rootLog.child({ mod: "cameraRecorder", homeId, cameraId });
    this.createEncoder =
      deps.createEncoder ?? ((args, log, onExit) => new FfmpegProcess(config.ffmpegPath, args, log, onExit));
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? realSleep;
    const playlist = livePlaylistPath(homeId, cameraId);
    this.playlistMtime =
      deps.playlistMtime ??
      (() => {
        try {
          return fs.statSync(playlist).mtimeMs;
        } catch {
          return null;
        }
      });
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
    if (this.state !== "encoder_failing") this.state = "recording";
    this.startedAt ??= this.now();
    this.lastFrameAt = this.now();
    this.startWatchdog();
    this.log.info("recording started/resumed");

    void pumpVideo(track, (data, w, h, ts) => this.sink(data, w, h, ts), abort.signal, this.log).finally(
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
    this.spawnGeneration++; // cancel any pending spawn
    this.pumpAbort?.abort();
    this.pumpAbort = null;
    this.clearWatchdog();
    await this.finalizeFfmpeg();
    this.log.info("recording stopped", {
      written: this.writtenFrames,
      repeated: this.repeatedFrames,
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
      fps: this.outFps,
      writtenFrames: this.writtenFrames,
      repeatedFrames: this.repeatedFrames,
      droppedFrames: this.droppedFrames,
      encoderSpawns: this.encoderSpawns,
      lastEncoderError: this.lastEncoderError,
      lastSegmentAt: this.lastSegmentAt,
      startedAt: this.startedAt,
    };
  }

  // --- frame sink: geometry handling, pacing, backpressure, respawn ---------
  private sink(data: Uint8Array, w: number, h: number, tsUs: number): void {
    if (this.state === "stopped" || this.state === "awaiting_consent" || this.state === "revoked") {
      return;
    }
    this.lastFrameAt = this.now();
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
      if (this.target && (this.target.w !== target.w || this.target.h !== target.h)) {
        this.outFps = config.fps; // new resolution → retry the full frame rate
      }
      this.requestSpawn(w, h, target, data);
      this.droppedFrames++;
      return;
    }

    const ff = this.ffmpeg!;
    const pacer = this.pacer!;
    const decision = pacer.push(tsUs);
    if (decision.kind === "drop") {
      this.lastFrame = data; // freshest image for the next repeated slot
      return;
    }
    if (decision.kind === "resync") {
      // A gap longer than we fill (frozen video, a stall shorter than the
      // watchdog) or a clock jump: close this timeline cleanly and start a new
      // encoder at this frame, rather than writing seconds of duplicate frames.
      if (this.backpressured) this.lowerFrameRate(decision.missingSlots);
      this.log.info("frame timeline resync — starting a new segment", {
        reason: decision.reason,
        missingSlots: decision.missingSlots,
      });
      this.retireEncoder();
      this.requestSpawn(w, h, target, data);
      return;
    }

    // Emit: repeated previous frame for each empty slot, then this frame. A
    // backpressured encoder takes no more writes; whatever didn't fit stays
    // OWED to the timeline (unemit), so the next frame fills it.
    const writes = decision.repeatPrevious + 1;
    let written = 0;
    for (let i = 0; i < writes; i++) {
      if (!ff.writable) break;
      const frame = i < decision.repeatPrevious ? (this.lastFrame ?? data) : data;
      ff.write(frame); // queued even when it returns false (backpressure)
      written++;
    }
    if (written < writes) {
      pacer.unemit(writes - written);
      this.backpressured = true;
      this.droppedFrames += writes - written;
    } else {
      this.backpressured = false;
    }
    if (written === writes) this.writtenFrames++;
    this.repeatedFrames += Math.min(written, decision.repeatPrevious);
    this.lastFrame = data;
    this.checkSegmentProgress();
  }

  /** Persistent backpressure: the host can't encode this fast. Step the output rate down. */
  private lowerFrameRate(missingSlots: number): void {
    const next = Math.max(MIN_FPS, Math.floor((this.outFps * 2) / 3));
    if (next === this.outFps) return;
    this.log.warn("encoder can't keep up — lowering recording frame rate", {
      from: this.outFps,
      to: next,
      missingSlots,
      hint: "set RECORD_MAX_HEIGHT (e.g. 1080) or use a hardware ENCODER",
    });
    this.outFps = next;
  }

  /**
   * Start a new encoder for frames of `w`x`h` — but only once the previous one
   * has fully exited and the wall clock has moved past the second it exited
   * in, so the new encoder's first segment can't take the name of (and
   * overwrite) the previous encoder's last one (REC-05). Frames arriving
   * meanwhile are dropped; `firstFrame` seeds the repeat buffer.
   */
  private requestSpawn(w: number, h: number, target: Geometry, firstFrame: Uint8Array): void {
    this.lastFrame = firstFrame;
    if (this.spawnPending) return;
    this.spawnPending = true;
    const generation = ++this.spawnGeneration;
    void (async () => {
      try {
        if (this.ffmpeg && !this.ffmpeg.isClosed) this.retireEncoder();
        const prev = this.previous;
        if (prev) {
          await prev.exited;
          const exitedAt = prev.exitedAt ?? this.now();
          const nextSecond = (Math.floor(exitedAt / 1000) + 1) * 1000;
          const wait = nextSecond - this.now();
          if (wait > 0) await this.sleep(wait);
        }
        // Crash loop guard: don't hammer a binary that dies on start.
        const sinceLast = this.now() - this.lastSpawnAt;
        if (this.quickExits > 0 && sinceLast < SPAWN_BACKOFF_MS) await this.sleep(SPAWN_BACKOFF_MS - sinceLast);
      } finally {
        this.spawnPending = false;
      }
      if (generation !== this.spawnGeneration) return; // superseded / stopped
      if (this.state === "stopped" || this.state === "awaiting_consent" || this.state === "revoked") return;
      if (this.state === "reacquiring" || this.state === "stalled") return; // the next frame respawns
      this.spawnFfmpeg(w, h, target);
    })();
  }

  private spawnFfmpeg(w: number, h: number, target: Geometry): void {
    const args = buildHlsArgs({
      width: w,
      height: h,
      targetWidth: target.w,
      targetHeight: target.h,
      fps: this.outFps,
      encoder: config.encoder,
      segmentSeconds: config.segmentSeconds,
      segmentTemplate: segmentTemplate(this.homeId, this.cameraId),
      playlistPath: livePlaylistPath(this.homeId, this.cameraId),
    });
    const ff = this.createEncoder(args, this.log, (exit) => this.onEncoderExit(ff, exit));
    ff.start();
    this.ffmpeg = ff;
    this.pacer = new FramePacer(this.outFps, Math.max(1, Math.round(this.outFps * 2)));
    this.geometry = { w, h };
    this.target = target;
    this.lastSpawnAt = this.now();
    this.encoderSpawns++;
    if (this.state !== "encoder_failing") this.state = "recording";
    this.log.info("ffmpeg encoder started", {
      w,
      h,
      outW: target.w,
      outH: target.h,
      fps: this.outFps,
      encoder: config.encoder,
    });
  }

  /** Encoder exit bookkeeping: crash-loop detection → ENCODER_FAILING (REC-04). */
  private onEncoderExit(ff: Encoder, exit: FfmpegExit): void {
    if (this.ffmpeg === ff) {
      this.ffmpeg = null;
      this.previous = ff;
    }
    if (exit.requested || exit.code === 0) {
      if (exit.ranMs >= QUICK_EXIT_MS) this.quickExits = 0;
      return;
    }
    this.lastEncoderError = exit.stderrTail.slice(-3).join(" | ") || `exit ${exit.code ?? exit.signal}`;
    this.quickExits = exit.ranMs < QUICK_EXIT_MS ? this.quickExits + 1 : 1;
    if (this.quickExits >= FAILING_AFTER_EXITS && this.state !== "stopped" && this.state !== "encoder_failing") {
      this.state = "encoder_failing";
      this.log.error("encoder failing repeatedly — recording is NOT being written", {
        exits: this.quickExits,
        lastError: this.lastEncoderError,
        ffmpeg: config.ffmpegPath,
        encoder: config.encoder,
      });
    }
  }

  /**
   * ffmpeg rewrites live.m3u8 each time it finishes a segment. Frames flowing
   * but no finished segment for several segment lengths ⇒ the encoder is alive
   * but not producing footage (full disk, wedged process).
   */
  private checkSegmentProgress(): void {
    const t = this.now();
    if (t - this.lastProgressCheckAt < 1000) return; // one stat per second is plenty
    this.lastProgressCheckAt = t;
    const mtime = this.playlistMtime();
    if (mtime !== null && mtime >= this.lastSpawnAt) {
      if (this.lastSegmentAt === null || mtime > this.lastSegmentAt) {
        this.lastSegmentAt = mtime;
        if (this.state === "encoder_failing") {
          this.state = "recording";
          this.quickExits = 0;
          this.log.info("encoder recovered — segments are being written again");
        }
      }
      return;
    }
    const since = this.now() - Math.max(this.lastSpawnAt, this.lastSegmentAt ?? 0);
    if (this.ffmpeg && since > this.segmentStallMs && this.state === "recording") {
      this.state = "encoder_failing";
      this.log.error("no segment written while frames are flowing — check disk space and ffmpeg", {
        sinceMs: since,
        lastError: this.lastEncoderError,
      });
    }
  }

  /** Finalize the live encoder in the background; the next spawn waits for it. */
  private retireEncoder(): void {
    const ff = this.ffmpeg;
    this.ffmpeg = null;
    this.pacer = null;
    this.geometry = null;
    this.target = null;
    if (ff) {
      this.previous = ff;
      void ff.finalize();
    }
  }

  private async finalizeFfmpeg(): Promise<void> {
    const ff = this.ffmpeg;
    this.retireEncoder();
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
      if (this.state !== "recording" && this.state !== "encoder_failing") return;
      const idle = this.now() - this.lastFrameAt;
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
    if (this.state !== "recording" && this.state !== "encoder_failing") return;
    this.clearWatchdog();
    this.state = "stalled";
    this.log.warn("frame watchdog: stalled — finalizing open segment", {
      reason,
      idleMs: this.now() - this.lastFrameAt,
    });
    void this.finalizeFfmpeg();
  }
}
