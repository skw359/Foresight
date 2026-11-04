/**
 * Camera routes: list a Home's cameras (with live status), rename, remove, an
 * optional device-authenticated status sink, and the 24/7 recording toggle.
 * Online/offline is primarily driven by LiveKit webhooks (see routes/webhooks.ts).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CameraDTO, SetRecordingResponse } from "@foresight/contract";
import { prisma } from "../db.js";
import { requireUser, verifySecret } from "../auth.js";
import { toCameraDTO } from "../lib/dto.js";
import { conflict, notFound, unauthorized } from "../lib/errors.js";
import { requireCameraAccess, requireMember } from "../lib/membership.js";
import { isRecorderConsented } from "../lib/homeKeys.js";
import { parseBody } from "../lib/validate.js";
import { cameraKeyRegistrationSchema } from "../lib/e2ee.js";
import { armRecording, disarmRecording } from "../recorder-client.js";

const rename = z.object({ name: z.string().trim().min(1, "name is required") });

const setRecording = z.object({ enabled: z.boolean() });

const statusUpdate = z.object({
  deviceSecret: z.string().min(1),
  battery: z.number().min(0).max(1).nullable().optional(),
  charging: z.boolean().nullable().optional(),
  wifi: z.object({ level: z.number(), rssi: z.number().optional(), ssid: z.string().optional() }).nullable().optional(),
  thermal: z.enum(["nominal", "fair", "serious", "critical"]).nullable().optional(),
});

export async function cameraRoutes(app: FastifyInstance): Promise<void> {
  app.get("/homes/:homeId/cameras", { preHandler: requireUser }, async (req): Promise<CameraDTO[]> => {
    const { homeId } = req.params as { homeId: string };
    await requireMember(req.user!.id, homeId);
    const cameras = await prisma.camera.findMany({
      where: { homeId },
      orderBy: { createdAt: "asc" },
    });
    return cameras.map(toCameraDTO);
  });

  app.patch("/cameras/:cameraId", { preHandler: requireUser }, async (req): Promise<CameraDTO> => {
    const { cameraId } = req.params as { cameraId: string };
    const { name } = parseBody(rename, req.body);
    await requireCameraAccess(req.user!.id, cameraId);
    const camera = await prisma.camera.update({ where: { id: cameraId }, data: { name } });
    return toCameraDTO(camera);
  });

  app.delete("/cameras/:cameraId", { preHandler: requireUser }, async (req, reply): Promise<void> => {
    const { cameraId } = req.params as { cameraId: string };
    await requireCameraAccess(req.user!.id, cameraId);
    // HomeKey.holderId has no FK, so the camera's sealed-key rows do not cascade
    // — delete them explicitly (§4 lifecycle). The owner's client rotates after.
    await prisma.$transaction([
      prisma.homeKey.deleteMany({ where: { holderType: "camera", holderId: cameraId } }),
      prisma.camera.delete({ where: { id: cameraId } }),
    ]);
    reply.code(204);
  });

  // The "record 24/7" toggle. Persists Camera.recordingEnabled and arms/disarms
  // the recorder immediately. Arming does NOT depend on the DB `online` flag:
  // the recorder joins the room and waits for the camera's track itself, so
  // enabling recording starts capture as soon as the camera is (or becomes)
  // live — no waiting on a webhook, and it works even if `online` is stale.
  app.post(
    "/cameras/:cameraId/recording",
    { preHandler: requireUser },
    async (req): Promise<SetRecordingResponse> => {
      const { cameraId } = req.params as { cameraId: string };
      const { enabled } = parseBody(setRecording, req.body);
      const existing = await requireCameraAccess(req.user!.id, cameraId);

      // E2EE consent gate: once a Home has activated E2EE (keyEpoch ≥ 1), the
      // recorder can only decrypt if the owner has granted it consent (a recorder
      // HomeKey row at the current epoch). Enabling recording without consent is
      // refused. For keyEpoch == 0 Homes (E2EE not activated) behavior is
      // UNCHANGED — deploying E2EE changes nothing until a Home opts in
      // (E2EE_MODEL_B_PLAN.md §6/§13 row 9).
      if (enabled) {
        const home = await prisma.home.findUnique({
          where: { id: existing.homeId },
          select: { keyEpoch: true },
        });
        const keyEpoch = home?.keyEpoch ?? 0;
        if (keyEpoch >= 1 && !(await isRecorderConsented(existing.homeId, keyEpoch))) {
          throw conflict("Recording requires recorder consent for this Home", {
            reason: "recorder_consent_required",
          });
        }
      }

      const camera = await prisma.camera.update({
        where: { id: cameraId },
        data: { recordingEnabled: enabled },
      });

      let armed = false;
      if (enabled) armed = await armRecording(camera.homeId, camera.id, req.log);
      else void disarmRecording(camera.homeId, camera.id, req.log);
      void existing; // (loaded only to authorize access)
      return { cameraId, recordingEnabled: camera.recordingEnabled, armed };
    },
  );

  // Device-authenticated health sink (camera posts its own telemetry snapshot).
  app.post("/cameras/:cameraId/status", async (req, reply): Promise<void> => {
    const { cameraId } = req.params as { cameraId: string };
    const body = parseBody(statusUpdate, req.body);
    const camera = await prisma.camera.findUnique({ where: { id: cameraId } });
    if (!camera) throw notFound("Camera not found");
    if (!(await verifySecret(camera.deviceSecretHash, body.deviceSecret))) {
      throw unauthorized("Invalid device secret");
    }
    await prisma.camera.update({
      where: { id: cameraId },
      data: {
        battery: body.battery ?? camera.battery,
        charging: body.charging ?? camera.charging,
        wifi: body.wifi ?? camera.wifi ?? undefined,
        thermal: body.thermal ?? camera.thermal,
        lastSeen: new Date(),
      },
    });
    reply.code(204);
  });

  // Existing-camera E2EE migration (§6): a camera paired before E2EE generates
  // its X25519 keypair on first post-update boot and registers the PUBLIC key
  // here. Device-secret-authed exactly like the status sink above. Idempotent
  // when re-registering the SAME key; 409 if a DIFFERENT key is already stored
  // (guards against a key swap). New cameras send their pubkey in /pair/claim.
  app.post("/cameras/:cameraId/pubkey", async (req, reply): Promise<void> => {
    const { cameraId } = req.params as { cameraId: string };
    const body = parseBody(cameraKeyRegistrationSchema, req.body);
    const camera = await prisma.camera.findUnique({ where: { id: cameraId } });
    if (!camera) throw notFound("Camera not found");
    if (!(await verifySecret(camera.deviceSecretHash, body.deviceSecret))) {
      throw unauthorized("Invalid device secret");
    }
    if (camera.publicKey && camera.publicKey !== body.publicKey) {
      throw conflict("A different public key is already registered for this camera", {
        reason: "camera_pubkey_conflict",
      });
    }
    if (!camera.publicKey) {
      await prisma.camera.update({ where: { id: cameraId }, data: { publicKey: body.publicKey } });
    }
    reply.code(204);
  });
}
