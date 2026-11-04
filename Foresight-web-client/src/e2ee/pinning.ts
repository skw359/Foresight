/**
 * TOFU (trust-on-first-use) pubkey pinning — the v1 mitigation for key-directory
 * trust (E2EE_MODEL_B_PLAN.md §10.5).
 *
 * A sealing client pins each holder's pubkey the first time it seals to it. If a
 * later reconcile/grant sees a DIFFERENT key for the same holder, we HARD-REFUSE
 * to seal and surface a prominent security alert; the owner clears the pin only
 * through an explicit "re-grant access" action. Pins are per (homeId, holderType,
 * holderId), stored in localStorage on this device.
 */
import type { KeyHolderType } from "@foresight/contract";

const PREFIX = "foresight.e2ee.pin";

function pinStorageKey(homeId: string, holderType: KeyHolderType, holderId: string): string {
  return `${PREFIX}:${homeId}:${holderType}:${holderId}`;
}

export type PinState = "new" | "match" | "changed";

/** Compare a holder's presented pubkey against the local pin. */
export function checkPin(
  homeId: string,
  holderType: KeyHolderType,
  holderId: string,
  publicKeyB64: string,
): PinState {
  let existing: string | null = null;
  try {
    existing = localStorage.getItem(pinStorageKey(homeId, holderType, holderId));
  } catch {
    return "new";
  }
  if (existing === null) return "new";
  return existing === publicKeyB64 ? "match" : "changed";
}

/** Pin a holder's pubkey (first sight, or after an explicit owner re-grant). */
export function savePin(
  homeId: string,
  holderType: KeyHolderType,
  holderId: string,
  publicKeyB64: string,
): void {
  try {
    localStorage.setItem(pinStorageKey(homeId, holderType, holderId), publicKeyB64);
  } catch {
    /* storage unavailable — pinning degrades to no-op on this device */
  }
}

/** Drop a pin so the next seal re-pins the current key (explicit re-grant path). */
export function clearPin(homeId: string, holderType: KeyHolderType, holderId: string): void {
  try {
    localStorage.removeItem(pinStorageKey(homeId, holderType, holderId));
  } catch {
    /* ignore */
  }
}
