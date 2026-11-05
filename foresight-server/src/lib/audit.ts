/**
 * Audit trail for destructive and security-relevant actions (AUTHZ-01).
 *
 * Every write is best-effort: an audit failure is logged and never fails the
 * action itself (the action already happened; refusing it after the fact would
 * only hide it). Rows hold the actor's label at the time, because users and
 * cameras can be deleted later.
 */
import type { FastifyBaseLogger } from "fastify";
import type { Camera, Prisma, User } from "@prisma/client";
import type { AuditActorType, AuditEventDTO } from "@foresight/contract";
import { prisma } from "../db.js";

export type AuditActor =
  | { type: "user"; user: Pick<User, "id" | "identifier"> }
  | { type: "camera"; camera: Pick<Camera, "id" | "name"> }
  | { type: "system" };

export interface AuditEntry {
  homeId: string | null;
  actor: AuditActor;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

function actorFields(actor: AuditActor): { actorType: AuditActorType; actorId: string | null; actorLabel: string | null } {
  switch (actor.type) {
    case "user":
      return { actorType: "user", actorId: actor.user.id, actorLabel: actor.user.identifier };
    case "camera":
      return { actorType: "camera", actorId: actor.camera.id, actorLabel: actor.camera.name };
    default:
      return { actorType: "system", actorId: null, actorLabel: null };
  }
}

export async function audit(entry: AuditEntry, log?: Pick<FastifyBaseLogger, "warn">): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        homeId: entry.homeId,
        ...actorFields(entry.actor),
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        details: (entry.details ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (err) {
    log?.warn({ err: String(err), action: entry.action }, "audit write failed");
  }
}

export function userActor(user: Pick<User, "id" | "identifier">): AuditActor {
  return { type: "user", user };
}

export function toAuditDTO(row: {
  id: string;
  homeId: string | null;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: unknown;
  createdAt: Date;
}): AuditEventDTO {
  return {
    id: row.id,
    homeId: row.homeId,
    actorType: row.actorType as AuditActorType,
    actorId: row.actorId,
    actorLabel: row.actorLabel,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    details: row.details ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
