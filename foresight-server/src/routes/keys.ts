/**
 * E2EE key-management routes (shared/E2EE.md §7.1). The route map is the
 * canonical one documented at the top of the REST section in
 * shared/ts/src/e2ee.ts. THE SERVER DOES NO CRYPTO: every value handled here is
 * an opaque base64 blob it stores and serves. Validation is shape/size only
 * (lib/e2ee.ts). Sealing, unsealing, and key derivation happen exclusively on
 * clients.
 *
 *   POST /me/keys                       create the caller's vault (replacing a different one needs the password) → 204
 *   GET  /me/keys                       → MeKeysResponse
 *   GET  /homes/:homeId/key             → HomeKeyResponse (caller's own copy)
 *   GET  /homes/:homeId/key/pending     → PendingKeyHoldersResponse
 *   GET  /homes/:homeId/key/holders     → PendingKeyHoldersResponse (owner; every rotation target)
 *   POST /homes/:homeId/key             submit sealed copies  → 204 (idempotent; §10.5 — first-contact user/recorder seals are owner-only)
 *   DELETE /homes/:homeId/key/:holderType/:holderId  owner repair → 204 (drops the holder's current-epoch copy → back to pending)
 *   POST /homes/:homeId/key/init        owner activation (0→lastKeyEpoch+1)  → HomeKeyEpochResponse
 *   POST /homes/:homeId/key/rotate      owner rotation  → HomeKeyEpochResponse
 *   POST /homes/:homeId/key/disable     owner turns E2EE off (→0)  → HomeKeyEpochResponse
 *   POST /homes/:homeId/recorder-consent  owner  → RecorderConsentResponse
 *   GET  /e2ee/recorder-identity        → RecorderIdentityResponse
 */
import type { FastifyInstance } from "fastify";
import type {
  HomeKeyEpochResponse,
  HomeKeyResponse,
  MeKeysResponse,
  MemberRole,
  PendingKeyHolder,
  PendingKeyHoldersResponse,
  RecorderConsentResponse,
  RecorderIdentityResponse,
  SealedKeyUpload,
} from "@foresight/contract";
import { makeRekey } from "@foresight/contract";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { requireUser, verifyPassword } from "../auth.js";
import { toKeyVault } from "../lib/dto.js";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../lib/errors.js";
import { audit, userActor } from "../lib/audit.js";
import { enforce, limits } from "../lib/rateLimit.js";

import { requireMember, requireOwner } from "../lib/membership.js";
import { parseBody } from "../lib/validate.js";
import {
  setKeyVaultSchema,
  holderTypeSchema,
  initHomeKeySchema,
  recorderConsentSchema,
  rotateHomeKeySchema,
  submitSealedKeysSchema,
} from "../lib/e2ee.js";
import { disarmRecording, rekeyRecorder, revokeRecorder } from "../recorder-client.js";
import { broadcastToHome } from "../livekit.js";

/**
 * Assert each uploaded holder exists with the pubkey role its type implies:
 *   user     — a member of THIS Home who has set up a key vault
 *   camera   — a camera that belongs to THIS Home and has a registered pubkey
 *   recorder — matches the currently-registered RecorderIdentity
 * Rejects the whole request (400 invalid_holder) if any holder is illegitimate.
 */
async function assertHoldersValid(homeId: string, keys: SealedKeyUpload[]): Promise<void> {
  const userIds = [...new Set(keys.filter((k) => k.holderType === "user").map((k) => k.holderId))];
  const cameraIds = [...new Set(keys.filter((k) => k.holderType === "camera").map((k) => k.holderId))];
  const recorderIds = [...new Set(keys.filter((k) => k.holderType === "recorder").map((k) => k.holderId))];

  if (userIds.length) {
    const members = await prisma.homeMember.findMany({
      where: { homeId, userId: { in: userIds } },
      include: { user: { select: { publicKey: true } } },
    });
    const valid = new Set(members.filter((m) => m.user.publicKey).map((m) => m.userId));
    for (const id of userIds) {
      if (!valid.has(id)) {
        throw badRequest(`user:${id} is not a member of this Home with a key vault`, "invalid_holder");
      }
    }
  }
  if (cameraIds.length) {
    const cams = await prisma.camera.findMany({
      where: { homeId, id: { in: cameraIds } },
      select: { id: true, publicKey: true },
    });
    const valid = new Set(cams.filter((c) => c.publicKey).map((c) => c.id));
    for (const id of cameraIds) {
      if (!valid.has(id)) {
        throw badRequest(`camera:${id} does not belong to this Home or has no public key`, "invalid_holder");
      }
    }
  }
  if (recorderIds.length) {
    const identity = await prisma.recorderIdentity.findFirst({
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    for (const id of recorderIds) {
      if (!identity || identity.id !== id) {
        throw badRequest(`recorder:${id} does not match the registered recorder identity`, "invalid_holder");
      }
    }
  }
}

/**
 * §6/§10.5 authority rule, server-enforced: a non-owner may seal a FIRST-CONTACT
 * camera (the member who paired it) and epoch-backfill any holder that already
 * held a key at a previous epoch — but first-contact user/recorder seals are
 * owner-only (403 first_contact_owner_only). Poisoning defense: without this,
 * any member could upload garbage for a new member/the recorder and the
 * first-write-wins upsert would stick them at "awaiting key" forever.
 */
async function assertSealAuthority(role: MemberRole, homeId: string, keys: SealedKeyUpload[]): Promise<void> {
  if (role === "owner") return;
  const pairs = [...new Map(keys.map((k) => [`${k.holderType}:${k.holderId}`, k])).values()];
  const rows = await prisma.homeKey.findMany({
    where: { homeId, OR: pairs.map((k) => ({ holderType: k.holderType, holderId: k.holderId })) },
    select: { holderType: true, holderId: true },
  });
  const everSealed = new Set(rows.map((r) => `${r.holderType}:${r.holderId}`));
  const offending = pairs.filter((k) => k.holderType !== "camera" && !everSealed.has(`${k.holderType}:${k.holderId}`));
  if (offending.length > 0) {
    throw forbidden("Only a Home owner can grant first-time access to a member or the recorder", {
      reason: "first_contact_owner_only",
      holders: offending.map(({ holderType, holderId }) => ({ holderType, holderId })),
    });
  }
}

/**
 * Build the idempotent upsert operations for a batch of sealed keys at `epoch`.
 * The unique constraint (homeId, epoch, holderType, holderId) makes re-submits a
 * no-op: an existing row is never overwritten (update: {}), so `sealedBy` is the
 * audit record of the FIRST writer.
 */
function upsertKeyOps(homeId: string, epoch: number, keys: SealedKeyUpload[], sealedBy: string) {
  return keys.map((k) =>
    prisma.homeKey.upsert({
      where: {
        homeId_epoch_holderType_holderId: { homeId, epoch, holderType: k.holderType, holderId: k.holderId },
      },
      create: { homeId, epoch, holderType: k.holderType, holderId: k.holderId, sealedKey: k.sealedKey, sealedBy },
      update: {},
    }),
  );
}

/**
 * Holders that should hold a current-epoch sealed key but don't. Candidates are
 * members WITH a pubkey, cameras WITH a pubkey, and the recorder IF a recorder
 * HomeKey row exists at any epoch (consent active-or-being-lost). `firstContact`
 * = the holder has no HomeKey row for this Home at ANY epoch.
 *
 * At keyEpoch 0 this doubles as the ACTIVATION candidate list: no HomeKey row
 * can exist pre-activation (every write path requires epoch ≥ 1, and key/disable
 * deletes them all), so it
 * degenerates to "every member/camera with a pubkey, all firstContact". The web
 * activation precheck + key/init seal targets consume exactly that — do not
 * short-circuit to [] here.
 */
async function computePending(
  homeId: string,
  keyEpoch: number,
  opts: { all?: boolean } = {},
): Promise<PendingKeyHolder[]> {
  const [members, cameras, keyRows, recorderIdentity] = await Promise.all([
    prisma.homeMember.findMany({
      where: { homeId },
      include: { user: { select: { id: true, identifier: true, publicKey: true } } },
    }),
    prisma.camera.findMany({ where: { homeId }, select: { id: true, name: true, publicKey: true } }),
    prisma.homeKey.findMany({ where: { homeId }, select: { epoch: true, holderType: true, holderId: true } }),
    prisma.recorderIdentity.findFirst({ orderBy: { createdAt: "desc" } }),
  ]);

  const key = (t: string, id: string) => `${t}:${id}`;
  const atCurrent = new Set(keyRows.filter((r) => r.epoch === keyEpoch).map((r) => key(r.holderType, r.holderId)));
  const atAny = new Set(keyRows.map((r) => key(r.holderType, r.holderId)));
  const recorderEverSealed = keyRows.some((r) => r.holderType === "recorder");

  const pending: PendingKeyHolder[] = [];

  for (const m of members) {
    if (!m.user.publicKey) continue; // no vault yet → "waiting for access" on their side
    const k = key("user", m.user.id);
    if (atCurrent.has(k) && !opts.all) continue;
    pending.push({
      holderType: "user",
      holderId: m.user.id,
      publicKey: m.user.publicKey,
      label: m.user.identifier,
      firstContact: !atAny.has(k),
    });
  }
  for (const c of cameras) {
    if (!c.publicKey) continue;
    const k = key("camera", c.id);
    if (atCurrent.has(k) && !opts.all) continue;
    pending.push({
      holderType: "camera",
      holderId: c.id,
      publicKey: c.publicKey,
      label: c.name,
      firstContact: !atAny.has(k),
    });
  }
  // The recorder is a pending candidate only where consent already existed (a
  // recorder row at some epoch) but is missing at the current epoch — i.e. an
  // epoch backfill after a rotate. First consent is granted via recorder-consent.
  if (opts.all) {
    // Rotation targets: the recorder only while its consent is IN FORCE (a row
    // at the current epoch) — a rotation must never grant consent implicitly.
    if (recorderIdentity && atCurrent.has(key("recorder", recorderIdentity.id))) {
      pending.push({
        holderType: "recorder",
        holderId: recorderIdentity.id,
        publicKey: recorderIdentity.publicKey,
        label: "recorder",
        firstContact: false,
      });
    }
  } else if (recorderEverSealed && recorderIdentity) {
    const k = key("recorder", recorderIdentity.id);
    if (!atCurrent.has(k)) {
      pending.push({
        holderType: "recorder",
        holderId: recorderIdentity.id,
        publicKey: recorderIdentity.publicKey,
        label: "recorder",
        firstContact: !atAny.has(k),
      });
    }
  }
  return pending;
}

export async function keyRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------- /me/keys
  // Create the caller's key vault, or replace it WITH PROOF. A first vault
  // needs only the session (first-login key generation). Replacing an existing,
  // DIFFERENT vault also needs the account password: otherwise a stolen session
  // token alone could install an attacker's public key, and members' clients
  // that haven't pinned this user yet would seal the Home key to it.
  app.post("/me/keys", { preHandler: requireUser }, async (req, reply): Promise<void> => {
    const { currentPassword, ...vault } = parseBody(setKeyVaultSchema, req.body);
    const user = req.user!;
    const existing = toKeyVault(user);
    const identical =
      existing !== null &&
      existing.publicKey === vault.publicKey &&
      existing.wrappedPrivateKey === vault.wrappedPrivateKey &&
      existing.nonce === vault.nonce;
    if (identical) {
      reply.code(204);
      return;
    }
    if (existing !== null) {
      if (!currentPassword) {
        throw conflict("A key vault already exists; confirm your password to replace it", {
          reason: "vault_exists",
        });
      }
      enforce(limits.reauthPerUser, user.id);
      if (!(await verifyPassword(user.passwordHash, currentPassword))) {
        throw unauthorized("Password is incorrect");
      }
      limits.reauthPerUser.reset(user.id);
      req.log.warn({ userId: user.id, keyChanged: existing.publicKey !== vault.publicKey }, "key vault replaced");
    }
    await prisma.user.update({
      where: { id: user.id },
      data: {
        publicKey: vault.publicKey,
        wrappedPrivateKey: vault.wrappedPrivateKey,
        keyNonce: vault.nonce,
        keyKdf: vault.kdf as unknown as Prisma.InputJsonValue,
      },
    });
    reply.code(204);
  });

  app.get("/me/keys", { preHandler: requireUser }, async (req): Promise<MeKeysResponse> => {
    return { keyVault: toKeyVault(req.user!) };
  });

  // --------------------------------------------------- /homes/:homeId/key (GET)
  app.get("/homes/:homeId/key", { preHandler: requireUser }, async (req): Promise<HomeKeyResponse> => {
    const { homeId } = req.params as { homeId: string };
    await requireMember(req.user!.id, homeId);
    const home = await prisma.home.findUnique({ where: { id: homeId }, select: { keyEpoch: true } });
    if (!home) throw notFound("Home not found");
    if (home.keyEpoch < 1) return { epoch: home.keyEpoch, sealedKey: null };
    const row = await prisma.homeKey.findUnique({
      where: {
        homeId_epoch_holderType_holderId: {
          homeId,
          epoch: home.keyEpoch,
          holderType: "user",
          holderId: req.user!.id,
        },
      },
      select: { sealedKey: true },
    });
    return { epoch: home.keyEpoch, sealedKey: row?.sealedKey ?? null };
  });

  // ------------------------------------------- /homes/:homeId/key/pending (GET)
  app.get(
    "/homes/:homeId/key/pending",
    { preHandler: requireUser },
    async (req): Promise<PendingKeyHoldersResponse> => {
      const { homeId } = req.params as { homeId: string };
      await requireMember(req.user!.id, homeId);
      const home = await prisma.home.findUnique({ where: { id: homeId }, select: { keyEpoch: true } });
      if (!home) throw notFound("Home not found");
      return { epoch: home.keyEpoch, pending: await computePending(homeId, home.keyEpoch) };
    },
  );

  // -------------------------------------------- /homes/:homeId/key/holders (GET)
  // Owner only: EVERY holder that should receive the key at the next epoch
  // (members + cameras with pubkeys, plus the recorder while consented), so a
  // rotation can seal to all of them in ONE request. The server broadcasts
  // `rekey` as soon as the rotation commits, so copies sealed only afterwards
  // (a post-rotate backfill) would arrive after cameras already re-fetched.
  app.get(
    "/homes/:homeId/key/holders",
    { preHandler: requireUser },
    async (req): Promise<PendingKeyHoldersResponse> => {
      const { homeId } = req.params as { homeId: string };
      await requireOwner(req.user!.id, homeId, "rotate this Home's key");
      const home = await prisma.home.findUnique({ where: { id: homeId }, select: { keyEpoch: true } });
      if (!home) throw notFound("Home not found");
      return { epoch: home.keyEpoch, pending: await computePending(homeId, home.keyEpoch, { all: true }) };
    },
  );

  // -------------------------------------------------- /homes/:homeId/key (POST)
  app.post("/homes/:homeId/key", { preHandler: requireUser }, async (req, reply): Promise<void> => {
    const { homeId } = req.params as { homeId: string };
    const { epoch, keys } = parseBody(submitSealedKeysSchema, req.body);
    const role = await requireMember(req.user!.id, homeId);

    const home = await prisma.home.findUnique({ where: { id: homeId }, select: { keyEpoch: true } });
    if (!home) throw notFound("Home not found");
    if (home.keyEpoch < 1) throw conflict("E2EE is not activated for this Home", { reason: "not_activated" });
    if (epoch !== home.keyEpoch) {
      throw conflict("Stale epoch; refetch the current key and retry", { reason: "stale_epoch", keyEpoch: home.keyEpoch });
    }

    await assertHoldersValid(homeId, keys);
    await assertSealAuthority(role, homeId, keys);
    await prisma.$transaction(upsertKeyOps(homeId, epoch, keys, req.user!.id));
    // A backfilled recorder copy is the recorder's cue to resume: nudge it now
    // rather than leaving recording held until the next periodic reconcile.
    if (keys.some((k) => k.holderType === "recorder")) void rekeyRecorder(homeId, epoch, req.log);
    reply.code(204);
  });

  // -------------------- /homes/:homeId/key/:holderType/:holderId (DELETE)
  // Owner-only repair path for a poisoned or undecryptable sealed copy: drops
  // ONLY the holder's current-epoch row so they return to /key/pending for an
  // explicit owner re-grant. Older-epoch history rows are kept, so a holder
  // that legitimately held a key stays firstContact=false there (member
  // backfill remains possible). Idempotent — deleting a missing row is 204.
  app.delete(
    "/homes/:homeId/key/:holderType/:holderId",
    { preHandler: requireUser },
    async (req, reply): Promise<void> => {
      const { homeId, holderType, holderId } = req.params as {
        homeId: string;
        holderType: string;
        holderId: string;
      };
      const parsed = holderTypeSchema.safeParse(holderType);
      if (!parsed.success) throw badRequest("invalid holder type");
      await requireOwner(req.user!.id, homeId);

      const home = await prisma.home.findUnique({ where: { id: homeId }, select: { keyEpoch: true } });
      if (!home) throw notFound("Home not found");
      if (home.keyEpoch < 1) throw conflict("E2EE is not activated for this Home", { reason: "not_activated" });

      await prisma.homeKey.deleteMany({
        where: { homeId, epoch: home.keyEpoch, holderType: parsed.data, holderId },
      });
      await audit(
        {
          homeId,
          actor: userActor(req.user!),
          action: "e2ee.key_copy_dropped",
          targetType: parsed.data,
          targetId: holderId,
          details: { epoch: home.keyEpoch },
        },
        req.log,
      );
      reply.code(204);
    },
  );

  // --------------------------------------------- /homes/:homeId/key/init (POST)
  app.post(
    "/homes/:homeId/key/init",
    { preHandler: requireUser },
    async (req): Promise<HomeKeyEpochResponse> => {
      const { homeId } = req.params as { homeId: string };
      const { keys } = parseBody(initHomeKeySchema, req.body);
      await requireOwner(req.user!.id, homeId);

      const home = await prisma.home.findUnique({
        where: { id: homeId },
        select: { keyEpoch: true, lastKeyEpoch: true },
      });
      if (!home) throw notFound("Home not found");
      if (home.keyEpoch !== 0) {
        throw conflict("E2EE is already activated for this Home", { reason: "already_activated", keyEpoch: home.keyEpoch });
      }
      if (!req.user!.publicKey) {
        throw conflict("Set up your account keys before activating E2EE", { reason: "no_owner_vault" });
      }

      // Activation precondition: every camera must have registered a pubkey. The
      // 409 body lists the laggards so the UI can show "waiting for camera updates".
      const cams = await prisma.camera.findMany({ where: { homeId }, select: { id: true, name: true, publicKey: true } });
      const missing = cams.filter((c) => !c.publicKey).map((c) => ({ id: c.id, name: c.name }));
      if (missing.length > 0) {
        throw conflict("Every camera must register a public key before activating E2EE", {
          reason: "cameras_missing_pubkey",
          cameras: missing,
        });
      }

      if (!keys.some((k) => k.holderType === "user" && k.holderId === req.user!.id)) {
        throw badRequest("init keys must include your own user copy", "missing_owner_key");
      }
      await assertHoldersValid(homeId, keys);

      // 1 for a first activation; after a disable, one past the last epoch used.
      const epoch = home.lastKeyEpoch + 1;
      await prisma.$transaction([
        prisma.home.update({ where: { id: homeId }, data: { keyEpoch: epoch, keyRotationRequired: false } }),
        ...upsertKeyOps(homeId, epoch, keys, req.user!.id),
      ]);
      // Tell every CONNECTED participant. Cameras and viewers in the room are
      // publishing/subscribing in plaintext, and frame encryption is fixed when
      // a room connects: without this they would keep streaming plaintext until
      // some unrelated reconnect — possibly weeks for a stationary camera —
      // while the Home is shown as encrypted. Sent by the server so it doesn't
      // depend on the owner's own room connection.
      void broadcastToHome(homeId, makeRekey(epoch), req.log);
      void rekeyRecorder(homeId, epoch, req.log);
      await audit(
        { homeId, actor: userActor(req.user!), action: "e2ee.activated", details: { epoch, holders: keys.length } },
        req.log,
      );
      return { keyEpoch: epoch };
    },
  );

  // ------------------------------------------- /homes/:homeId/key/rotate (POST)
  app.post(
    "/homes/:homeId/key/rotate",
    { preHandler: requireUser },
    async (req): Promise<HomeKeyEpochResponse> => {
      const { homeId } = req.params as { homeId: string };
      const { fromEpoch, keys } = parseBody(rotateHomeKeySchema, req.body);
      await requireOwner(req.user!.id, homeId);

      const home = await prisma.home.findUnique({ where: { id: homeId }, select: { keyEpoch: true } });
      if (!home) throw notFound("Home not found");
      if (home.keyEpoch < 1) {
        throw conflict("E2EE is not activated for this Home; use key/init", { reason: "not_activated" });
      }
      if (fromEpoch !== home.keyEpoch) {
        throw conflict("Stale fromEpoch; refetch the current epoch and retry", { reason: "stale_epoch", keyEpoch: home.keyEpoch });
      }

      await assertHoldersValid(homeId, keys);

      // With recorder consent in force, the new epoch MUST carry the recorder's
      // copy. Committing an epoch the recorder can't open would stall 24/7
      // recording until a later backfill — a footage gap on every rotation.
      const recorderRow = await prisma.homeKey.findFirst({
        where: { homeId, epoch: home.keyEpoch, holderType: "recorder" },
        select: { holderId: true },
      });
      if (recorderRow && !keys.some((k) => k.holderType === "recorder")) {
        throw conflict("Include the recorder's sealed copy when rotating a Home with recorder consent", {
          reason: "recorder_key_required",
          recorderId: recorderRow.holderId,
        });
      }

      const newEpoch = home.keyEpoch + 1;
      await prisma.$transaction([
        prisma.home.update({ where: { id: homeId }, data: { keyEpoch: newEpoch, keyRotationRequired: false } }),
        ...upsertKeyOps(homeId, newEpoch, keys, req.user!.id),
      ]);
      // Every connected participant must re-fetch its sealed copy — sent by the
      // server so a rotation never depends on the rotating client being in the
      // room (otherwise cameras keep the OLD key while viewers fetch the new one).
      void broadcastToHome(homeId, makeRekey(newEpoch), req.log);
      // Best-effort nudge so the recorder re-fetches its sealed key immediately.
      void rekeyRecorder(homeId, newEpoch, req.log);
      await audit(
        {
          homeId,
          actor: userActor(req.user!),
          action: "e2ee.rotated",
          details: { fromEpoch, toEpoch: newEpoch, holders: keys.length },
        },
        req.log,
      );
      return { keyEpoch: newEpoch };
    },
  );

  // ------------------------------------------ /homes/:homeId/key/disable (POST)
  // Owner turns E2EE off. Every sealed copy is dropped, so a later key/init is
  // a fresh activation: first contact for every holder, recorder included (an
  // old recorder row must never let a member re-seal to it without consent).
  // Recording is left as-is: at epoch 0 it needs no consent.
  app.post(
    "/homes/:homeId/key/disable",
    { preHandler: requireUser },
    async (req): Promise<HomeKeyEpochResponse> => {
      const { homeId } = req.params as { homeId: string };
      await requireOwner(req.user!.id, homeId);

      const home = await prisma.home.findUnique({ where: { id: homeId }, select: { keyEpoch: true } });
      if (!home) throw notFound("Home not found");
      if (home.keyEpoch < 1) {
        throw conflict("E2EE is not activated for this Home", { reason: "not_activated" });
      }

      await prisma.$transaction([
        prisma.home.update({
          where: { id: homeId },
          data: { keyEpoch: 0, lastKeyEpoch: home.keyEpoch, keyRotationRequired: false },
        }),
        prisma.homeKey.deleteMany({ where: { homeId } }),
      ]);
      // Cameras, viewers and the recorder are connected with frame encryption,
      // which only a reconnect can drop. The server sends the rekey itself so
      // the switch doesn't depend on the owner's own room connection.
      void broadcastToHome(homeId, makeRekey(0), req.log);
      void rekeyRecorder(homeId, 0, req.log);
      await audit(
        { homeId, actor: userActor(req.user!), action: "e2ee.disabled", details: { lastEpoch: home.keyEpoch } },
        req.log,
      );
      return { keyEpoch: 0 };
    },
  );

  // ----------------------------------- /homes/:homeId/recorder-consent (POST)
  app.post(
    "/homes/:homeId/recorder-consent",
    { preHandler: requireUser },
    async (req): Promise<RecorderConsentResponse> => {
      const { homeId } = req.params as { homeId: string };
      const { enabled, sealedKey } = parseBody(recorderConsentSchema, req.body);
      await requireOwner(req.user!.id, homeId);

      const home = await prisma.home.findUnique({ where: { id: homeId }, select: { keyEpoch: true } });
      if (!home) throw notFound("Home not found");

      if (enabled) {
        if (home.keyEpoch < 1) {
          throw conflict("Activate E2EE before enabling the recorder", { reason: "not_activated" });
        }
        if (!sealedKey) throw badRequest("sealedKey is required when enabling recorder consent");
        const identity = await prisma.recorderIdentity.findFirst({
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        if (!identity) throw conflict("No recorder identity is registered", { reason: "no_recorder_identity" });
        await prisma.homeKey.upsert({
          where: {
            homeId_epoch_holderType_holderId: {
              homeId,
              epoch: home.keyEpoch,
              holderType: "recorder",
              holderId: identity.id,
            },
          },
          create: {
            homeId,
            epoch: home.keyEpoch,
            holderType: "recorder",
            holderId: identity.id,
            sealedKey,
            sealedBy: req.user!.id,
          },
          update: {},
        });
        await prisma.home.update({ where: { id: homeId }, data: { recorderConsentRevokedAt: null } });
        void rekeyRecorder(homeId, home.keyEpoch, req.log);
        await audit(
          { homeId, actor: userActor(req.user!), action: "recorder_consent.granted", details: { epoch: home.keyEpoch } },
          req.log,
        );
        return { recorderConsented: true, keyEpoch: home.keyEpoch };
      }

      // Disable: delete ALL recorder rows for this Home (every epoch) and disarm
      // recording home-wide. The owner's client follows up with a rotate so the
      // recorder loses access to future epochs (server only deletes rows).
      const recordingCams = await prisma.camera.findMany({
        where: { homeId, recordingEnabled: true },
        select: { id: true },
      });
      await prisma.$transaction([
        prisma.homeKey.deleteMany({ where: { homeId, holderType: "recorder" } }),
        prisma.camera.updateMany({ where: { homeId }, data: { recordingEnabled: false } }),
        prisma.home.update({ where: { id: homeId }, data: { recorderConsentRevokedAt: new Date() } }),
      ]);
      for (const c of recordingCams) void disarmRecording(homeId, c.id, req.log);
      void revokeRecorder(homeId, req.log);
      await audit(
        {
          homeId,
          actor: userActor(req.user!),
          action: "recorder_consent.revoked",
          details: { camerasDisarmed: recordingCams.length },
        },
        req.log,
      );
      return { recorderConsented: false, keyEpoch: home.keyEpoch };
    },
  );

  // ----------------------------------------------- /e2ee/recorder-identity (GET)
  app.get(
    "/e2ee/recorder-identity",
    { preHandler: requireUser },
    async (): Promise<RecorderIdentityResponse> => {
      const identity = await prisma.recorderIdentity.findFirst({
        orderBy: { createdAt: "desc" },
        select: { publicKey: true },
      });
      return { publicKey: identity?.publicKey ?? null };
    },
  );
}
