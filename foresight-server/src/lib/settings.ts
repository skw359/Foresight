/**
 * Server-wide settings stored as key/value rows in the `Setting` table, plus
 * the logic for resolving which base URL to embed into QR pairing tickets.
 *
 * The pairing URL must be reachable by the phone scanning the QR code, so
 * "localhost" only ever works on the same machine. We resolve it in priority
 * order: an explicit dashboard override, then the address the dashboard itself
 * used to reach this server (auto-detected per request), then the
 * PUBLIC_SERVER_URL env fallback.
 */
import type { FastifyRequest } from "fastify";
import { prisma } from "../db.js";
import { config } from "../config.js";

/** Setting key for the pairing-ticket base URL override. */
export const PAIRING_SERVER_URL_KEY = "pairing.serverUrl";

/** Setting key for the admin's "allow new accounts" toggle ("true" / absent). */
export const REGISTRATION_OPEN_KEY = "registration.open";

/** Whether ALLOW_REGISTRATION pins the registration policy (dashboard toggle read-only). */
export function registrationLocked(): boolean {
  return config.allowRegistration !== null;
}

/**
 * Whether new accounts may register right now. The env var wins; otherwise the
 * admin's dashboard toggle, which defaults to CLOSED — an open signup on a
 * security-camera server lets strangers in, and every member-level permission
 * starts with an account.
 */
export async function registrationOpen(): Promise<boolean> {
  if (config.allowRegistration !== null) return config.allowRegistration;
  return (await getSetting(REGISTRATION_OPEN_KEY)) === "true";
}

/** Read a setting value, or null if it has never been set. */
export async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}

/**
 * Upsert a setting. Passing null or an empty/whitespace string clears it (so
 * the value falls back to auto-detection / env).
 */
export async function setSetting(key: string, value: string | null): Promise<void> {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    await prisma.setting.deleteMany({ where: { key } });
    return;
  }
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: trimmed },
    update: { value: trimmed },
  });
}

/**
 * The base URL by which the dashboard reached this server on THIS request,
 * e.g. "http://192.168.1.20:3199". On a LAN, opening the dashboard at the
 * host's IP makes pairing tickets point at that reachable address with zero
 * configuration. Returns "" when the Host header is absent.
 */
export function detectServerUrl(req: FastifyRequest): string {
  const host = req.headers.host;
  if (!host) return "";
  const forwarded = req.headers["x-forwarded-proto"];
  const proto =
    (typeof forwarded === "string" && forwarded.split(",")[0]?.trim()) ||
    req.protocol ||
    "http";
  return `${proto}://${host}`;
}

/**
 * Resolve the base URL to embed into a pairing ticket: explicit override first,
 * then the auto-detected request origin, then the PUBLIC_SERVER_URL env value.
 */
export async function resolvePairingServerUrl(req: FastifyRequest): Promise<string> {
  const override = await getSetting(PAIRING_SERVER_URL_KEY);
  if (override) return override;
  const detected = detectServerUrl(req);
  if (detected) return detected;
  return config.publicServerUrl ?? "";
}
