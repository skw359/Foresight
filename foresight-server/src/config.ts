/**
 * Central configuration, loaded once from environment variables (.env via
 * dotenv). Fails fast if a required secret is missing.
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkSecret, insecureDevMode } from "./lib/secrets.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Problems tolerated only because FORESIGHT_INSECURE_DEV=1; printed loudly at boot. */
export const insecureWarnings: string[] = [];

/**
 * A required secret that must not be a published placeholder or short. Refuses
 * to boot otherwise (see lib/secrets.ts) unless FORESIGHT_INSECURE_DEV=1.
 */
function strongSecret(name: string): string {
  const value = required(name);
  const problem = checkSecret(name, value);
  if (problem) insecureWarnings.push(problem);
  return value;
}

function optionalStrongSecret(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  const problem = checkSecret(name, value);
  if (problem) insecureWarnings.push(problem);
  return value;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** true / false / null (unset → let the admin decide at runtime). */
function triState(name: string): boolean | null {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === undefined || v === "") return null;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`${name} must be true or false (got "${v}")`);
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
  jwtSecret: strongSecret("JWT_SECRET"),
  // Session lifetime. Sessions are also revocable server-side (User.tokenVersion).
  sessionTtl: process.env.SESSION_TTL?.trim() || "14d",
  insecureDev: insecureDevMode(),
  livekitUrl,
  // URL advertised to cameras/viewers. Must be reachable from the device, not
  // "localhost" — set LIVEKIT_PUBLIC_URL to the LiveKit server's LAN address.
  livekitPublicUrl,
  livekitApiKey: required("LIVEKIT_API_KEY"),
  livekitApiSecret: strongSecret("LIVEKIT_API_SECRET"),
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
  recorderSharedSecret: optionalStrongSecret("RECORDER_SHARED_SECRET"),
  // The internal (server↔recorder) API listens on its OWN loopback-only port,
  // never on the public one, so a reverse proxy or the LAN can't reach it.
  internalPort: num("INTERNAL_PORT", 3198),

  // ----------------------------------------------------------- Access policy
  // Registration: true = always open, false = always closed (the very first
  // account can still be created), unset = the server admin decides from the
  // dashboard (closed by default once an admin exists).
  allowRegistration: triState("ALLOW_REGISTRATION"),
  // Comma-separated browser origins allowed to call the API cross-origin
  // (e.g. a separately hosted dashboard). Unset: same-origin plus loopback dev
  // origins only. "*" reflects any origin (the API uses bearer tokens, not
  // cookies, but an allow-list is still the safer default).
  corsOrigins: (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean),
  // Behind a reverse proxy, trust X-Forwarded-* so rate limits key on the real
  // client address. Leave off when clients connect directly.
  trustProxy: triState("TRUST_PROXY") ?? false,
  // Brute-force / abuse limits on unauthenticated endpoints. Only disable for tests.
  rateLimitEnabled: triState("RATE_LIMIT") ?? true,
  // Concurrent argon2 operations (each holds a libuv thread that fs I/O also needs).
  argon2Concurrency: Math.max(1, num("ARGON2_CONCURRENCY", 2)),
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
  // Clip export limits: longest range per export, concurrent exports server-wide
  // and per user (a full-retention re-encode would otherwise pin every core).
  clipMaxSeconds: num("CLIP_MAX_SECONDS", 2 * 60 * 60),
  clipMaxConcurrent: Math.max(1, num("CLIP_MAX_CONCURRENT", 2)),
  clipMaxPerUser: Math.max(1, num("CLIP_MAX_PER_USER", 1)),
} as const;

export type Config = typeof config;
