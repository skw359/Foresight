/**
 * Secret hygiene for the recorder (mirrors foresight-server/src/lib/secrets.ts).
 * The templates and LiveKit's `--dev` mode ship well-known values; a recorder
 * holding the LiveKit API secret and the server↔recorder secret must not run
 * on them. Refuses to boot unless FORESIGHT_INSECURE_DEV=1.
 */
import { createHash, timingSafeEqual } from "node:crypto";

const PLACEHOLDERS: ReadonlySet<string> = new Set([
  "secret",
  "devkey",
  "change-me",
  "changeme",
  "change-me-to-a-long-random-string",
  "change-me-recorder-secret",
  "test-secret",
  "test-recorder-secret",
]);

export const MIN_SECRET_LENGTH = 32;

export function insecureDevMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.FORESIGHT_INSECURE_DEV?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function secretProblem(value: string, minLength = MIN_SECRET_LENGTH): string | null {
  if (PLACEHOLDERS.has(value.trim().toLowerCase())) return "is a published placeholder value";
  if (value.length < minLength) return `is shorter than ${minLength} characters`;
  return null;
}

/** Throws on a weak secret (or returns the warning in insecure dev mode). */
export function checkSecret(name: string, value: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const problem = secretProblem(value);
  if (!problem) return null;
  const message =
    `${name} ${problem}. Generate one with \`openssl rand -hex 32\` and use the same value ` +
    `in foresight-server/.env (and infra/livekit.yaml for LiveKit keys). ` +
    `For a throwaway local setup only, set FORESIGHT_INSECURE_DEV=1.`;
  if (insecureDevMode(env)) return message;
  throw new Error(message);
}

/** Constant-time, length-independent comparison of a provided secret header. */
export function secretsEqual(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
