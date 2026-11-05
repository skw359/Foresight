/**
 * Home membership lookups + guards shared across routes. A user may only see or
 * control cameras in Homes they belong to; only owners may add members.
 */
import type { MemberRole } from "@foresight/contract";
import { prisma } from "../db.js";
import { forbidden, notFound } from "./errors.js";

/** Returns the user's role in the Home, or null if they are not a member. */
export async function membershipRole(userId: string, homeId: string): Promise<MemberRole | null> {
  const m = await prisma.homeMember.findUnique({
    where: { userId_homeId: { userId, homeId } },
  });
  return (m?.role as MemberRole | undefined) ?? null;
}

/** Throw unless the user is a member of the Home; returns their role. */
export async function requireMember(userId: string, homeId: string): Promise<MemberRole> {
  const role = await membershipRole(userId, homeId);
  if (!role) throw forbidden("You are not a member of this Home");
  return role;
}

/** Throw unless the user is the owner of the Home. */
export async function requireOwner(userId: string, homeId: string, action = "do this"): Promise<void> {
  const role = await membershipRole(userId, homeId);
  if (!role) throw forbidden("You are not a member of this Home");
  if (role !== "owner") throw forbidden(`Only a Home owner can ${action}`, { reason: "owner_only" });
}

/** Load a camera and assert the user is a member of its Home. */
export async function requireCameraAccess(userId: string, cameraId: string) {
  const camera = await prisma.camera.findUnique({ where: { id: cameraId } });
  if (!camera) throw notFound("Camera not found");
  await requireMember(userId, camera.homeId);
  return camera;
}

/**
 * Load a camera and assert the user OWNS its Home. Destructive camera actions —
 * deleting the camera, turning 24/7 recording off, deleting footage — are
 * owner-only: a member account (or a stolen member token) must not be able to
 * blind cameras and erase evidence.
 */
export async function requireCameraOwner(userId: string, cameraId: string, action: string) {
  const camera = await prisma.camera.findUnique({ where: { id: cameraId } });
  if (!camera) throw notFound("Camera not found");
  await requireOwner(userId, camera.homeId, action);
  return camera;
}
