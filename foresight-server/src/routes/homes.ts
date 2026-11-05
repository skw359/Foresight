/**
 * Home routes: list/create Homes, membership (add, change role, remove/leave,
 * transfer ownership), Home deletion, the owner-visible audit trail, and the
 * per-camera recorder health summary. A Home is a group of cameras.
 *
 * Invariant: a Home always keeps at least one owner. Every path that changes
 * or removes an owner checks it inside the same transaction.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  AuditLogResponse,
  HomeDTO,
  HomeMemberDTO,
  MemberRole,
  RecordingHealthResponse,
} from "@foresight/contract";
import { prisma } from "../db.js";
import { requireUser } from "../auth.js";
import { toHomeDTO } from "../lib/dto.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { requireMember, requireOwner } from "../lib/membership.js";
import { isRecorderConsented, recorderConsentMap } from "../lib/homeKeys.js";
import { IDENTIFIER_MAX, NAME_MAX, parseBody } from "../lib/validate.js";
import { audit, toAuditDTO, userActor } from "../lib/audit.js";
import { removeMember } from "../lib/revocation.js";
import { disarmRecording, recorderStatus } from "../recorder-client.js";
import { closeHomeRoom } from "../livekit.js";

const createHome = z.object({
  name: z.string().trim().min(1, "name is required").max(NAME_MAX, "name is too long"),
});
const addMember = z.object({
  identifier: z.string().trim().min(1, "identifier is required").max(IDENTIFIER_MAX),
  role: z.enum(["owner", "member"]).optional(),
});
const updateMember = z.object({ role: z.enum(["owner", "member"]) });
const transferOwnership = z.object({
  userId: z.string().trim().min(1, "userId is required").max(64),
  keepOwnership: z.boolean().optional(),
});

/** Change a member's role, refusing to demote the Home's last owner. */
async function setRole(homeId: string, userId: string, role: MemberRole): Promise<"changed" | "unchanged"> {
  return prisma.$transaction(async (tx) => {
    const member = await tx.homeMember.findUnique({ where: { userId_homeId: { userId, homeId } } });
    if (!member) throw notFound("That user is not a member of this Home");
    if (member.role === role) return "unchanged";
    if (member.role === "owner" && role !== "owner") {
      const owners = await tx.homeMember.count({ where: { homeId, role: "owner" } });
      if (owners <= 1) {
        throw conflict("A Home must keep at least one owner", { reason: "last_owner" });
      }
    }
    await tx.homeMember.update({ where: { userId_homeId: { userId, homeId } }, data: { role } });
    return "changed";
  });
}

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

  // Add an existing user to a Home (owner only). Re-adding someone who is
  // already a member is NOT a silent role reset: their role only changes when
  // one is given explicitly, and never in a way that leaves the Home ownerless.
  app.post("/homes/:homeId/members", { preHandler: requireUser }, async (req): Promise<HomeDTO> => {
    const { homeId } = req.params as { homeId: string };
    const { identifier, role } = parseBody(addMember, req.body);
    await requireOwner(req.user!.id, homeId, "add members");

    const home = await prisma.home.findUnique({ where: { id: homeId } });
    if (!home) throw notFound("Home not found");

    const target = await prisma.user.findUnique({ where: { identifier } });
    if (!target) throw notFound("No user with that email or username");
    if (target.id === req.user!.id) throw badRequest("You are already in this Home", "self_add");

    const existing = await prisma.homeMember.findUnique({
      where: { userId_homeId: { userId: target.id, homeId } },
    });
    if (!existing) {
      await prisma.homeMember.create({ data: { userId: target.id, homeId, role: role ?? "member" } });
      await audit(
        {
          homeId,
          actor: userActor(req.user!),
          action: "member.added",
          targetType: "user",
          targetId: target.id,
          details: { identifier: target.identifier, role: role ?? "member" },
        },
        req.log,
      );
    } else if (role && role !== existing.role) {
      await setRole(homeId, target.id, role);
      await audit(
        {
          homeId,
          actor: userActor(req.user!),
          action: "member.role_changed",
          targetType: "user",
          targetId: target.id,
          details: { identifier: target.identifier, from: existing.role, to: role },
        },
        req.log,
      );
    }

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

  // Change a member's role (owner only; the last owner cannot be demoted).
  app.patch(
    "/homes/:homeId/members/:userId",
    { preHandler: requireUser },
    async (req): Promise<HomeMemberDTO> => {
      const { homeId, userId } = req.params as { homeId: string; userId: string };
      const { role } = parseBody(updateMember, req.body);
      await requireOwner(req.user!.id, homeId, "change member roles");
      const before = await prisma.homeMember.findUnique({
        where: { userId_homeId: { userId, homeId } },
        include: { user: true },
      });
      if (!before) throw notFound("That user is not a member of this Home");
      if ((await setRole(homeId, userId, role)) === "changed") {
        await audit(
          {
            homeId,
            actor: userActor(req.user!),
            action: "member.role_changed",
            targetType: "user",
            targetId: userId,
            details: { identifier: before.user.identifier, from: before.role, to: role },
          },
          req.log,
        );
      }
      return { userId, identifier: before.user.identifier, role, publicKey: before.user.publicKey ?? null };
    },
  );

  // Remove a member (owner), or leave a Home (any member, for themselves).
  // Evicts the user's live sessions from the Home's room and, for an E2EE
  // Home, flags the key for rotation (their copy of the current key still works
  // until the owner rotates).
  app.delete(
    "/homes/:homeId/members/:userId",
    { preHandler: requireUser },
    async (req, reply): Promise<void> => {
      const { homeId, userId } = req.params as { homeId: string; userId: string };
      const callerId = req.user!.id;
      if (userId === callerId) await requireMember(callerId, homeId);
      else await requireOwner(callerId, homeId, "remove members");
      await removeMember(homeId, userId, userActor(req.user!), req.log);
      reply.code(204);
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
      await requireOwner(callerId, homeId, "transfer ownership");

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
      await audit(
        {
          homeId,
          actor: userActor(req.user!),
          action: "home.ownership_transferred",
          targetType: "user",
          targetId: userId,
          details: { keepOwnership: keepOwnership ?? false },
        },
        req.log,
      );

      return toHomeDTO(
        home,
        keepOwnership ? "owner" : "member",
        await isRecorderConsented(home.id, home.keyEpoch),
      );
    },
  );

  // Permanently delete a Home (owner only). Cascades in the schema remove the
  // Home's members, cameras, pairing sessions, keys and audit trail; we first
  // disarm the recorder for any camera that's currently recording so no capture
  // jobs are orphaned, then close the LiveKit room so every connected camera
  // and viewer is disconnected immediately.
  app.delete("/homes/:homeId", { preHandler: requireUser }, async (req, reply): Promise<void> => {
    const { homeId } = req.params as { homeId: string };
    await requireOwner(req.user!.id, homeId, "delete this Home");

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
    await closeHomeRoom(homeId, req.log);
    req.log.info({ homeId, by: req.user!.id }, "home deleted");
    reply.code(204);
  });

  // The Home's audit trail, newest first (owner only). `before` is the id of
  // the oldest event already shown, for paging.
  app.get(
    "/homes/:homeId/audit",
    { preHandler: requireUser },
    async (req): Promise<AuditLogResponse> => {
      const { homeId } = req.params as { homeId: string };
      const q = req.query as { before?: string; limit?: string };
      await requireOwner(req.user!.id, homeId, "view the audit log");
      const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
      let cursorDate: Date | undefined;
      if (q.before) {
        const anchor = await prisma.auditEvent.findUnique({ where: { id: q.before } });
        if (anchor && anchor.homeId === homeId) cursorDate = anchor.createdAt;
      }
      const rows = await prisma.auditEvent.findMany({
        where: { homeId, ...(cursorDate ? { createdAt: { lt: cursorDate } } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      return {
        events: page.map(toAuditDTO),
        nextBefore: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    },
  );

  // Recorder health for every camera in the Home (any member): is 24/7
  // recording actually writing segments? Proxied from the recorder's loopback
  // /status so the dashboard can flag a failing encoder.
  app.get(
    "/homes/:homeId/recording-health",
    { preHandler: requireUser },
    async (req): Promise<RecordingHealthResponse> => {
      const { homeId } = req.params as { homeId: string };
      await requireMember(req.user!.id, homeId);
      const cameras = await prisma.camera.findMany({ where: { homeId }, select: { id: true } });
      const status = await recorderStatus(req.log);
      const states = status?.homes?.[homeId] ?? [];
      return {
        recorderReachable: status !== null,
        cameras: cameras.map((c) => {
          const s = states.find((x) => x.cameraId === c.id);
          return {
            cameraId: c.id,
            state: s?.state ?? null,
            lastSegmentAt: s?.lastSegmentAt ?? null,
            droppedFrames: s?.droppedFrames ?? 0,
          };
        }),
      };
    },
  );
}
