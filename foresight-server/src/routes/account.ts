/**
 * Account route: permanent, self-service deletion of the caller's own account
 * and all data uniquely tied to it.
 *
 * Deletion rules (a Home is a group of cameras + footage that can be shared by
 * several users):
 *
 *   • Homes the caller SOLELY owns (no other members) are deleted outright —
 *     their cameras, recordings, and pairing sessions cascade away in the schema.
 *   • Homes where the caller is only a member (or a co-owner alongside another
 *     owner) survive; the caller's membership is dropped via the User cascade.
 *   • If the caller is the SOLE owner of a Home that still has OTHER members,
 *     deletion is REFUSED (409) and the offending Homes are returned, so the
 *     user can transfer ownership (POST /homes/:id/transfer-owner) or delete the
 *     Home first. We never silently orphan a shared Home or wipe data other
 *     people rely on.
 *
 * Before deleting a sole-owner Home we disarm the recorder for any of its
 * cameras that are actively recording (fire-and-forget, mirrors DELETE /homes).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AccountDeletionBlocked, UserDTO } from "@foresight/contract";
import { prisma } from "../db.js";
import { requireUser } from "../auth.js";
import { conflict } from "../lib/errors.js";
import { toUserDTO } from "../lib/dto.js";
import { parseBody } from "../lib/validate.js";
import { disarmRecording } from "../recorder-client.js";

const profileUpdate = z.object({
  // Trimmed; an empty string clears the stored name back to null.
  firstName: z
    .string()
    .trim()
    .max(60, "first name is too long")
    .nullable()
    .transform((v) => (v ? v : null)),
});

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  // Update the caller's own profile (currently just the display first name).
  app.patch("/me", { preHandler: requireUser }, async (req): Promise<UserDTO> => {
    const { firstName } = parseBody(profileUpdate, req.body);
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { firstName },
    });
    return toUserDTO(user);
  });

  app.delete("/me", { preHandler: requireUser }, async (req, reply): Promise<void> => {
    const userId = req.user!.id;

    // All Homes the caller belongs to, with the full member roster so we can
    // classify each one (sole-owner-empty / sole-owner-shared / shared-other).
    const memberships = await prisma.homeMember.findMany({
      where: { userId },
      include: { home: { include: { members: true } } },
    });

    const soleOwnerEmpty: { id: string; name: string }[] = [];
    const blocking: { id: string; name: string }[] = [];

    for (const m of memberships) {
      if (m.role !== "owner") continue; // pure membership — cascades away, no action
      const home = m.home;
      const otherMembers = home.members.filter((x) => x.userId !== userId);
      const otherOwners = otherMembers.filter((x) => x.role === "owner");

      if (otherMembers.length === 0) {
        // Caller is the only person in the Home → safe to delete with the account.
        soleOwnerEmpty.push({ id: home.id, name: home.name });
      } else if (otherOwners.length === 0) {
        // Caller is the ONLY owner but other members exist → block.
        blocking.push({ id: home.id, name: home.name });
      }
      // else: another owner exists → Home survives, caller's membership cascades.
    }

    if (blocking.length > 0) {
      const details: AccountDeletionBlocked = { blockingHomes: blocking };
      const names = blocking.map((h) => `"${h.name}"`).join(", ");
      throw conflict(
        `You are the only owner of ${blocking.length} Home(s) that still have other members: ${names}. ` +
          `Transfer ownership or delete those Homes before deleting your account.`,
        details,
      );
    }

    // Disarm recorders for actively-recording cameras in the Homes we're about to
    // delete (fire-and-forget; a down recorder must not fail the deletion).
    if (soleOwnerEmpty.length > 0) {
      const homeIds = soleOwnerEmpty.map((h) => h.id);
      const recording = await prisma.camera.findMany({
        where: { homeId: { in: homeIds }, recordingEnabled: true },
        select: { id: true, homeId: true },
      });
      for (const cam of recording) {
        void disarmRecording(cam.homeId, cam.id, req.log);
      }
    }

    // Delete sole-owner Homes (cascades cameras/recordings/pairing sessions) and
    // then the user (cascades remaining memberships + pairing sessions) in one
    // transaction so a failure can't leave the account half-removed. The user's
    // sealed-key copies across ALL Homes are deleted explicitly first —
    // HomeKey.holderId has no FK so nothing cascades for surviving Homes (§4
    // lifecycle); the owner's client rotates those Homes afterwards.
    await prisma.$transaction([
      prisma.homeKey.deleteMany({ where: { holderType: "user", holderId: userId } }),
      ...soleOwnerEmpty.map((h) => prisma.home.delete({ where: { id: h.id } })),
      prisma.user.delete({ where: { id: userId } }),
    ]);

    reply.code(204);
  });
}
