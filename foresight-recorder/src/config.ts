/**
 * Recorder configuration, loaded once from environment (.env via dotenv).
 * Mirrors the style of foresight-server/src/config.ts. Fails fast on missing
 * required secrets so a misconfigured recorder never silently records nothing.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse a simulcast layer name, failing fast rather than silently recording the wrong one. */
function layer(name: string, fallback: "low" | "medium" | "high"): "low" | "medium" | "high" {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === undefined || v === "") return fallback;
  if (v === "low" || v === "medium" || v === "high") return v;
  throw new Error(`${name} must be one of low|medium|high (got "${v}")`);
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === undefined || v === "") return fallback;
  return v === "1" || v === "true" || v === "yes";
}

function resolveMaybeRelative(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(projectRoot, p);
}

/**
 * Resolve an executable path. A bare command name with no path separator (e.g.
 * "ffmpeg") is left as-is so the OS resolves it on PATH — this is how a globally
 * installed ffmpeg works. Anything that looks like a path ("./bin/ffmpeg",
 * "C:\\tools\\ffmpeg.exe") is resolved relative to the project root if relative.
 */
function resolveExecutable(p: string): string {
  return p.includes("/") || p.includes("\\") ? resolveMaybeRelative(p) : p;
}

/**
 * Where to find ffmpeg when FFMPEG_PATH is unset. `bin/` holds an optional
 * bundled static build (see bin/README.md) — "ffmpeg.exe" on Windows, "ffmpeg"
 * everywhere else. Prefer it when present, otherwise fall back to "ffmpeg" on
 * PATH, which is the normal shape of a Linux/macOS install (apt, brew).
 *
 * Probing the filesystem here (rather than hardcoding one name) is what keeps a
 * single config correct on all three host platforms.
 */
function defaultFfmpegPath(): string {
  const bundled = path.resolve(
    projectRoot,
    "bin",
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  return fs.existsSync(bundled) ? bundled : "ffmpeg";
}

export const config = {
  // ----------------------------------------------------------- LiveKit
  // Same values the server uses. The recorder is trusted + co-located, so it
  // holds the API key/secret and mints its own hidden-subscriber tokens.
  livekitUrl: required("LIVEKIT_URL"),
  livekitApiKey: required("LIVEKIT_API_KEY"),
  livekitApiSecret: required("LIVEKIT_API_SECRET"),

  // ----------------------------------------------------------- Control API
  port: num("RECORDER_PORT", 3399),
  // Required header on every control + reconcile call (symmetric with the
  // server's RECORDER_SHARED_SECRET).
  sharedSecret: required("RECORDER_SHARED_SECRET"),

  // ----------------------------------------------------------- Media / ffmpeg
  ffmpegPath: process.env.FFMPEG_PATH
    ? resolveExecutable(process.env.FFMPEG_PATH)
    : defaultFfmpegPath(),
  // Root of the on-disk segment tree (the server reads this same path back).
  recordingsDir: resolveMaybeRelative(required("RECORDINGS_DIR")),
  // Which simulcast layer to pin the recorder's subscription to: "low" |
  // "medium" | "high". Without a pin the SFU forwards whichever layer it likes
  // and demotes it freely, so footage arrives anywhere from 240x135 to 1080p —
  // see livekit/layerPin.ts. "high" (the top layer) is what 24/7 footage wants.
  recordLayer: layer("RECORD_LAYER", "high"),
  // Ceiling on the ENCODE geometry (height in pixels, aspect preserved); 0 =
  // no cap, i.e. always record at the camera's own published resolution. Every
  // segment for a camera is encoded at one geometry regardless of which layer
  // the SFU forwards (see media/geometry.ts), so this is the knob that bounds
  // continuous-encode cost: a 4K publisher on software libx264 is far more than
  // one core per camera, and RECORD_MAX_HEIGHT=1080 keeps it affordable.
  recordMaxHeight: num("RECORD_MAX_HEIGHT", 0),
  // v1 default: video only (avoids A/V sync across two raw pipes; see plan §10).
  recordAudio: bool("RECORD_AUDIO", false),
  segmentSeconds: num("SEGMENT_SECONDS", 6),
  // Assumed input frame rate for the rawvideo pipe. Capture is fed in real time;
  // a fixed rate is fine for security footage (PTS-accurate timing is M4/M5).
  fps: num("RECORD_FPS", 30),
  // libx264 by default; set to h264_nvenc when an NVIDIA GPU is available to
  // offload the continuous encode.
  encoder: process.env.ENCODER ?? "libx264",
  audioSampleRate: num("RECORD_AUDIO_SAMPLE_RATE", 48000),
  audioChannels: num("RECORD_AUDIO_CHANNELS", 1),

  // ----------------------------------------------------------- Retention
  retentionDays: num("RETENTION_DAYS", 14),
  retentionMaxGb: num("RETENTION_MAX_GB", 500),
  minFreeGb: num("MIN_FREE_GB", 25),
  retentionIntervalMs: num("RETENTION_INTERVAL_MS", 10 * 60 * 1000),

  // ----------------------------------------------------------- Consolidation
  // Finished UTC days are consolidated into one day_<YYYYMMDD>.ts (plus a
  // .json byte index) per camera, replacing thousands of 6-second segments
  // (see storage/consolidate.ts). The live day is never touched.
  consolidateEnabled: bool("CONSOLIDATE_ENABLED", true),
  consolidateIntervalMs: num("CONSOLIDATE_INTERVAL_MS", 60 * 60 * 1000),

  // ----------------------------------------------------------- Reconcile
  // Where to ask "which cameras should be recording?" (server internal API).
  serverUrl: (process.env.SERVER_URL ?? "http://127.0.0.1:3199").replace(/\/$/, ""),
  reconcileIntervalMs: num("RECONCILE_INTERVAL_MS", 60 * 1000),

  // ----------------------------------------------------------- E2EE (Model B)
  // The recorder's X25519 identity (sk||pk, base64). The secret key at rest IS
  // the consent boundary (plan §8.3) — keep it OUTSIDE recordingsDir (which the
  // server reads back) and 0600. Default: the recorder package's own data/ dir.
  recorderKeyPath: resolveMaybeRelative(
    process.env.RECORDER_KEY_PATH ?? "./data/recorder-identity.key",
  ),
  // Frame watchdog (plan §8.2): a keyless/revoked recorder's VideoStream goes
  // silent with NO error. If no frame arrives for this long while recording,
  // finalize the open segment and mark the camera `stalled`.
  frameStallSeconds: num("FRAME_STALL_SECONDS", 15),
} as const;

export type Config = typeof config;
