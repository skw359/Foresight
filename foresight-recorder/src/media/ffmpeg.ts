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

/** Lines of ffmpeg stderr kept for the error report when it exits abnormally. */
const STDERR_TAIL_LINES = 20;

/** How an encoder process ended. */
export interface FfmpegExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when WE ended it (finalize / kill) rather than ffmpeg failing on its own. */
  requested: boolean;
  /** Milliseconds the process was alive. */
  ranMs: number;
  /** The last lines ffmpeg printed (warnings/errors at the configured loglevel). */
  stderrTail: string[];
}

/**
 * A running ffmpeg encoder for one camera at one geometry. The recorder spawns a
 * fresh instance per geometry (a clean segment boundary on quality changes) and
 * on crash; callers feed frames via write() and respect backpressure.
 *
 * Failures are LOUD: a non-zero exit we didn't ask for is logged at error level
 * with ffmpeg's last stderr lines (wrong ENCODER, disk full, broken build), and
 * reported to `onExit` so the recorder can surface `encoder_failing`.
 */
export class FfmpegProcess {
  private proc: ChildProcess | null = null;
  private canWrite = true;
  private closed = false;
  private requested = false;
  private startedAt = 0;
  private readonly stderrTail: string[] = [];
  private resolveExited!: () => void;
  /** Resolves once the process has exited (never rejects). */
  readonly exited: Promise<void> = new Promise((resolve) => (this.resolveExited = resolve));
  /** Date.now() when the process exited, or null while it runs. */
  exitedAt: number | null = null;

  constructor(
    private readonly binPath: string,
    private readonly args: string[],
    private readonly log: Logger,
    private readonly onExit?: (exit: FfmpegExit) => void,
  ) {}

  start(): void {
    // TZ=UTC so the %Y/%m/%d segment buckets are UTC and the server can map a
    // segment's epoch to its bucket without timezone coupling. stdout is ignored
    // (HLS writes to files); we read stderr for diagnostics.
    this.startedAt = Date.now();
    const proc = spawn(this.binPath, this.args, {
      env: { ...process.env, TZ: "UTC" },
      stdio: ["pipe", "ignore", "pipe"],
    });
    this.proc = proc;

    proc.stdin?.on("error", (err) => {
      // EPIPE when ffmpeg exits first — tolerate; the exit handler reports why.
      this.canWrite = false;
      this.log.debug("ffmpeg stdin error", { err: String(err) });
    });
    proc.stdin?.on("drain", () => {
      this.canWrite = true;
    });
    proc.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) {
        const msg = line.trim();
        if (!msg) continue;
        this.stderrTail.push(msg);
        if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
        this.log.debug("ffmpeg", { line: msg });
      }
    });
    proc.on("close", (code, signal) => this.handleExit(code, signal));
    proc.on("error", (err) => {
      // Spawn failure (ENOENT: wrong FFMPEG_PATH). No 'close' follows.
      this.stderrTail.push(String(err));
      this.log.error("ffmpeg spawn error — check FFMPEG_PATH", { err: String(err), ffmpeg: this.binPath });
      this.handleExit(null, null);
    });
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitedAt !== null) return;
    this.closed = true;
    this.canWrite = false;
    this.exitedAt = Date.now();
    const exit: FfmpegExit = {
      code,
      signal,
      requested: this.requested,
      ranMs: this.exitedAt - this.startedAt,
      stderrTail: [...this.stderrTail],
    };
    if (code !== 0 && !this.requested) {
      this.log.error("ffmpeg encoder exited unexpectedly", {
        code,
        signal,
        ranMs: exit.ranMs,
        stderr: exit.stderrTail.join("\n"),
      });
    } else if (code !== 0 && code !== null) {
      this.log.warn("ffmpeg encoder exited non-zero while finalizing", {
        code,
        stderr: exit.stderrTail.join("\n"),
      });
    } else {
      this.log.debug("ffmpeg closed", { code, signal });
    }
    this.resolveExited();
    this.onExit?.(exit);
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
   * `writable` is true again rather than buffer unbounded). A write that
   * returns false because of backpressure was still QUEUED.
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
    if (!proc || this.closed) return this.exited;
    this.requested = true;
    const timer = setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, timeoutMs);
    proc.stdin?.end();
    await this.exited;
    clearTimeout(timer);
  }

  /** Hard stop (used when the whole session tears down). */
  kill(): void {
    this.requested = true;
    if (this.proc && !this.proc.killed) this.proc.kill("SIGKILL");
  }
}

/**
 * Check the configured ffmpeg at boot: present, runnable, and carrying the
 * configured encoder. Returns a short description, or throws with the reason.
 */
export async function probeFfmpeg(binPath: string, encoder: string): Promise<string> {
  const run = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      const p = spawn(binPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d: Buffer) => (out += d.toString()));
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
    });
  const version = (await run(["-hide_banner", "-version"])).split("\n")[0]?.trim() ?? "ffmpeg";
  const encoders = await run(["-hide_banner", "-encoders"]);
  if (!new RegExp(`\\b${encoder.replace(/[^\w]/g, "")}\\b`).test(encoders)) {
    throw new Error(`${version} has no "${encoder}" encoder (ENCODER=${encoder})`);
  }
  return version;
}
