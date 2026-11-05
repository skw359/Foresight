/**
 * Camera routes: list a Home's cameras (with live status), rename, remove, an
 * optional device-authenticated status sink, the 24/7 recording toggle, and the
 * camera's own unpair. Online/offline is primarily driven by LiveKit webhooks
 * (see routes/webhooks.ts).
 *
 * Authorization: any member may view, rename and turn recording ON. Deleting a
 * camera and turning recording OFF are owner-only and audited — a member
 * account (or a stolen member token) must not be able to blind a camera.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CameraDTO, SetRecordingResponse } from "@foresight/contract";
import { prisma } from "../db.js";
import { authenticateDevice, requireUser } from "../auth.js";
import { toCameraDTO } from "../lib/dto.js";
import { conflict, notFound, unauthorized } from "../lib/errors.js";
import { requireCameraAccess, requireCameraOwner, requireMember } from "../lib/membership.js";
import { isRecorderConsented } from "../lib/homeKeys.js";
import { NAME_MAX, parseBody } from "../lib/validate.js";
import { cameraKeyRegistrationSchema } from "../lib/e2ee.js";
import { armRecording, disarmRecording } from "../recorder-client.js";
import { audit, userActor } from "../lib/audit.js";
import { deleteCamera } from "../lib/revocation.js";
import { clientKey, enforce, limits } from "../lib/rateLimit.js";

const rename = z.object({
  name: z.string().trim().min(1, "name is required").max(NAME_MAX, "name is too long"),
});

const setRecording = z.object({ enabled: z.boolean() });

const deviceSecret = z.string().min(1).max(256);

const statusUpdate = z.object({
  deviceSecret,
  battery: z.number().min(0).max(1).nullable().optional(),
  charging: z.boolean().nullable().optional(),
  wifi: z
    .object({ level: z.number(), rssi: z.number().optional(), ssid: z.string().max(64).optional() })
    .nullable()
    .optional(),
  thermal: z.enum(["nominal", "fair", "serious", "critical"]).nullable().optional(),
});

const unpair = z.object({ deviceSecret });

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
    const before = await requireCameraAccess(req.user!.id, cameraId);
    const camera = await prisma.camera.update({ where: { id: cameraId }, data: { name } });
    if (before.name !== name) {
      await audit(
        {
          homeId: camera.homeId,
          actor: userActor(req.user!),
          action: "camera.renamed",
          targetType: "camera",
          targetId: cameraId,
          details: { from: before.name, to: name },
        },
        req.log,
      );
    }
    return toCameraDTO(camera);
  });

  // Owner only. Removes the camera's keys and row, evicts its live session,
  // stops its recording and flags an E2EE key rotation (lib/revocation.ts).
  app.delete("/cameras/:cameraId", { preHandler: requireUser }, async (req, reply): Promise<void> => {
    const { cameraId } = req.params as { cameraId: string };
    const camera = await requireCameraOwner(req.user!.id, cameraId, "remove cameras");
    await deleteCamera(camera, userActor(req.user!), req.log);
    reply.code(204);
  });

  // The "record 24/7" toggle. Persists Camera.recordingEnabled and arms/disarms
  // the recorder immediately. Arming does NOT depend on the DB `online` flag:
  // the recorder joins the room and waits for the camera's track itself, so
  // enabling recording starts capture as soon as the camera is (or becomes)
  // live — no waiting on a webhook, and it works even if `online` is stale.
  // Any member may turn recording ON; turning it OFF is owner-only.
  app.post(
    "/cameras/:cameraId/recording",
    { preHandler: requireUser },
    async (req): Promise<SetRecordingResponse> => {
      const { cameraId } = req.params as { cameraId: string };
      const { enabled } = parseBody(setRecording, req.body);
      const existing = enabled
        ? await requireCameraAccess(req.user!.id, cameraId)
        : await requireCameraOwner(req.user!.id, cameraId, "turn off 24/7 recording");

      // E2EE consent gate: once a Home has activated E2EE (keyEpoch ≥ 1), the
      // recorder can only decrypt if the owner has granted it consent (a recorder
      // HomeKey row at the current epoch). Enabling recording without consent is
      // refused. For keyEpoch == 0 Homes (E2EE not activated) behavior is
      // UNCHANGED — deploying E2EE changes nothing until a Home opts in
      // (shared/E2EE.md §6/§13).
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
      if (existing.recordingEnabled !== enabled) {
        await audit(
          {
            homeId: camera.homeId,
            actor: userActor(req.user!),
            action: enabled ? "recording.enabled" : "recording.disabled",
            targetType: "camera",
            targetId: cameraId,
            details: { name: camera.name },
          },
          req.log,
        );
      }

      let armed = false;
      if (enabled) armed = await armRecording(camera.homeId, camera.id, req.log);
      else void disarmRecording(camera.homeId, camera.id, req.log);
      return { cameraId, recordingEnabled: camera.recordingEnabled, armed };
    },
  );

  // Device-authenticated health sink (camera posts its own telemetry snapshot).
  app.post("/cameras/:cameraId/status", async (req, reply): Promise<void> => {
    enforce(limits.cameraDevicePerIp, clientKey(req));
    const { cameraId } = req.params as { cameraId: string };
    const body = parseBody(statusUpdate, req.body);
    const camera = await authenticateDevice(body.deviceSecret, { cameraId });
    if (!camera) {
      enforce(limits.deviceSecretFailuresPerIp, clientKey(req));
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
    enforce(limits.cameraDevicePerIp, clientKey(req));
    const { cameraId } = req.params as { cameraId: string };
    const body = parseBody(cameraKeyRegistrationSchema, req.body);
    const camera = await authenticateDevice(body.deviceSecret, { cameraId });
    if (!camera) {
      enforce(limits.deviceSecretFailuresPerIp, clientKey(req));
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

  // The camera removes ITSELF (the phone's "Unpair" button). Authenticated by
  // its own device secret, so a phone being retired actually leaves the Home
  // instead of lingering as a permanently offline camera with live credentials.
  app.post("/cameras/:cameraId/unpair", async (req, reply): Promise<void> => {
    enforce(limits.cameraDevicePerIp, clientKey(req));
    const { cameraId } = req.params as { cameraId: string };
    const body = parseBody(unpair, req.body);
    const camera = await authenticateDevice(body.deviceSecret, { cameraId });
    if (!camera) {
      enforce(limits.deviceSecretFailuresPerIp, clientKey(req));
      // Already deleted from the dashboard → nothing left to do.
      if (!(await prisma.camera.findUnique({ where: { id: cameraId }, select: { id: true } }))) {
        throw notFound("Camera not found");
      }
      throw unauthorized("Invalid device secret");
    }
    await deleteCamera(camera, { type: "camera", camera }, req.log);
    reply.code(204);
  });
}
