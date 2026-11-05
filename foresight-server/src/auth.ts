/**
 * Authentication helpers: password hashing (argon2), revocable session JWTs, a
 * Fastify preHandler that loads the authenticated user from the
 * `Authorization: Bearer <token>` header, the server-admin guard, and camera
 * device-secret authentication.
 */
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Camera, User } from "@prisma/client";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { forbidden, unauthorized } from "./lib/errors.js";
import { sha256Hex } from "./lib/secrets.js";

/**
 * node-argon2 runs on the libuv thread pool (4 threads by default), which the
 * filesystem shares — segment serving and clip I/O. Unbounded concurrent
 * hashes (a login storm) would stall every fs call, so argon2 work queues
 * behind a small semaphore and always leaves threads free for I/O.
 */
let argon2Active = 0;
const argon2Waiters: Array<() => void> = [];

async function withArgon2Slot<T>(fn: () => Promise<T>): Promise<T> {
  if (argon2Active >= config.argon2Concurrency) {
    await new Promise<void>((resolve) => argon2Waiters.push(resolve));
  } else {
    argon2Active++;
  }
  try {
    return await fn();
  } finally {
    const next = argon2Waiters.shift();
    if (next) next(); // hand the slot straight to the next waiter
    else argon2Active--;
  }
}

/** Passwords have no complexity rules (product decision); we just hash them. */
export function hashPassword(password: string): Promise<string> {
  return withArgon2Slot(() => argon2.hash(password));
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return withArgon2Slot(() => argon2.verify(hash, password).catch(() => false));
}

/**
 * A precomputed hash to verify against when a login names an unknown account,
 * so "no such user" and "wrong password" take the same time.
 */
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= argon2.hash("foresight-timing-equalizer");
  await verifyPassword(await dummyHash, password);
}

interface SessionClaims extends jwt.JwtPayload {
  sub: string;
  /** User.tokenVersion at issue time. Absent on tokens minted before it existed (= 0). */
  tv?: number;
}

export function signSession(user: Pick<User, "id" | "tokenVersion">): string {
  return jwt.sign({ sub: user.id, tv: user.tokenVersion }, config.jwtSecret, {
    expiresIn: config.sessionTtl as jwt.SignOptions["expiresIn"],
  });
}

/** Verify a session token's signature + expiry. Returns its claims, or null. */
export function verifySessionClaims(token: string): { userId: string; tokenVersion: number } | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as SessionClaims;
    if (typeof payload.sub !== "string") return null;
    if (payload.typ !== undefined) return null; // a scoped token (e.g. clip download) is not a session
    return { userId: payload.sub, tokenVersion: typeof payload.tv === "number" ? payload.tv : 0 };
  } catch {
    return null;
  }
}

/** Back-compat helper: the user id of a VALIDLY SIGNED session (version NOT checked). */
export function verifySession(token: string): string | null {
  return verifySessionClaims(token)?.userId ?? null;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Populated by `requireUser` for authenticated routes. */
    user?: User;
  }
}

export function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

/**
 * Resolve a session token to its user, enforcing revocation: a token minted
 * before the user's tokenVersion was bumped (logout everywhere, password
 * change) is rejected.
 */
export async function userFromSessionToken(token: string | null): Promise<User | null> {
  const claims = token ? verifySessionClaims(token) : null;
  if (!claims) return null;
  const user = await prisma.user.findUnique({ where: { id: claims.userId } });
  if (!user || user.tokenVersion !== claims.tokenVersion) return null;
  return user;
}

/**
 * Fastify preHandler: require a valid session and attach `request.user`.
 * Use as `{ preHandler: requireUser }` on protected routes.
 */
export async function requireUser(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const user = await userFromSessionToken(bearer(req));
  if (!user) throw unauthorized();
  req.user = user;
}

/** preHandler (after requireUser): only the server administrator may continue. */
export async function requireServerAdmin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.user?.isAdmin) throw forbidden("Only the server administrator can change server settings");
}

/**
 * Device secrets are 256 random bits, so a plain SHA-256 is a sufficient,
 * unguessable lookup key — no argon2 scan needed. The argon2 hash is still
 * written at pairing so older servers (and the legacy path below) keep working.
 */
export function deviceSecretSha(deviceSecret: string): string {
  return sha256Hex(deviceSecret);
}

export const hashSecret = hashPassword;

/**
 * Authenticate a camera by its device secret, optionally scoped to one camera
 * id or one Home. Cameras with a SHA are found with one indexed lookup; legacy
 * cameras without one are verified with argon2 once, then upgraded so every
 * later call is O(1).
 */
export async function authenticateDevice(
  deviceSecret: string,
  scope: { cameraId?: string; homeId?: string },
): Promise<Camera | null> {
  if (!deviceSecret || deviceSecret.length > 256) return null;
  const sha = deviceSecretSha(deviceSecret);
  const camera = await prisma.camera.findUnique({ where: { deviceSecretSha256: sha } });
  if (camera) {
    if (scope.cameraId !== undefined && camera.id !== scope.cameraId) return null;
    if (scope.homeId !== undefined && camera.homeId !== scope.homeId) return null;
    return camera;
  }

  // Legacy cameras (no SHA yet). Only cameras still MISSING the column are
  // candidates, so this path disappears as cameras reconnect after upgrade.
  const legacy = await prisma.camera.findMany({
    where: {
      deviceSecretSha256: null,
      ...(scope.cameraId !== undefined ? { id: scope.cameraId } : {}),
      ...(scope.homeId !== undefined ? { homeId: scope.homeId } : {}),
    },
    take: 32,
  });
  for (const candidate of legacy) {
    if (await verifyPassword(candidate.deviceSecretHash, deviceSecret)) {
      return prisma.camera
        .update({ where: { id: candidate.id }, data: { deviceSecretSha256: sha } })
        .catch(() => candidate);
    }
  }
  return null;
}
