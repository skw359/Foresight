/**
 * Loopback-only control API. The server's webhook + recording toggle POST
 * arm/disarm here; /status is for ops visibility. Bound to 127.0.0.1 and guarded
 * by the shared secret header, so nothing on the LAN can reach it.
 *
 * arm/disarm run in the background and the route returns immediately: the
 * server's calls are fire-and-forget with a short timeout, and arming may block
 * on a LiveKit connect we don't want the caller to wait for.
 *
 * The E2EE control pushes (shared/E2EE.md §8.2) — /control/rekey and
 * /control/revoke — are best-effort nudges the server sends at consent
 * rotate/revoke. Both simply trigger an immediate reconcile (the periodic
 * reconcile remains the source of truth for keys), so the recorder reacts within
 * milliseconds instead of waiting for the next interval.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { log } from "../log.js";
import { secretsEqual } from "../secrets.js";
import { health } from "../state/health.js";
import type { RoomManager } from "../livekit/roomManager.js";

const controlBody = z.object({
  homeId: z.string().min(1),
  cameraId: z.string().min(1),
});

const rekeyBody = z.object({
  homeId: z.string().min(1),
  epoch: z.number().int().nonnegative().optional(),
});

const revokeBody = z.object({
  homeId: z.string().min(1),
});

/** `refresh(reason)` triggers an immediate reconcile/key-refresh. */
export async function startControlApi(
  rm: RoomManager,
  refresh: (reason: string) => void,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.addHook("preHandler", async (req, reply) => {
    if (!secretsEqual(req.headers["x-recorder-secret"], config.sharedSecret)) {
      await reply.code(401).send({ error: "unauthorized", message: "Invalid recorder secret" });
    }
  });

  app.post("/control/arm", async (req, reply) => {
    const parsed = controlBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    const { homeId, cameraId } = parsed.data;
    void rm.arm(homeId, cameraId).catch((err) =>
      log.error("arm failed", { homeId, cameraId, err: String(err) }),
    );
    return { ok: true };
  });

  app.post("/control/disarm", async (req, reply) => {
    const parsed = controlBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    const { homeId, cameraId } = parsed.data;
    void rm.disarm(homeId, cameraId).catch((err) =>
      log.error("disarm failed", { homeId, cameraId, err: String(err) }),
    );
    return { ok: true };
  });

  app.post("/control/rekey", async (req, reply) => {
    const parsed = rekeyBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    const { homeId, epoch } = parsed.data;
    log.info("control: rekey push", { homeId, epoch });
    refresh(`rekey:${homeId}`);
    return { ok: true };
  });

  // E2EE: owner revoked recorder consent — pull fresh keys (revocation surfaces
  // as sealedHmk gone / revoked, which finalizes + disconnects the Home).
  app.post("/control/revoke", async (req, reply) => {
    const parsed = revokeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    const { homeId } = parsed.data;
    log.info("control: revoke push", { homeId });
    refresh(`revoke:${homeId}`);
    return { ok: true };
  });

  // /status reports per-camera state (recording | awaiting_consent | stalled |
  // revoked | …) plus a per-Home key summary (epoch / keyed / revoked).
  app.get("/status", async () => ({ ok: health.ffmpeg.ok, ffmpeg: health.ffmpeg, ...rm.status() }));

  await app.listen({ port: config.port, host: "127.0.0.1" });
  log.info("control API listening", { host: "127.0.0.1", port: config.port });
  return app;
}
