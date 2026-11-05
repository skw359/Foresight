/**
 * Internal API for the foresight-recorder's reconcile loop. Served ONLY by the
 * separate loopback listener (buildInternalApp in app.ts, 127.0.0.1:INTERNAL_PORT),
 * never by the public app — so neither the LAN nor a reverse proxy in front of
 * the public port can reach it, whatever the shared secret.
 *
 * The recorder, on boot and periodically, asks "which cameras SHOULD be
 * recording right now?" and re-arms anything it is missing. The server owns the
 * DB, so it answers here rather than letting a second process open the SQLite
 * file. Guarded by the same shared secret as the recorder control API; when no
 * secret is configured the routes report 404 (feature disabled).
 *
 * With E2EE (shared/E2EE.md §8), the reconcile response also carries each
 * Home's key state so the recorder can unseal the HMK it was granted (or hold in
 * awaiting_consent / finalize on revoke). The recorder registers its public key
 * here on boot; a CHANGED key voids all prior consent (§8.3). The server stores
 * only opaque sealed bytes — it never unseals anything.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RecorderHomeKeyInfo, RecorderReconcileResponse } from "@foresight/contract";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { parseBody } from "../lib/validate.js";
import { recorderIdentitySchema } from "../lib/e2ee.js";
import { secretsEqual } from "../lib/secrets.js";

/**
 * Enforce the recorder shared secret. Returns true when the request may proceed;
 * otherwise it has already sent the 404 (disabled) / 401 (bad secret) response.
 */
function recorderAuthed(req: FastifyRequest, reply: FastifyReply): boolean {
  const secret = config.recorderSharedSecret;
  if (!secret) {
    reply.code(404).send({ error: "not_found", message: "Internal API disabled" });
    return false;
  }
  if (!secretsEqual(req.headers["x-recorder-secret"], secret)) {
    reply.code(401).send({ error: "unauthorized", message: "Invalid recorder secret" });
    return false;
  }
  return true;
}

export async function internalRoutes(app: FastifyInstance): Promise<void> {
  app.get("/internal/recording-cameras", async (req, reply) => {
    if (!recorderAuthed(req, reply)) return reply;

    // Return every camera opted into 24/7 recording, regardless of the DB
    // `online` flag. The recorder is itself a LiveKit subscriber: it joins the
    // room and waits in AWAITING_TRACK until the camera publishes, so it doesn't
    // need (and shouldn't depend on) the webhook-maintained online flag to know
    // what to record. This keeps recording working even if an online/offline
    // webhook is ever missed.
    const cams = await prisma.camera.findMany({
      where: { recordingEnabled: true },
      select: { id: true, homeId: true },
    });
    const cameras = cams.map((c) => ({ cameraId: c.id, homeId: c.homeId }));

    // Per-Home key state for every Home present in `cameras`. epoch = keyEpoch;
    // sealedHmk = the recorder's sealed copy at the current epoch (or null →
    // awaiting_consent); revoked = the owner EXPLICITLY revoked consent (finalize
    // + stop). "Never consented" and "rotation backfill not done yet" are NOT
    // revocations — they report awaiting_consent so the recorder doesn't treat
    // every key rotation as a revoke.
    const homeIds = [...new Set(cams.map((c) => c.homeId))];
    let homeKeys: RecorderHomeKeyInfo[] = [];
    if (homeIds.length) {
      const [homes, recorderRows] = await Promise.all([
        prisma.home.findMany({
          where: { id: { in: homeIds } },
          select: { id: true, keyEpoch: true, recorderConsentRevokedAt: true },
        }),
        prisma.homeKey.findMany({
          where: { holderType: "recorder", homeId: { in: homeIds } },
          select: { homeId: true, epoch: true, sealedKey: true },
        }),
      ]);
      homeKeys = homes.map((h) => {
        const current = recorderRows.find((r) => r.homeId === h.id && r.epoch === h.keyEpoch);
        return {
          homeId: h.id,
          epoch: h.keyEpoch,
          sealedHmk: current?.sealedKey ?? null,
          revoked: h.keyEpoch >= 1 && !current && h.recorderConsentRevokedAt !== null,
        };
      });
    }

    const body: RecorderReconcileResponse = { cameras, homeKeys };
    return reply.send(body);
  });

  // The recorder registers/refreshes its public key on boot. Idempotent for the
  // SAME key; a CHANGED key means the recorder's private key was rotated, so all
  // prior per-Home consent is void — wipe every recorder HomeKey row everywhere
  // (§8.3). Homes must explicitly re-consent to the new identity.
  app.post("/internal/recorder-identity", async (req, reply) => {
    if (!recorderAuthed(req, reply)) return reply;
    const { publicKey } = parseBody(recorderIdentitySchema, req.body);

    const latest = await prisma.recorderIdentity.findFirst({ orderBy: { createdAt: "desc" } });
    if (latest && latest.publicKey === publicKey) {
      return reply.code(204).send(); // unchanged
    }
    if (!latest) {
      await prisma.recorderIdentity.create({ data: { publicKey } });
    } else {
      await prisma.$transaction([
        prisma.homeKey.deleteMany({ where: { holderType: "recorder" } }),
        prisma.recorderIdentity.update({ where: { id: latest.id }, data: { publicKey } }),
      ]);
    }
    return reply.code(204).send();
  });
}
