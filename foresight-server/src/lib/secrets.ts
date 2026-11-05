/**
 * Secret hygiene, isolated from config.ts so it can be unit-tested without
 * loading the environment.
 *
 * The templates (.env.example, infra/livekit.example.yaml) and LiveKit's own
 * `--dev` mode ship well-known values. A server left on them can be fully
 * taken over by anyone who can reach it: forged session JWTs for any user,
 * LiveKit tokens for any Home room, forged webhooks, and the recorder's key
 * directory. So the server refuses to boot on a placeholder or short secret
 * unless FORESIGHT_INSECURE_DEV=1 explicitly opts into a throwaway dev setup.
 */
import { timingSafeEqual, createHash } from "node:crypto";

/** Values shipped in templates or documented defaults. Never acceptable in production. */
export const PLACEHOLDER_SECRETS: ReadonlySet<string> = new Set([
  "secret",
  "devkey",
  "change-me",
  "changeme",
  "change-me-to-a-long-random-string",
  "change-me-recorder-secret",
  "test-secret",
  "test-recorder-secret",
]);

/** Minimum length for generated secrets (`openssl rand -hex 32` gives 64). */
export const MIN_SECRET_LENGTH = 32;

export function insecureDevMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.FORESIGHT_INSECURE_DEV?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Why `value` is unacceptable as a secret, or null when it is fine. */
export function secretProblem(value: string, minLength = MIN_SECRET_LENGTH): string | null {
  if (PLACEHOLDER_SECRETS.has(value.trim().toLowerCase())) return "is a published placeholder value";
  if (value.length < minLength) return `is shorter than ${minLength} characters`;
  return null;
}

/**
 * Validate a secret read from the environment. Throws (refusing to boot) when
 * it is a placeholder or too short, unless insecure dev mode is on, in which
 * case the problem is returned so the caller can warn loudly.
 */
export function checkSecret(
  name: string,
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  minLength = MIN_SECRET_LENGTH,
): string | null {
  const problem = secretProblem(value, minLength);
  if (!problem) return null;
  const message =
    `${name} ${problem}. Generate one with \`openssl rand -hex 32\` ` +
    `(LiveKit keys must also be changed in infra/livekit.yaml). ` +
    `For a throwaway local setup only, set FORESIGHT_INSECURE_DEV=1.`;
  if (insecureDevMode(env)) return message;
  throw new Error(message);
}

/**
 * Constant-time string comparison for shared secrets. Both sides are hashed
 * first so the comparison is length-independent (timingSafeEqual requires
 * equal-length inputs and would otherwise leak the length).
 */
export function secretsEqual(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** SHA-256 hex of a high-entropy token (device secrets); the indexed lookup key. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
