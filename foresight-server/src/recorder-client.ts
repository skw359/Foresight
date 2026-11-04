/**
 * Tiny client for the foresight-recorder's loopback control API.
 *
 * The webhook (camera join/leave) and the recording toggle call arm/disarm here.
 * Every call is FIRE-AND-FORGET and NEVER throws: a recorder that is down must
 * not make the webhook return non-200 (LiveKit would retry and camera state
 * would lag) or fail the toggle. The recorder's own LiveKit events + boot/
 * periodic reconcile close any gap a dropped call leaves.
 *
 * When RECORDER_SHARED_SECRET is unset the calls are disabled entirely, so the
 * server boots cleanly in tests and recorder-less deployments.
 */
import { config } from "./config.js";

/** Minimal logger shape (Fastify's req.log satisfies this). */
export interface RecorderLogger {
  warn: (obj: unknown, msg?: string) => void;
  debug?: (obj: unknown, msg?: string) => void;
}

/** Whether server→recorder control calls are configured. */
export function recorderEnabled(): boolean {
  return config.recorderSharedSecret !== null;
}

async function call(path: string, body: unknown, log?: RecorderLogger): Promise<boolean> {
  if (!config.recorderSharedSecret) return false; // disabled — see module docs
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`${config.recorderUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-recorder-secret": config.recorderSharedSecret,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      log?.warn({ path, status: res.status }, "recorder control call non-2xx");
      return false;
    }
    log?.debug?.({ path, body }, "recorder control call ok");
    return true;
  } catch (err) {
    // Recorder down / unreachable — expected and tolerated.
    log?.warn({ path, err: String(err) }, "recorder control call failed");
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the recorder to start capturing a camera (no-op if already armed). */
export function armRecording(
  homeId: string,
  cameraId: string,
  log?: RecorderLogger,
): Promise<boolean> {
  return call("/control/arm", { homeId, cameraId }, log);
}

/** Ask the recorder to stop capturing a camera (no-op if not armed). */
export function disarmRecording(
  homeId: string,
  cameraId: string,
  log?: RecorderLogger,
): Promise<boolean> {
  return call("/control/disarm", { homeId, cameraId }, log);
}

/**
 * Tell the recorder a Home's consent was revoked so it can finalize + stop
 * immediately instead of waiting for the next reconcile. Fire-and-forget: the
 * reconcile's `revoked` flag is the source of truth if this push is missed.
 */
export function revokeRecorder(homeId: string, log?: RecorderLogger): Promise<boolean> {
  return call("/control/revoke", { homeId }, log);
}

/**
 * Nudge the recorder to re-fetch its sealed key after a rotation (new epoch).
 * Fire-and-forget; the recorder's reconcile carries the new sealed key anyway.
 */
export function rekeyRecorder(homeId: string, epoch: number, log?: RecorderLogger): Promise<boolean> {
  return call("/control/rekey", { homeId, epoch }, log);
}
