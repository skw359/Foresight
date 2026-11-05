/**
 * High-level E2EE key-lifecycle operations (shared/E2EE.md §6).
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
  getKeyHolders,
  getPendingKeyHolders,
  getRecorderIdentity,
  initHomeKey,
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
 * Every holder the new epoch must be sealed to, fetched BEFORE the epoch bumps:
 * members and cameras with pubkeys, plus the recorder while its consent is in
 * force (GET /key/holders, owner only). Sealing to all of them in the rotate
 * request itself matters: the server broadcasts `rekey` the moment the
 * rotation commits, so a camera whose copy was only backfilled afterwards
 * would re-fetch too early and keep encrypting with the old key — and a
 * recorder without its copy would stop recording.
 */
async function enumerateHolders(homeId: string): Promise<SealTarget[]> {
  const { pending } = await getKeyHolders(homeId);
  return pending.map(toTarget);
}

/**
 * Rotate the HMK: fresh key sealed to ALL remaining holders (§6) in one POST
 * /key/rotate {fromEpoch}, then a backfill sweep at the new epoch as a safety
 * net (a holder that appeared concurrently). A 409 stale_epoch (concurrent
 * rotate) is retried once against the fresh epoch and holder list. Returns
 * the new epoch + HMK base64; the caller re-setKeys locally (the server has
 * already told the room).
 */
export async function rotateHome(
  homeId: string,
  fromEpoch: number,
): Promise<{ epoch: number; hmkBase64: string; conflicts: PinConflict[]; newPins: string[] }> {
  const hmk = await generateHmk();

  const attempt = async (epoch: number) => {
    const targets = await enumerateHolders(homeId);
    const sealed = await sealTo(homeId, hmk.base64, targets);
    const res = await rotateHomeKey(homeId, { fromEpoch: epoch, keys: sealed.uploads });
    return { res, sealed };
  };

  let result;
  try {
    result = await attempt(fromEpoch);
  } catch (err) {
    if (!isConflict(err) || conflictReason(err) !== "stale_epoch") throw err;
    // Someone else rotated first — re-read the epoch and retry once.
    const fresh = (err as { details?: { keyEpoch?: number } }).details?.keyEpoch;
    const epoch = typeof fresh === "number" ? fresh : (await getPendingKeyHolders(homeId)).epoch;
    result = await attempt(epoch);
  }

  const epoch = result.res.keyEpoch;
  const backfill = await reconcileBackfill(homeId, hmk.base64, epoch).catch(
    (): SealResult => ({ sealed: 0, conflicts: [], newPins: [] }),
  );
  return {
    epoch,
    hmkBase64: hmk.base64,
    conflicts: [...result.sealed.conflicts, ...backfill.conflicts],
    newPins: [...result.sealed.newPins, ...backfill.newPins],
  };
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

function conflictReason(err: unknown): string | undefined {
  return (err as { details?: { reason?: string } }).details?.reason;
}
