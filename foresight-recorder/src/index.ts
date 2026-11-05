/**
 * foresight-recorder entrypoint. Loads config, loads/generates the E2EE identity
 * and registers its public key with the server, starts the loopback control API,
 * the retention pruner, and the reconcile loop, then runs an initial reconcile so
 * a fresh boot immediately re-arms whatever should be recording.
 */
import type { RegisterRecorderIdentityRequest } from "@foresight/contract";
import { config, insecureWarnings } from "./config.js";
import { probeFfmpeg } from "./media/ffmpeg.js";
import { health } from "./state/health.js";
import { log, isPretty } from "./log.js";
import { banner } from "./console.js";
import { RecorderIdentity } from "./crypto/identity.js";
import { KeyManager } from "./crypto/keyManager.js";
import { RoomManager } from "./livekit/roomManager.js";
import { startControlApi } from "./control/api.js";
import { startReconcileLoop, reconcileOnce } from "./state/reconcile.js";
import { startRetentionLoop } from "./storage/retention.js";
import { startConsolidationLoop } from "./storage/consolidate.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Register the recorder's public key with the server (POST
 * /internal/recorder-identity) before keys can flow. Retries with backoff
 * forever until it lands; a failure must NEVER crash the recorder (plan §8.2) —
 * until it succeeds, Homes simply cannot seal to us and their cameras hold in
 * awaiting_consent (zero CPU). Resolves on the first success.
 */
async function registerRecorderIdentity(publicKey: string): Promise<void> {
  const payload: RegisterRecorderIdentityRequest = { publicKey };
  const body = JSON.stringify(payload);
  let delay = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${config.serverUrl}/internal/recorder-identity`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-recorder-secret": config.sharedSecret },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        log.info("registered recorder identity", { publicKey, attempt });
        return;
      }
      log.warn("recorder-identity registration non-2xx — retrying", {
        status: res.status,
        attempt,
      });
    } catch (err) {
      log.warn("recorder-identity registration failed — retrying", {
        err: String(err),
        attempt,
      });
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 30_000);
  }
}

/**
 * Announce the boot configuration. On a terminal this is the boxed coral
 * banner; when logs are piped it stays a single structured line so nothing
 * downstream has to learn a new shape.
 */
function announceBoot(): void {
  if (!isPretty) {
    log.info("foresight-recorder starting", {
      port: config.port,
      recordingsDir: config.recordingsDir,
      encoder: config.encoder,
      recordAudio: config.recordAudio,
      retentionDays: config.retentionDays,
      frameStallSeconds: config.frameStallSeconds,
    });
    return;
  }
  process.stdout.write(
    banner({
      subtitle: "recorder",
      rows: [
        { label: "control", value: `http://127.0.0.1:${config.port}` },
        { label: "server", value: config.serverUrl },
        { label: "livekit", value: config.livekitUrl },
        { label: "recordings", value: config.recordingsDir },
        {
          label: "capture",
          value: `${config.encoder} \u00b7 ${config.segmentSeconds}s segments \u00b7 ${config.fps}fps \u00b7 audio ${config.recordAudio ? "on" : "off"}`,
        },
        {
          label: "retention",
          value: `${config.retentionDays}d \u00b7 max ${config.retentionMaxGb}GB \u00b7 keep ${config.minFreeGb}GB free`,
        },
      ],
    }) + "\n\n",
  );
}

/**
 * Fail LOUDLY at boot when ffmpeg is missing or lacks the configured encoder —
 * otherwise every encoder spawn fails and recording silently writes nothing.
 * The recorder keeps running (the control API and reconcile stay up, and a
 * fixed binary is picked up on the next spawn), but /status shows ffmpeg !ok.
 */
async function checkFfmpeg(): Promise<void> {
  health.ffmpeg.path = config.ffmpegPath;
  try {
    health.ffmpeg.detail = await probeFfmpeg(config.ffmpegPath, config.encoder);
    health.ffmpeg.ok = true;
    log.info("ffmpeg ok", { ffmpeg: config.ffmpegPath, version: health.ffmpeg.detail, encoder: config.encoder });
  } catch (err) {
    health.ffmpeg.ok = false;
    health.ffmpeg.detail = String(err);
    log.error("ffmpeg is NOT usable — nothing will be recorded until this is fixed", {
      ffmpeg: config.ffmpegPath,
      encoder: config.encoder,
      err: String(err),
      hint: "install ffmpeg or set FFMPEG_PATH / ENCODER in foresight-recorder/.env",
    });
  }
}

async function main(): Promise<void> {
  announceBoot();
  for (const warning of insecureWarnings) log.warn(`INSECURE (FORESIGHT_INSECURE_DEV=1): ${warning}`);
  await checkFfmpeg();

  const identity = RecorderIdentity.loadOrCreate(config.recorderKeyPath);
  const keyManager = new KeyManager(identity);
  const rm = new RoomManager(keyManager);

  const registered = registerRecorderIdentity(identity.publicKey);

  const refresh = (reason: string): void => {
    log.info("control-triggered refresh", { reason });
    void reconcileOnce(rm, keyManager).catch((err) =>
      log.warn("refresh reconcile failed", { reason, err: String(err) }),
    );
  };

  const api = await startControlApi(rm, refresh);
  const stopRetention = startRetentionLoop();
  const stopConsolidation = config.consolidateEnabled
    ? startConsolidationLoop()
    : (): void => undefined;
  const stopReconcile = startReconcileLoop(rm, keyManager);

  // Give registration a moment to land so the first reconcile can already carry
  // our sealed keys — but never block boot on it (it keeps retrying regardless).
  await Promise.race([registered, sleep(3000)]);

  void reconcileOnce(rm, keyManager).catch((err) =>
    log.warn("initial reconcile failed", { err: String(err) }),
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    stopReconcile();
    stopRetention();
    stopConsolidation();
    try {
      await api.close();
    } catch {
      /* ignore */
    }
    await rm.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal startup error", { err: String(err) });
  process.exit(1);
});
