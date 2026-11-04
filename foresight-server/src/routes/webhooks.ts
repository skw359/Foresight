/**
 * POST /webhooks/livekit — LiveKit posts room/participant events here. We
 * verify the signature with the API key/secret, then flip a camera's
 * online/lastSeen state when it joins or leaves its Home room.
 *
 * On top of the online/offline bookkeeping, this is the documented trigger for
 * server-side recording: when a camera with recordingEnabled joins, we ask the
 * recorder to arm; when it leaves, we ask it to disarm. Those calls are
 * fire-and-forget (see recorder-client.ts) so a recorder that is down never
 * makes this webhook return non-200.
 *
 * LiveKit sends Content-Type `application/webhook+json` with a signed JWT in
 * the Authorization header over the RAW body, so this route registers a raw
 * body parser (see app.ts) and reads `req.body` as a string.
 */
import type { FastifyInstance } from "fastify";
import { parseIdentity } from "@foresight/contract";
import { prisma } from "../db.js";
import { receiveWebhook } from "../livekit.js";
import { armRecording, disarmRecording } from "../recorder-client.js";

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/livekit", async (req, reply) => {
    const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    let event;
    try {
      event = await receiveWebhook(raw, req.headers.authorization);
    } catch (err) {
      req.log.warn({ err }, "rejected livekit webhook");
      return reply.code(401).send({ error: "unauthorized", message: "Invalid webhook signature" });
    }

    const identity = event.participant?.identity;
    const parsed = identity ? parseIdentity(identity) : null;
    if (parsed?.role === "camera") {
      if (event.event === "participant_joined") {
        const cam = await prisma.camera
          .update({ where: { id: parsed.id }, data: { online: true, lastSeen: new Date() } })
          .catch(() => null);
        // Arm the recorder only when this camera opted into 24/7 recording.
        if (cam?.recordingEnabled) void armRecording(cam.homeId, cam.id, req.log);
      } else if (event.event === "participant_left") {
        const cam = await prisma.camera
          .update({ where: { id: parsed.id }, data: { online: false, lastSeen: new Date() } })
          .catch(() => null);
        // Always disarm on leave; a disarm for a camera that wasn't recording
        // is a harmless no-op on the recorder.
        if (cam) void disarmRecording(cam.homeId, cam.id, req.log);
      }
    }

    return reply.code(200).send({ ok: true });
  });
}
