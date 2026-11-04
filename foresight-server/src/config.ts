/**
 * Central configuration, loaded once from environment variables (.env via
 * dotenv). Fails fast if a required secret is missing.
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Resolve the SQLite `file:` URL to an absolute path. Prisma 7's CLI resolves a
 * relative DATABASE_URL against the directory containing prisma.config.ts (the
 * project root), so we mirror that here for the runtime driver adapter to open
 * the exact same file the migrations were applied to.
 */
function resolveSqlitePath(databaseUrl: string): string {
  const raw = databaseUrl.replace(/^file:/, "");
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(projectRoot, raw);
}

const databaseUrl = process.env.DATABASE_URL ?? "file:./dev.db";

// The LiveKit URL the server knows. On a single-box dev setup this is a
// loopback address — fine for the server, but NOT reachable by a phone or
// browser scanning a QR code. `livekitPublicUrl` is what we advertise to those
// clients (pairing tickets + /rt/token); it falls back to `livekitUrl` so
// nothing breaks when the two are the same machine.
const livekitUrl = required("LIVEKIT_URL");
const livekitPublicUrl = process.env.LIVEKIT_PUBLIC_URL?.trim() || livekitUrl;

export const config = {
  port: Number(process.env.PORT ?? 3199),
  databaseUrl,
  sqlitePath: resolveSqlitePath(databaseUrl),
  jwtSecret: required("JWT_SECRET"),
  livekitUrl,
  // URL advertised to cameras/viewers. Must be reachable from the device, not
  // "localhost" — set LIVEKIT_PUBLIC_URL to the LiveKit server's LAN address.
  livekitPublicUrl,
  livekitApiKey: required("LIVEKIT_API_KEY"),
  livekitApiSecret: required("LIVEKIT_API_SECRET"),
  // Optional last-resort fallback for the QR pairing base URL. The dashboard
  // setting and per-request auto-detection both take precedence over this, so
  // it is no longer required to boot.
  publicServerUrl: process.env.PUBLIC_SERVER_URL ?? null,

  // ----------------------------------------------------------- Recording
  // The loopback control API of the foresight-recorder process. The webhook
  // and the recording toggle fire arm/disarm here (fire-and-forget). Defaults
  // to the recorder's documented default port.
  recorderUrl: (process.env.RECORDER_URL ?? "http://127.0.0.1:3399").replace(/\/$/, ""),
  // Shared secret sent on every control call (and required on the server's own
  // /internal/* reconcile route). When unset, server↔recorder calls are
  // disabled (the recorder's own LiveKit events + reconcile still cover it),
  // which keeps tests and recorder-less deployments booting cleanly.
  recorderSharedSecret: process.env.RECORDER_SHARED_SECRET?.trim() || null,
  // Where the recorder writes HLS segments. The server reads this same tree to
  // generate playlists and serve segments/clips. Absolute path recommended;
  // relative is resolved against the server project root.
  recordingsDir: process.env.RECORDINGS_DIR
    ? path.resolve(process.env.RECORDINGS_DIR)
    : path.resolve(projectRoot, "recordings"),
  // ffmpeg used by the clip-download route to remux a range into MP4. Defaults
  // to "ffmpeg" on PATH (apt/brew installs land there); when there is no system
  // ffmpeg, point FFMPEG_PATH at the recorder's bundled binary
  // (foresight-recorder/bin/ffmpeg, or ffmpeg.exe on Windows).
  ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
} as const;

export type Config = typeof config;
