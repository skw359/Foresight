/**
 * High-level E2EE key-lifecycle operations (E2EE_MODEL_B_PLAN.md §6).
 *
 * "Seal" = crypto_box_seal(HMK → holder pubkey). Every seal here is TOFU-pinned
 * (§10.5): a holder whose pinned key CHANGED is refused and reported as a
 * conflict — never silently re-sealed. The authority split from §6/§10.5:
 *   - reconcileBackfill: firstContact === false only (any current holder).
 *   - grantHolders / activateHome / recorder consent: explicit owner actions,
 *     may seal firstContact holders.
 *
 * These take plain args (no React) so both the room hook and the UIs can call
 * them. The server stores opaque blobs; all crypto is here + ../crypto.
 */
import type {
  HomeKeyEpochResponse,
  KeyHolderType,
  PendingKeyHolder,
  RecorderConsentResponse,
  SealedKeyUpload,
} from "@foresight/contract";

import {
  deleteHolderKey,
  getPendingKeyHolders,
  getRecorderIdentity,
  initHomeKey,
  listHomeMembers,
  rotateHomeKey,
  setRecorderConsent,
  submitSealedKeys,
} from "../api/client";
import { generateHmk, sealHmkBase64To } from "../crypto/homeKey";
import { checkPin, savePin } from "./pinning";

/** A holder whose pinned key changed — sealing is refused until an owner re-grants. */
export interface PinConflict {
  holderType: KeyHolderType;
  holderId: string;
  label: string;
  /** The new (unexpected) key the server presented. */
  publicKey: string;
}

/** Result of a sealing sweep. */
export interface SealResult {
  /** How many sealed copies were uploaded. */
  sealed: number;
  /** Holders skipped because their pinned key changed (surface a security alert). */
  conflicts: PinConflict[];
  /** Labels of holders pinned for the FIRST TIME on this device (TOFU notice). */
  newPins: string[];
}

interface SealTarget {
  holderType: KeyHolderType;
  holderId: string;
  publicKey: string;
  label: string;
}

/**
 * Seal `hmkBase64` to each target, enforcing TOFU pins. `allowRepin` re-pins a
 * changed key (used by the explicit owner re-grant path); otherwise a changed
 * pin becomes a conflict and is NOT sealed.
 */
async function sealTo(
  homeId: string,
  hmkBase64: string,
  targets: SealTarget[],
  allowRepin = false,
): Promise<{ uploads: SealedKeyUpload[]; conflicts: PinConflict[]; newPins: string[] }> {
  const uploads: SealedKeyUpload[] = [];
  const conflicts: PinConflict[] = [];
  const newPins: string[] = [];
  for (const t of targets) {
    const pin = checkPin(homeId, t.holderType, t.holderId, t.publicKey);
    if (pin === "changed" && !allowRepin) {
      conflicts.push({ holderType: t.holderType, holderId: t.holderId, label: t.label, publicKey: t.publicKey });
      continue;
    }
    uploads.push({
      holderType: t.holderType,
      holderId: t.holderId,
      sealedKey: await sealHmkBase64To(hmkBase64, t.publicKey),
    });
    if (pin !== "match") savePin(homeId, t.holderType, t.holderId, t.publicKey);
    if (pin === "new") newPins.push(t.label);
  }
  return { uploads, conflicts, newPins };
}

const toTarget = (h: PendingKeyHolder): SealTarget => ({
  holderType: h.holderType,
  holderId: h.holderId,
  publicKey: h.publicKey,
  label: h.label,
});

/* --------------------------------------------------------------- activation */

export interface ActivationEligibility {
  /** Holders that will receive the HMK (cameras + members with vaults + self). */
  eligible: PendingKeyHolder[];
  /** Camera ids with no registered pubkey yet — block activation ("waiting for camera app updates"). */
  offendingCameraIds: string[];
}

/**
 * Precheck activation eligibility: every camera in the Home must have a pubkey.
 * `allCameraIds` comes from the caller's listCameras(); pending carries the
 * pubkeys the server would seal to (the server 409s as the backstop).
 */
export async function checkActivationEligibility(
  homeId: string,
  allCameraIds: string[],
): Promise<ActivationEligibility> {
  const { pending } = await getPendingKeyHolders(homeId);
  const cameraHoldersWithKeys = new Set(
    pending.filter((h) => h.holderType === "camera").map((h) => h.holderId),
  );
  const offendingCameraIds = allCameraIds.filter((id) => !cameraHoldersWithKeys.has(id));
  return { eligible: pending, offendingCameraIds };
}

/**
 * Explicit owner activation (epoch 0→1). Generates a random HMK, seals to every
 * eligible holder (which includes the owner's own user copy from pending), and
 * POSTs /key/init. Returns the new epoch + the HMK base64 to cache + setKey.
 */
export async function activateHome(
  homeId: string,
  eligible: PendingKeyHolder[],
): Promise<{ epoch: number; hmkBase64: string; conflicts: PinConflict[]; newPins: string[] }> {
  const hmk = await generateHmk();
  const { uploads, conflicts, newPins } = await sealTo(homeId, hmk.base64, eligible.map(toTarget));
  const res: HomeKeyEpochResponse = await initHomeKey(homeId, { keys: uploads });
  return { epoch: res.keyEpoch, hmkBase64: hmk.base64, conflicts, newPins };
}

/* --------------------------------------------------------------- reconcile */

/**
 * Backfill sweep (any current holder, post-connect, off the join path). Seals to
 * holders that already had access at a previous epoch (firstContact === false).
 * firstContact holders are left for explicit owner grants.
 */
export async function reconcileBackfill(homeId: string, hmkBase64: string, epoch: number): Promise<SealResult> {
  const { pending } = await getPendingKeyHolders(homeId);
  const targets = pending.filter((h) => !h.firstContact).map(toTarget);
  if (targets.length === 0) return { sealed: 0, conflicts: [], newPins: [] };
  const { uploads, conflicts, newPins } = await sealTo(homeId, hmkBase64, targets);
  if (uploads.length > 0) await submitSealedKeys(homeId, { epoch, keys: uploads });
  return { sealed: uploads.length, conflicts, newPins };
}

/**
 * Explicit owner grant to specific holders (first-contact users/cameras/recorder).
 * `allowRepin` is the re-grant-after-pin-change path.
 */
export async function grantHolders(
  homeId: string,
  hmkBase64: string,
  epoch: number,
  holders: PendingKeyHolder[],
  allowRepin = false,
): Promise<SealResult> {
  const { uploads, conflicts, newPins } = await sealTo(homeId, hmkBase64, holders.map(toTarget), allowRepin);
  if (uploads.length > 0) await submitSealedKeys(homeId, { epoch, keys: uploads });
  return { sealed: uploads.length, conflicts, newPins };
}

/**
 * Owner repair for a poisoned/undecryptable sealed copy (review 2026-07-03 #1):
 * drop the holder's current-epoch row, then re-seal the current HMK to them via
 * the owner-grant path (TOFU pins intact — a changed pin surfaces as a conflict,
 * NOT a silent re-seal). sealed === 0 with no conflicts ⇒ the holder no longer
 * has a sealable pubkey (e.g. vault-less member / pre-E2EE camera). The submit
 * uses the epoch from the post-delete pending refetch, so a concurrent rotate
 * can't make us re-seal at a stale epoch (the server 409s as the backstop).
 */
export async function reissueKey(
  homeId: string,
  hmkBase64: string,
  holderType: KeyHolderType,
  holderId: string,
): Promise<SealResult> {
  await deleteHolderKey(homeId, holderType, holderId);
  const { epoch, pending } = await getPendingKeyHolders(homeId);
  const target = pending.find((h) => h.holderType === holderType && h.holderId === holderId);
  if (!target) return { sealed: 0, conflicts: [], newPins: [] };
  return grantHolders(homeId, hmkBase64, epoch, [target]);
}

/* ----------------------------------------------------------------- rotation */

/**
 * Enumerate the holder pubkeys known BEFORE the epoch bumps: members from
 * listHomeMembers (reliable pubkeys) plus whatever /key/pending surfaces.
 * Holders that HOLD a current-epoch key (cameras, the consented recorder) are
 * by definition absent from pending here — rotateHome covers them with an
 * immediate post-rotate backfill at the new epoch, where they reappear as
 * non-firstContact pending holders.
 */
async function enumerateHolders(homeId: string): Promise<SealTarget[]> {
  const [members, pendingResp] = await Promise.all([
    listHomeMembers(homeId),
    getPendingKeyHolders(homeId),
  ]);
  const byKey = new Map<string, SealTarget>();
  const add = (t: SealTarget) => byKey.set(`${t.holderType}:${t.holderId}`, t);

  for (const m of members) {
    if (m.publicKey) {
      add({ holderType: "user", holderId: m.userId, publicKey: m.publicKey, label: m.identifier });
    }
  }
  for (const h of pendingResp.pending) {
    if (h.holderType !== "user") add(toTarget(h));
    else if (!byKey.has(`user:${h.holderId}`)) add(toTarget(h));
  }
  return [...byKey.values()];
}

/**
 * Rotate the HMK: fresh key sealed to all remaining holders (§6), POST
 * /key/rotate {fromEpoch}, then an immediate backfill at the new epoch. Handles
 * a 409 (concurrent rotate) by refetch+retry-once. Returns the new epoch + HMK
 * base64; the caller broadcasts rekey + re-setKeys locally.
 */
export async function rotateHome(
  homeId: string,
  fromEpoch: number,
): Promise<{ epoch: number; hmkBase64: string; conflicts: PinConflict[]; newPins: string[] }> {
  const hmk = await generateHmk();
  const targets = await enumerateHolders(homeId);
  const { uploads, conflicts, newPins } = await sealTo(homeId, hmk.base64, targets);

  // Cameras and the consented recorder held a current-epoch key, so they were
  // NOT pending pre-rotate and the uploads above cannot include them. Once the
  // epoch advances they surface as non-firstContact pending holders — backfill
  // them right away so a rotation never strands a device beyond the accepted
  // sub-second blip (§6 "seals HMK′ to all remaining holders").
  const finish = async (epoch: number) => {
    const backfill = await reconcileBackfill(homeId, hmk.base64, epoch);
    return {
      epoch,
      hmkBase64: hmk.base64,
      conflicts: [...conflicts, ...backfill.conflicts],
      newPins: [...newPins, ...backfill.newPins],
    };
  };

  try {
    const res = await rotateHomeKey(homeId, { fromEpoch, keys: uploads });
    return await finish(res.keyEpoch);
  } catch (err) {
    if (isConflict(err)) {
      // Someone else rotated first — re-read the epoch and retry once.
      const { epoch } = await getPendingKeyHolders(homeId);
      const retry = await rotateHomeKey(homeId, { fromEpoch: epoch, keys: uploads });
      return await finish(retry.keyEpoch);
    }
    throw err;
  }
}

/* ------------------------------------------------------------- recorder consent */

/** Enable recorder consent: seal the CURRENT HMK to the recorder pubkey + POST. */
export async function enableRecorderConsent(
  homeId: string,
  hmkBase64: string,
  recorderPublicKeyB64: string,
): Promise<RecorderConsentResponse> {
  const sealedKey = await sealHmkBase64To(hmkBase64, recorderPublicKeyB64);
  return setRecorderConsent(homeId, { enabled: true, sealedKey });
}

/**
 * Disable recorder consent, THEN rotate (the server deleted the recorder rows;
 * §6 revoke forces a rotate driven by the client). Returns the new epoch + HMK
 * so the caller can re-setKey + broadcast rekey.
 */
export async function disableRecorderConsentAndRotate(
  homeId: string,
): Promise<{ epoch: number; hmkBase64: string; conflicts: PinConflict[]; newPins: string[] }> {
  const consent = await setRecorderConsent(homeId, { enabled: false });
  return rotateHome(homeId, consent.keyEpoch);
}

/** Convenience: fetch the recorder identity for the consent UI. */
export async function fetchRecorderIdentity(): Promise<string | null> {
  const { publicKey } = await getRecorderIdentity();
  return publicKey;
}

/* ------------------------------------------------------------------- helpers */

function isConflict(err: unknown): boolean {
  return typeof err === "object" && err !== null && "status" in err && (err as { status: number }).status === 409;
}
