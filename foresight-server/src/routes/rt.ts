/**
 * POST /rt/token — mint a LiveKit access token for the caller's Home room.
 *  - viewer: authenticated by user session + Home membership.
 *  - camera: authenticated by its deviceSecret (verified against the Home's
 *    cameras). The contract's RtTokenRequest carries no cameraId, so we resolve
 *    the camera by matching the secret within the Home (few cameras per Home),
 *    trying the last-known match first so repeat mints cost ONE argon2 verify.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RtTokenResponse, SealedKey } from "@foresight/contract";
import { prisma } from "../db.js";
import { verifySession, verifySecret } from "../auth.js";
import { config } from "../config.js";
import { badRequest, forbidden, unauthorized } from "../lib/errors.js";
import { membershipRole } from "../lib/membership.js";
import { cameraToken, viewerToken } from "../livekit.js";
import { parseBody } from "../lib/validate.js";

const rtToken = z.object({
  homeId: z.string().min(1),
  role: z.enum(["camera", "viewer"]),
  deviceSecret: z.string().optional(),
});

function bearerUserId(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return verifySession(authHeader.slice("Bearer ".length).trim());
}

/**
 * secret-fingerprint → cameraId of the last successful verify. Only a search
 * HINT (ordering): the argon2 verify below stays authoritative, so a stale or
 * poisoned entry can never authenticate anything — it just costs extra argon2
 * rounds. Keyed by SHA-256 of the secret; the secret itself is never retained.
 */
const cameraHints = new Map<string, string>();
const CAMERA_HINTS_MAX = 1024;

function secretFingerprint(deviceSecret: string): string {
  return createHash("sha256").update(deviceSecret).digest("base64");
}

function rememberCameraHint(fingerprint: string, cameraId: string): void {
  cameraHints.delete(fingerprint); // re-insert to refresh FIFO position
  if (cameraHints.size >= CAMERA_HINTS_MAX) {
    const oldest = cameraHints.keys().next().value;
    if (oldest !== undefined) cameraHints.delete(oldest);
  }
  cameraHints.set(fingerprint, cameraId);
}

/**
 * The Home's current key epoch plus the caller's own sealed HMK copy — rides the
 * token so joining costs zero extra round-trips (§9.2). keyEpoch 0 ⇒ E2EE not
 * activated (plaintext as today); ≥ 1 with a null key ⇒ "awaiting key". At most
 * one Home lookup + one HomeKey lookup on this hot path.
 */
async function homeKeyForToken(
  homeId: string,
  holderType: "user" | "camera",
  holderId: string,
): Promise<{ keyEpoch: number; sealedHomeKey: SealedKey | null }> {
  const home = await prisma.home.findUnique({ where: { id: homeId }, select: { keyEpoch: true } });
  const keyEpoch = home?.keyEpoch ?? 0;
  if (keyEpoch < 1) return { keyEpoch, sealedHomeKey: null };
  const row = await prisma.homeKey.findUnique({
    where: { homeId_epoch_holderType_holderId: { homeId, epoch: keyEpoch, holderType, holderId } },
    select: { sealedKey: true },
  });
  return {
    keyEpoch,
    sealedHomeKey: row ? { ciphertext: row.sealedKey, epoch: keyEpoch } : null,
  };
}

export async function rtRoutes(app: FastifyInstance): Promise<void> {
  app.post("/rt/token", async (req): Promise<RtTokenResponse> => {
    const { homeId, role, deviceSecret } = parseBody(rtToken, req.body);

    if (role === "viewer") {
      const userId = bearerUserId(req.headers.authorization);
      if (!userId) throw unauthorized();
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw unauthorized();
      if (!(await membershipRole(userId, homeId))) throw forbidden("You are not a member of this Home");

      const minted = viewerToken(homeId, userId, user.identifier);
      const { keyEpoch, sealedHomeKey } = await homeKeyForToken(homeId, "user", userId);
      return {
        livekitUrl: config.livekitPublicUrl,
        token: await minted.token,
        room: minted.room,
        identity: minted.identity,
        keyEpoch,
        sealedHomeKey,
      };
    }

    // role === "camera"
    if (!deviceSecret) throw badRequest("deviceSecret is required for camera tokens");
    const cameras = await prisma.camera.findMany({ where: { homeId } });
    const fingerprint = secretFingerprint(deviceSecret);
    const hintedId = cameraHints.get(fingerprint);
    if (hintedId) {
      const i = cameras.findIndex((c) => c.id === hintedId);
      if (i > 0) cameras.unshift(...cameras.splice(i, 1));
    }
    for (const camera of cameras) {
      if (await verifySecret(camera.deviceSecretHash, deviceSecret)) {
        rememberCameraHint(fingerprint, camera.id);
        const minted = cameraToken(homeId, camera.id, camera.name);
        const { keyEpoch, sealedHomeKey } = await homeKeyForToken(homeId, "camera", camera.id);
        return {
          livekitUrl: config.livekitPublicUrl,
          token: await minted.token,
          room: minted.room,
          identity: minted.identity,
          keyEpoch,
          sealedHomeKey,
        };
      }
    }
    throw unauthorized("Invalid device secret");
  });
}
