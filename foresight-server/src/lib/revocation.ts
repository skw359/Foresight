/**
 * Revocation: removing a camera or a member must take effect NOW, not "when the
 * participant happens to disconnect". LiveKit only checks access at join time,
 * so every path here pairs the database change with an eviction from the
 * Home's room, and — for an E2EE Home — flags that the Home Media Key must be
 * rotated, because the removed holder still knows the current key.
 */
import type { FastifyBaseLogger } from "fastify";
import type { Camera } from "@prisma/client";
import { prisma } from "../db.js";
import { disarmRecording } from "../recorder-client.js";
import { evictCamera, evictUser } from "../livekit.js";
import { audit, type AuditActor } from "./audit.js";
import { conflict, notFound } from "./errors.js";

type Log = Pick<FastifyBaseLogger, "warn">;

/**
 * Delete a camera everywhere: its sealed-key rows (HomeKey.holderId has no FK,
 * so they don't cascade), the camera row, its live LiveKit session and its
 * recorder capture. Flags a key rotation for E2EE Homes.
 */
export async function deleteCamera(camera: Camera, actor: AuditActor, log: Log): Promise<void> {
  const home = await prisma.home.findUnique({ where: { id: camera.homeId }, select: { keyEpoch: true } });
  await prisma.$transaction([
    prisma.homeKey.deleteMany({ where: { holderType: "camera", holderId: camera.id } }),
    prisma.camera.delete({ where: { id: camera.id } }),
    ...((home?.keyEpoch ?? 0) >= 1
      ? [prisma.home.update({ where: { id: camera.homeId }, data: { keyRotationRequired: true } })]
      : []),
  ]);
  await evictCamera(camera.homeId, camera.id, log);
  if (camera.recordingEnabled) void disarmRecording(camera.homeId, camera.id, log);
  await audit(
    {
      homeId: camera.homeId,
      actor,
      action: actor.type === "camera" ? "camera.unpaired" : "camera.deleted",
      targetType: "camera",
      targetId: camera.id,
      details: { name: camera.name },
    },
    log,
  );
}

/**
 * Remove a user from a Home: drop the membership and the user's sealed-key
 * copies for this Home in one transaction, refusing (409 last_owner) when it
 * would leave the Home without an owner. Then evict every live session the
 * user has in the Home's room and flag a rotation for E2EE Homes.
 */
export async function removeMember(
  homeId: string,
  userId: string,
  actor: AuditActor,
  log: Log,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const member = await tx.homeMember.findUnique({ where: { userId_homeId: { userId, homeId } } });
    if (!member) throw notFound("That user is not a member of this Home");
    if (member.role === "owner") {
      const owners = await tx.homeMember.count({ where: { homeId, role: "owner" } });
      if (owners <= 1) {
        throw conflict("A Home must keep at least one owner — transfer ownership or delete the Home first", {
          reason: "last_owner",
        });
      }
    }
    await tx.homeMember.delete({ where: { userId_homeId: { userId, homeId } } });
    await tx.homeKey.deleteMany({ where: { homeId, holderType: "user", holderId: userId } });
    const home = await tx.home.findUnique({ where: { id: homeId }, select: { keyEpoch: true } });
    if ((home?.keyEpoch ?? 0) >= 1) {
      await tx.home.update({ where: { id: homeId }, data: { keyRotationRequired: true } });
    }
  });
  await evictUser(homeId, userId, log);
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { identifier: true } });
  await audit(
    {
      homeId,
      actor,
      action: actor.type === "user" && actor.user.id === userId ? "member.left" : "member.removed",
      targetType: "user",
      targetId: userId,
      details: target ? { identifier: target.identifier } : undefined,
    },
    log,
  );
}
