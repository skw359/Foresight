/**
 * ffmpeg integration: a pure HLS argument builder (unit-tested) plus a managed
 * long-lived ffmpeg process that consumes raw I420 video frames on stdin and
 * writes keyframe-aligned HLS segments.
 *
 * Decoded frames mean ffmpeg must re-encode continuously (one H.264 encode per
 * recording camera) — the load-bearing trade-off of using @livekit/rtc-node
 * instead of LiveKit Egress (which can remux without transcoding).
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "../log.js";

export interface HlsArgsOptions {
  /** Geometry of the raw frames on stdin — must match what the sink writes. */
  width: number;
  height: number;
  /**
   * Geometry every segment is ENCODED at, regardless of `width`/`height`. Held
   * constant for a camera across layer switches so the whole tree is one
   * continuous stream that `clip.mp4` can remux with `-c copy` (see
   * media/geometry.ts for why that matters).
   */
  targetWidth: number;
  targetHeight: number;
  fps: number;
  /** "libx264" (default) or "h264_nvenc". */
  encoder: string;
  segmentSeconds: number;
  /** ffmpeg -hls_segment_filename template (with %Y/%m/%d/seg_%s.ts + strftime). */
  segmentTemplate: string;
  /** Output playlist path (live.m3u8). */
  playlistPath: string;
  /** Rolling live-window size; segments persist on disk regardless (no delete). */
  liveListSize?: number;
}

/**
 * Scale any input geometry onto one fixed output geometry. Letterboxes instead
 * of distorting when the aspect ratios differ (a layer switch can change the
 * ratio, and stretched footage is worse than bars), and normalizes SAR so every
 * segment's SPS is byte-identical — which is what lets a range of segments
 * concatenate into a single-resolution MP4.
 */
function scaleFilter(w: number, h: number): string {
  return [
    // force_divisible_by=2 keeps the scaled box even for yuv420p; without it a
    // ratio-preserving fit can land on an odd width and ffmpeg refuses.
    `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
    "setsar=1",
  ].join(",");
}

/**
 * Build the full ffmpeg argument vector (excluding the binary path) for a
 * video-only HLS recording at a fixed input geometry. Pure + deterministic.
 */
export function buildHlsArgs(opts: HlsArgsOptions): string[] {
  const gop = Math.max(1, Math.round(opts.fps * 2));
  const isNvenc = opts.encoder.includes("nvenc");
  const encoderTuning = isNvenc
    ? ["-preset", "p4"]
    : ["-preset", "veryfast", "-tune", "zerolatency"];

  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    // --- input: raw I420 video on stdin at a fixed geometry ---
    "-f",
    "rawvideo",
    "-pix_fmt",
    "yuv420p",
    "-s",
    `${opts.width}x${opts.height}`,
    "-r",
    String(opts.fps),
    "-i",
    "pipe:0",
    // --- encode ---
    // Normalize to the target geometry FIRST: the input geometry follows
    // whatever layer the SFU forwards, the output must not.
    "-vf",
    scaleFilter(opts.targetWidth, opts.targetHeight),
    "-c:v",
    opts.encoder,
    ...encoderTuning,
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(gop),
    // Keyframe-align to segment boundaries so each segment is independently
    // playable and prunable, and range playlists can start on any segment.
    "-force_key_frames",
    `expr:gte(t,n_forced*${opts.segmentSeconds})`,
    // --- HLS output ---
    "-f",
    "hls",
    "-hls_time",
    String(opts.segmentSeconds),
    "-hls_list_size",
    String(opts.liveListSize ?? 10),
    // NOTE: no `delete_segments` flag — segments persist on disk (the server
    // synthesizes range playlists from them); only live.m3u8 rolls.
    "-hls_flags",
    "independent_segments+program_date_time+temp_file",
    "-strftime",
    "1",
    "-strftime_mkdir",
    "1",
    "-hls_segment_filename",
    opts.segmentTemplate,
    opts.playlistPath,
  ];
}

/**
 * A running ffmpeg encoder for one camera at one geometry. The recorder spawns a
 * fresh instance per geometry (a clean segment boundary on quality changes) and
 * on crash; callers feed frames via write() and respect backpressure.
 */
export class FfmpegProcess {
  private proc: ChildProcess | null = null;
  private canWrite = true;
  private closed = false;

  constructor(
    private readonly binPath: string,
    private readonly args: string[],
    private readonly log: Logger,
  ) {}

  start(): void {
    // TZ=UTC so the %Y/%m/%d segment buckets are UTC and the server can map a
    // segment's epoch to its bucket without timezone coupling. stdout is ignored
    // (HLS writes to files); we read stderr for diagnostics.
    const proc = spawn(this.binPath, this.args, {
      env: { ...process.env, TZ: "UTC" },
      stdio: ["pipe", "ignore", "pipe"],
    });
    this.proc = proc;

    proc.stdin?.on("error", (err) => {
      // EPIPE when ffmpeg exits first — tolerate; supervisor will respawn.
      this.canWrite = false;
      this.log.debug("ffmpeg stdin error", { err: String(err) });
    });
    proc.stdin?.on("drain", () => {
      this.canWrite = true;
    });
    proc.stderr?.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) this.log.debug("ffmpeg", { line: msg });
    });
    proc.on("close", (code) => {
      this.closed = true;
      this.canWrite = false;
      this.log.debug("ffmpeg closed", { code });
    });
    proc.on("error", (err) => {
      this.closed = true;
      this.canWrite = false;
      this.log.error("ffmpeg spawn error", { err: String(err) });
    });
  }

  /** True while ffmpeg is alive and its stdin is accepting writes. */
  get writable(): boolean {
    return !!this.proc?.stdin && !this.closed && this.canWrite && this.proc.stdin.writable;
  }

  /** True once the process has exited (crash or finalize). */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Write one raw frame. Returns false if it could not be written (closed) or if
   * the stream is now backpressured (caller should drop subsequent frames until
   * `writable` is true again rather than buffer unbounded).
   */
  write(buf: Uint8Array): boolean {
    const stdin = this.proc?.stdin;
    if (!stdin || this.closed || !stdin.writable) return false;
    const ok = stdin.write(buf);
    if (!ok) this.canWrite = false;
    return ok;
  }

  /** Flush + close stdin and wait for ffmpeg to finalize the last segment. */
  async finalize(timeoutMs = 5000): Promise<void> {
    const proc = this.proc;
    if (!proc || this.closed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
        resolve();
      }, timeoutMs);
      proc.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      proc.stdin?.end();
    });
    this.closed = true;
  }

  /** Hard stop (used when the whole session tears down). */
  kill(): void {
    if (this.proc && !this.proc.killed) this.proc.kill("SIGKILL");
    this.closed = true;
  }
}
