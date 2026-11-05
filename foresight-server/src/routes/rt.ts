/**
 * POST /rt/token — mint a LiveKit access token for the caller's Home room.
 *  - viewer: authenticated by user session (revocation-checked) + Home membership.
 *  - camera: authenticated by its deviceSecret. The secret is 256 random bits,
 *    so the camera is found by an INDEXED SHA-256 lookup — no per-camera argon2
 *    scan an unauthenticated caller could use to burn CPU (see auth.ts).
 * Both paths are rate limited per client address.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RtTokenResponse, SealedKey } from "@foresight/contract";
import { prisma } from "../db.js";
import { authenticateDevice, bearer, userFromSessionToken } from "../auth.js";
import { config } from "../config.js";
import { badRequest, forbidden, unauthorized } from "../lib/errors.js";
import { membershipRole } from "../lib/membership.js";
import { cameraToken, viewerToken } from "../livekit.js";
import { parseBody } from "../lib/validate.js";
import { clientKey, enforce, limits } from "../lib/rateLimit.js";

const rtToken = z.object({
  homeId: z.string().min(1).max(64),
  role: z.enum(["camera", "viewer"]),
  deviceSecret: z.string().max(256).optional(),
});

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
    enforce(limits.rtTokenPerIp, clientKey(req));
    const { homeId, role, deviceSecret } = parseBody(rtToken, req.body);

    if (role === "viewer") {
      const user = await userFromSessionToken(bearer(req));
      if (!user) throw unauthorized();
      const userId = user.id;
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
    const camera = await authenticateDevice(deviceSecret, { homeId });
    if (!camera) {
      enforce(limits.deviceSecretFailuresPerIp, clientKey(req));
      throw unauthorized("Invalid device secret");
    }
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
  });
}
