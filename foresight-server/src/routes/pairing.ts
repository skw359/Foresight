/**
 * Pairing routes.
 *  - POST /homes/:homeId/cameras/pair  (user): create a one-time PairingSession
 *    and return a PairingTicket to encode into a QR code.
 *  - POST /pair/claim  (no user auth — the pairing token authorizes): a camera
 *    redeems the token, registers itself, and receives a long-lived deviceSecret.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomBytes, randomUUID } from "node:crypto";
import type { ClaimPairingResponse, PairingTicket } from "@foresight/contract";
import { prisma } from "../db.js";
import { requireUser, hashSecret } from "../auth.js";
import { config } from "../config.js";
import { badRequest, notFound } from "../lib/errors.js";
import { requireMember } from "../lib/membership.js";
import { toCameraDTO } from "../lib/dto.js";
import { parseBody } from "../lib/validate.js";
import { publicKeySchema } from "../lib/e2ee.js";
import { resolvePairingServerUrl } from "../lib/settings.js";

const PAIRING_TTL_MS = 10 * 60 * 1000; // 10 minutes

const capabilities = z.object({
  lenses: z.array(z.number()),
  maxDigitalZoom: z.number(),
  torch: z.boolean(),
  maxResolution: z.object({ width: z.number(), height: z.number() }),
  supportsAudio: z.boolean(),
});

const claim = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1, "name is required"),
  capabilities,
  // E2EE identity generated on-device at pairing (§6 pair-camera). Required by
  // the contract; the camera keeps the private key in its Keychain.
  cameraPublicKey: publicKeySchema,
});

export async function pairingRoutes(app: FastifyInstance): Promise<void> {
  app.post("/homes/:homeId/cameras/pair", { preHandler: requireUser }, async (req, reply): Promise<PairingTicket> => {
    const { homeId } = req.params as { homeId: string };
    await requireMember(req.user!.id, homeId);
    const home = await prisma.home.findUnique({ where: { id: homeId } });
    if (!home) throw notFound("Home not found");

    const token = randomUUID() + randomBytes(8).toString("hex");
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    await prisma.pairingSession.create({
      data: { token, homeId, createdBy: req.user!.id, expiresAt },
    });

    // The URL phones scan must be reachable from the device, not "localhost".
    // Resolved per request: dashboard override -> auto-detected origin -> env.
    const serverUrl = await resolvePairingServerUrl(req);

    reply.code(201);
    return {
      serverUrl,
      // Advertise the device-reachable LiveKit URL, never the server's loopback.
      livekitUrl: config.livekitPublicUrl,
      token,
      homeId,
      expiresAt: expiresAt.toISOString(),
    };
  });

  app.post("/pair/claim", async (req, reply): Promise<ClaimPairingResponse> => {
    const { token, name, capabilities: caps, cameraPublicKey } = parseBody(claim, req.body);

    const session = await prisma.pairingSession.findUnique({ where: { token } });
    if (!session || session.consumed) throw badRequest("Invalid or already-used pairing code", "invalid_pairing");
    if (session.expiresAt.getTime() < Date.now()) throw badRequest("Pairing code expired", "expired_pairing");

    // Generate the device secret; persist only its hash, return the plaintext once.
    const deviceSecret = randomBytes(32).toString("hex");

    const camera = await prisma.camera.create({
      data: {
        homeId: session.homeId,
        name,
        deviceSecretHash: await hashSecret(deviceSecret),
        capabilities: caps,
        publicKey: cameraPublicKey,
      },
    });
    await prisma.pairingSession.update({ where: { token }, data: { consumed: true } });

    // The camera must wait for a member to seal the HMK to it before publishing
    // iff the Home has E2EE activated. It arrives via RtTokenResponse.sealedHomeKey.
    const home = await prisma.home.findUnique({
      where: { id: session.homeId },
      select: { keyEpoch: true },
    });
    reply.code(201);
    return {
      camera: toCameraDTO(camera),
      deviceSecret,
      homeKeyPending: (home?.keyEpoch ?? 0) >= 1,
    };
  });
}
