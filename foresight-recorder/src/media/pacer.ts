/**
 * Constant-frame-rate pacing for the rawvideo pipe (REC-02).
 *
 * ffmpeg's rawvideo input has no timestamps: frame N is stamped N / fps. The
 * recorder would otherwise write frames whenever they arrive, so whenever FEWER
 * than `fps` frames per second arrive — the camera's 20 fps 480p preset, WebRTC
 * lowering the frame rate under congestion, frames dropped under encoder
 * backpressure — the media timeline would run fast: 20 fps in, 6 s of media per
 * 9 s of wall clock, footage played back 1.5x and segment durations disagreeing
 * with their wall-clock names.
 *
 * The pacer maps each frame's REAL timestamp onto the constant-rate output
 * timeline: output slot k is CENTRED on t0 + k/fps (so on-rate input with a
 * little timestamp jitter maps one-to-one). A frame is written into the slot
 * its timestamp falls in; empty slots before it are
 * filled by repeating the previous frame; a second frame landing in an
 * already-filled slot is dropped. Media time therefore tracks wall time
 * exactly, whatever rate frames arrive at.
 *
 * Pure and deterministic (timestamps in, decisions out) so it is unit-tested
 * directly; CameraRecorder owns the writes.
 */

export type PaceDecision =
  /** Write the previous frame `repeatPrevious` times, then this frame. */
  | { kind: "emit"; repeatPrevious: number }
  /** This frame's slot is already filled — don't write it (keep it as the latest image). */
  | { kind: "drop" }
  /**
   * Can't continue this timeline: the gap is longer than the pacer may fill
   * (`gap`) or the timestamps jumped backwards (`clock`). Start a new encoder
   * with this frame as its first.
   */
  | { kind: "resync"; reason: "gap" | "clock"; missingSlots: number };

export class FramePacer {
  private t0Us: number | null = null;
  /** Output slots already written (or committed to be written). */
  private emitted = 0;
  private lastTsUs = 0;
  private readonly slotUs: number;

  constructor(
    readonly fps: number,
    /** Most empty slots one gap may be filled with before a resync (bounds write bursts). */
    readonly maxFillSlots: number,
  ) {
    this.slotUs = 1_000_000 / fps;
  }

  /** Output frames on the timeline so far. */
  get framesEmitted(): number {
    return this.emitted;
  }

  /** Media duration written so far, in seconds. */
  get mediaSeconds(): number {
    return this.emitted / this.fps;
  }

  /** Decide what to do with a frame captured at `tsUs` (microseconds, any monotonic epoch). */
  push(tsUs: number): PaceDecision {
    if (this.t0Us === null) {
      this.t0Us = tsUs;
      this.lastTsUs = tsUs;
      this.emitted = 1;
      return { kind: "emit", repeatPrevious: 0 };
    }
    // More than a slot backwards means the clock jumped (a small backwards
    // jitter just lands in an already-filled slot below and is dropped).
    if (tsUs < this.lastTsUs - this.slotUs) {
      return { kind: "resync", reason: "clock", missingSlots: 0 };
    }
    this.lastTsUs = Math.max(this.lastTsUs, tsUs);
    const slot = Math.round((tsUs - this.t0Us) / this.slotUs);
    const target = slot + 1;
    if (target <= this.emitted) return { kind: "drop" };
    const missing = target - this.emitted - 1;
    if (missing > this.maxFillSlots) return { kind: "resync", reason: "gap", missingSlots: missing };
    this.emitted = target;
    return { kind: "emit", repeatPrevious: missing };
  }

  /**
   * Give back `n` slots the caller could not write (encoder backpressure). They
   * stay owed: the next frame fills them, so a slow encoder costs repeated
   * frames — or, past maxFillSlots, a resync — never a sped-up timeline.
   */
  unemit(n: number): void {
    this.emitted = Math.max(1, this.emitted - Math.max(0, n));
  }
}

/**
 * The timestamp to pace a frame by. The SDK's per-frame capture/render
 * timestamp (microseconds, local monotonic clock) keeps the frames' real
 * spacing even when the Node event loop delivers them in a burst; when it is
 * missing (0) we fall back to the arrival time.
 */
export function frameTimestampUs(sdkTimestampUs: bigint | number | undefined, arrivalUs: number): number {
  const ts = typeof sdkTimestampUs === "bigint" ? Number(sdkTimestampUs) : (sdkTimestampUs ?? 0);
  return Number.isFinite(ts) && ts > 0 ? ts : arrivalUs;
}
