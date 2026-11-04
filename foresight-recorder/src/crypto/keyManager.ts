/**
 * Per-Home key state derived from the recorder reconcile response
 * (E2EE_MODEL_B_PLAN.md §8.2). Each reconcile carries, for every relevant Home,
 * a { epoch, sealedHmk | null, revoked } tuple (RecorderHomeKeyInfo). This
 * module unseals the sealed HMK with the recorder identity, caches the result,
 * and classifies each change so the RoomManager can drive connect / live
 * rotation / revocation.
 *
 * The cached value is the base64(HMK) STRING — never the raw 32 HMK bytes —
 * because the LiveKit key fed to rtc-node is the UTF-8 BYTES OF THAT STRING
 * (§3.2 locked contract, see liveKitSharedKey below).
 */
import type { RecorderHomeKeyInfo } from "@foresight/contract";
import type { RecorderIdentity } from "./identity.js";
import { log as rootLog } from "../log.js";

const log = rootLog.child({ mod: "keyManager" });

export interface HomeKeyState {
  /** Home.keyEpoch — server bookkeeping. 0 ⇒ E2EE not activated (plaintext). */
  epoch: number;
  /**
   * base64(HMK) STRING when the recorder holds a usable key for this Home, else
   * null (not activated, awaiting consent, revoked, or unseal failure).
   */
  hmkBase64: string | null;
  /** True when recorder consent was explicitly revoked for this Home. */
  revoked: boolean;
}

/**
 * How a Home's key state changed after ingesting a reconcile:
 *  - "granted"   : recorder went from keyless → holding a usable HMK
 *                  (first consent, or recovered from awaiting/revoked).
 *  - "rotated"   : recorder already held a key; a different HMK arrived
 *                  (membership/consent rotation) — apply live at index 0.
 *  - "revoked"   : consent was revoked — finalize + disconnect the Home.
 *  - "disabled"  : the owner turned E2EE off (epoch ≥ 1 → 0) — reconnect the
 *                  Home plaintext.
 *  - "unchanged" : no action needed (incl. steady-state plaintext/awaiting).
 */
export type HomeKeyChange = "granted" | "rotated" | "revoked" | "disabled" | "unchanged";

/**
 * THE LOCKED TRAP (plan §3.2 / §8.2): the shared key handed to @livekit/rtc-node
 * is the UTF-8 BYTES OF THE BASE64 STRING of the HMK, NOT the raw 32 HMK bytes.
 * Every other platform calls setKey(base64String); rtc-node's byte API forces us
 * to feed utf8Bytes(base64(HMK)) so all SDKs derive the same AES key (PBKDF2).
 */
export function liveKitSharedKey(hmkBase64: string): Buffer {
  return Buffer.from(hmkBase64, "utf8");
}

export class KeyManager {
  private readonly homes = new Map<string, HomeKeyState>();

  constructor(private readonly identity: RecorderIdentity) {}

  /** Current key state for a Home, or undefined if never seen in a reconcile. */
  getHomeKey(homeId: string): HomeKeyState | undefined {
    return this.homes.get(homeId);
  }

  /**
   * Consume the homeKeys array from a reconcile. Unseals present keys, updates
   * the cache, and returns the per-Home change classification. Idempotent: a
   * reconcile that repeats the same state yields "unchanged" everywhere.
   */
  ingest(homeKeys: RecorderHomeKeyInfo[]): Map<string, HomeKeyChange> {
    const changes = new Map<string, HomeKeyChange>();
    for (const info of homeKeys) {
      changes.set(info.homeId, this.ingestOne(info));
    }
    return changes;
  }

  /** Compact per-Home key summary for /status (no secret material). */
  summary(): Record<string, { epoch: number; keyed: boolean; revoked: boolean }> {
    const out: Record<string, { epoch: number; keyed: boolean; revoked: boolean }> = {};
    for (const [homeId, s] of this.homes) {
      out[homeId] = { epoch: s.epoch, keyed: s.hmkBase64 !== null, revoked: s.revoked };
    }
    return out;
  }

  private ingestOne(info: RecorderHomeKeyInfo): HomeKeyChange {
    const prev = this.homes.get(info.homeId);

    let hmkBase64: string | null = null;
    if (!info.revoked && info.sealedHmk) {
      try {
        hmkBase64 = this.identity.unseal(info.sealedHmk).toString("base64");
      } catch (err) {
        // Unseal must never crash the loop — hold the Home keyless (awaiting).
        log.error("failed to unseal HMK — holding keyless", {
          homeId: info.homeId,
          epoch: info.epoch,
          err: String(err),
        });
        hmkBase64 = null;
      }
    }

    const next: HomeKeyState = { epoch: info.epoch, hmkBase64, revoked: info.revoked };
    this.homes.set(info.homeId, next);

    if (info.revoked) {
      return prev?.revoked ? "unchanged" : "revoked";
    }
    if (info.epoch === 0 && prev !== undefined && prev.epoch >= 1) {
      return "disabled";
    }
    if (hmkBase64 === null) {
      // Not activated (epoch 0), or activated-but-awaiting-consent. Either way,
      // no key transition to apply — connect (plaintext) / hold is decided by
      // the RoomManager from the epoch.
      return "unchanged";
    }
    if (!prev || prev.hmkBase64 === null || prev.revoked) {
      return "granted";
    }
    if (prev.hmkBase64 !== hmkBase64 || prev.epoch !== next.epoch) {
      return "rotated";
    }
    return "unchanged";
  }
}
