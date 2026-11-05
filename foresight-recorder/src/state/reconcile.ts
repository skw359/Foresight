/**
 * Reconcile loop — the backstop that makes 24/7 recording self-healing.
 *
 * The webhook is the going-forward trigger, but a dropped webhook, a recorder
 * restart, or a server restart can leave the recorder's armed set out of sync
 * with reality. On boot and every RECONCILE_INTERVAL_MS the recorder asks the
 * server "which cameras SHOULD be recording right now?" and arms anything it is
 * missing / disarms anything stale. A single dropped webhook therefore cannot
 * silently stop recording.
 *
 * The reconcile response also carries per-Home E2EE key state (RecorderReconcile
 * Response.homeKeys — shared/E2EE.md §8.2). It is the source of truth for
 * keys: the KeyManager unseals + caches it here, and any rotation / revocation /
 * consent-grant it detects is applied to the live rooms via RoomManager.syncHome.
 */
import type { RecorderReconcileResponse } from "@foresight/contract";
import { config } from "../config.js";
import { log } from "../log.js";
import type { RoomManager } from "../livekit/roomManager.js";
import type { KeyManager } from "../crypto/keyManager.js";

/** One reconcile pass: sync keys, then arm what should record / disarm what shouldn't. */
export async function reconcileOnce(rm: RoomManager, keyManager: KeyManager): Promise<void> {
  let body: RecorderReconcileResponse;
  try {
    const res = await fetch(`${config.serverUrl}/internal/recording-cameras`, {
      headers: { "x-recorder-secret": config.sharedSecret },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log.warn("reconcile: server returned non-2xx", {
        status: res.status,
        ...(res.status === 404
          ? { hint: "the server's internal API now listens on INTERNAL_PORT (default 3198): set SERVER_URL=http://127.0.0.1:3198" }
          : {}),
      });
      await rm.healthCheck();
      return;
    }
    body = (await res.json()) as RecorderReconcileResponse;
  } catch (err) {
    // Server down / unreachable — keep the current armed set, but still heal
    // dropped rooms (recording must not depend on the server being up).
    log.warn("reconcile: server unreachable", { err: String(err) });
    await rm.healthCheck();
    return;
  }

  // 1. Ingest key state FIRST so arm() below sees the right connect decision.
  const changes = keyManager.ingest(body.homeKeys ?? []);

  const desired = body.cameras ?? [];
  const desiredKeys = new Set(desired.map((c) => `${c.homeId}/${c.cameraId}`));
  const armed = rm.armedKeys();

  for (const c of desired) {
    if (!armed.has(`${c.homeId}/${c.cameraId}`)) {
      log.info("reconcile: arming missing camera", { homeId: c.homeId, cameraId: c.cameraId });
      await rm.arm(c.homeId, c.cameraId).catch((err) =>
        log.warn("reconcile: arm failed", { ...c, err: String(err) }),
      );
    }
  }

  for (const key of armed) {
    if (!desiredKeys.has(key)) {
      const [homeId, cameraId] = key.split("/");
      log.info("reconcile: disarming stale camera", { homeId, cameraId });
      await rm.disarm(homeId!, cameraId!).catch((err) =>
        log.warn("reconcile: disarm failed", { homeId, cameraId, err: String(err) }),
      );
    }
  }

  // 3. Apply key transitions (rotation / revocation / consent grant) to homes
  //    whose rooms are already up. Newly-armed homes were synced by arm() above;
  //    re-syncing them here is idempotent.
  for (const [homeId, change] of changes) {
    if (change === "unchanged") continue;
    log.info("reconcile: applying key change", { homeId, change });
    await rm.syncHome(homeId).catch((err) =>
      log.warn("reconcile: syncHome failed", { homeId, change, err: String(err) }),
    );
  }

  // 4. Health: an armed camera whose room dropped is NOT "missing" from the
  //    armed set, so step 2 wouldn't touch it. Reconnect any armed Home whose
  //    room is down — this is what makes the loop a real self-healing backstop.
  await rm.healthCheck();
}

/** Start the periodic reconcile loop; returns a stop() handle. */
export function startReconcileLoop(rm: RoomManager, keyManager: KeyManager): () => void {
  const timer = setInterval(() => {
    reconcileOnce(rm, keyManager).catch((err) =>
      log.error("reconcile loop error", { err: String(err) }),
    );
  }, config.reconcileIntervalMs);
  return () => clearInterval(timer);
}
