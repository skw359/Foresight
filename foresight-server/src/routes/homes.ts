/**
 * Home routes: list the user's Homes, create a Home (creator becomes owner),
 * and add an existing user to a Home (owner only). A Home is a group of cameras.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { HomeDTO, HomeMemberDTO, MemberRole } from "@foresight/contract";
import { prisma } from "../db.js";
import { requireUser } from "../auth.js";
import { toHomeDTO } from "../lib/dto.js";
import { badRequest, notFound } from "../lib/errors.js";
import { requireMember, requireOwner } from "../lib/membership.js";
import { isRecorderConsented, recorderConsentMap } from "../lib/homeKeys.js";
import { parseBody } from "../lib/validate.js";
import { disarmRecording } from "../recorder-client.js";

const createHome = z.object({ name: z.string().trim().min(1, "name is required") });
const addMember = z.object({
  identifier: z.string().trim().min(1, "identifier is required"),
  role: z.enum(["owner", "member"]).optional(),
});
const transferOwnership = z.object({
  userId: z.string().trim().min(1, "userId is required"),
  keepOwnership: z.boolean().optional(),
});

export async function homeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/homes", { preHandler: requireUser }, async (req): Promise<HomeDTO[]> => {
    const memberships = await prisma.homeMember.findMany({
      where: { userId: req.user!.id },
      include: { home: true },
      orderBy: { home: { createdAt: "asc" } },
    });
    const consent = await recorderConsentMap(memberships.map((m) => m.home));
    return memberships.map((m) =>
      toHomeDTO(m.home, m.role as MemberRole, consent.get(m.home.id) ?? false),
    );
  });

  app.post("/homes", { preHandler: requireUser }, async (req, reply): Promise<HomeDTO> => {
    const { name } = parseBody(createHome, req.body);
    const home = await prisma.home.create({
      data: { name, members: { create: { userId: req.user!.id, role: "owner" } } },
    });
    reply.code(201);
    return toHomeDTO(home, "owner");
  });

  app.post("/homes/:homeId/members", { preHandler: requireUser }, async (req): Promise<HomeDTO> => {
    const { homeId } = req.params as { homeId: string };
    const { identifier, role } = parseBody(addMember, req.body);
    await requireOwner(req.user!.id, homeId);

    const home = await prisma.home.findUnique({ where: { id: homeId } });
    if (!home) throw notFound("Home not found");

    const target = await prisma.user.findUnique({ where: { identifier } });
    if (!target) throw notFound("No user with that email or username");

    await prisma.homeMember.upsert({
      where: { userId_homeId: { userId: target.id, homeId } },
      create: { userId: target.id, homeId, role: role ?? "member" },
      update: { role: role ?? "member" },
    });

    return toHomeDTO(home, "owner", await isRecorderConsented(home.id, home.keyEpoch));
  });

  // List the members of a Home (any member may view). Used by the dashboard to
  // pick a recipient when transferring ownership.
  app.get(
    "/homes/:homeId/members",
    { preHandler: requireUser },
    async (req): Promise<HomeMemberDTO[]> => {
      const { homeId } = req.params as { homeId: string };
      await requireMember(req.user!.id, homeId);

      const members = await prisma.homeMember.findMany({
        where: { homeId },
        include: { user: true },
        orderBy: { user: { createdAt: "asc" } },
      });
      return members.map((m) => ({
        userId: m.userId,
        identifier: m.user.identifier,
        role: m.role as MemberRole,
        publicKey: m.user.publicKey ?? null,
      }));
    },
  );

  // Transfer ownership of a Home to another existing member (owner only). The
  // target is promoted to "owner"; unless keepOwnership is set, the caller is
  // demoted to "member". This is the supported way to clear the account-deletion
  // block when the caller is the sole owner of a shared Home.
  app.post(
    "/homes/:homeId/transfer-owner",
    { preHandler: requireUser },
    async (req): Promise<HomeDTO> => {
      const { homeId } = req.params as { homeId: string };
      const { userId, keepOwnership } = parseBody(transferOwnership, req.body);
      const callerId = req.user!.id;
      await requireOwner(callerId, homeId);

      const home = await prisma.home.findUnique({ where: { id: homeId } });
      if (!home) throw notFound("Home not found");

      if (userId === callerId) {
        throw badRequest("You already own this Home");
      }

      const target = await prisma.homeMember.findUnique({
        where: { userId_homeId: { userId, homeId } },
      });
      if (!target) throw notFound("That user is not a member of this Home");

      // Promote target; optionally demote caller. Do both atomically so the Home
      // is never left without (or with a duplicated unintended) owner.
      await prisma.$transaction([
        prisma.homeMember.update({
          where: { userId_homeId: { userId, homeId } },
          data: { role: "owner" },
        }),
        ...(keepOwnership
          ? []
          : [
              prisma.homeMember.update({
                where: { userId_homeId: { userId: callerId, homeId } },
                data: { role: "member" },
              }),
            ]),
      ]);

      return toHomeDTO(
        home,
        keepOwnership ? "owner" : "member",
        await isRecorderConsented(home.id, home.keyEpoch),
      );
    },
  );

  // Permanently delete a Home (owner only). Cascades in the schema remove the
  // Home's members, cameras, and pairing sessions; we first disarm the recorder
  // for any camera that's currently recording so no capture jobs are orphaned.
  app.delete("/homes/:homeId", { preHandler: requireUser }, async (req, reply): Promise<void> => {
    const { homeId } = req.params as { homeId: string };
    await requireOwner(req.user!.id, homeId);

    const home = await prisma.home.findUnique({ where: { id: homeId } });
    if (!home) throw notFound("Home not found");

    const recording = await prisma.camera.findMany({
      where: { homeId, recordingEnabled: true },
      select: { id: true },
    });
    for (const cam of recording) {
      void disarmRecording(homeId, cam.id, req.log);
    }

    await prisma.home.delete({ where: { id: homeId } });
    reply.code(204);
  });
}
