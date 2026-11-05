/**
 * Foresight Security backend entrypoint. Boots the public Fastify app on all
 * interfaces (0.0.0.0) so iPhones and browsers on the LAN can reach it, and the
 * internal server↔recorder API on 127.0.0.1 only.
 */
import os from "node:os";
import { buildApp, buildInternalApp } from "./app.js";
import { config, insecureWarnings } from "./config.js";
import { prisma } from "./db.js";
import { banner } from "./console.js";
import { isPretty } from "./logging.js";

/**
 * First non-internal IPv4 address. The server binds 0.0.0.0, but "localhost" is
 * useless to a phone scanning a QR code — surfacing the LAN address on boot
 * saves an `ipconfig` every time.
 */
function lanAddress(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return null;
}

/**
 * Announce the boot configuration: the boxed coral banner on a terminal, the
 * original pair of structured lines when logs are piped somewhere.
 */
function announceBoot(app: ReturnType<typeof buildApp>): void {
  if (!isPretty) {
    const where = config.publicServerUrl ?? `http://localhost:${config.port}`;
    app.log.info(`Foresight backend listening on ${where} (port ${config.port})`);
    app.log.info(`LiveKit: ${config.livekitUrl} (advertised to devices: ${config.livekitPublicUrl})`);
    return;
  }

  const lan = lanAddress();
  const rows = [
    { label: "local", value: `http://localhost:${config.port}` },
    ...(lan ? [{ label: "lan", value: `http://${lan}:${config.port}` }] : []),
    ...(config.publicServerUrl ? [{ label: "public", value: config.publicServerUrl }] : []),
    { label: "livekit", value: config.livekitUrl },
    { label: "advertised", value: config.livekitPublicUrl },
    { label: "database", value: config.sqlitePath },
    { label: "recordings", value: config.recordingsDir },
    {
      label: "recorder",
      value: config.recorderSharedSecret ? config.recorderUrl : "disabled (no shared secret)",
    },
    ...(config.recorderSharedSecret
      ? [{ label: "internal", value: `http://127.0.0.1:${config.internalPort} (loopback only)` }]
      : []),
  ];

  process.stdout.write(banner({ subtitle: "server", rows }) + "\n\n");
}

/**
 * SQLite tuning for a long-running server: WAL lets readers (playlist/coverage
 * requests) proceed while a write commits, and survives a crash mid-write
 * better than the rollback journal. busy_timeout rides out brief contention
 * (e.g. a backup) instead of failing the request.
 */
async function tuneSqlite(app: ReturnType<typeof buildApp>): Promise<void> {
  try {
    await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
    await prisma.$queryRawUnsafe("PRAGMA busy_timeout=5000");
  } catch (err) {
    app.log.warn({ err: String(err) }, "could not enable SQLite WAL mode");
  }
}

const app = buildApp({ logger: true });

for (const warning of insecureWarnings) {
  app.log.warn(`INSECURE (FORESIGHT_INSECURE_DEV=1): ${warning}`);
}

async function main(): Promise<void> {
  await tuneSqlite(app);
  await app.listen({ port: config.port, host: "0.0.0.0" });
  announceBoot(app);

  // The recorder's reconcile API: loopback only, and only when a shared secret
  // is configured (otherwise server↔recorder calls are disabled anyway).
  if (config.recorderSharedSecret) {
    const internal = buildInternalApp({ logger: true });
    await internal.listen({ port: config.internalPort, host: "127.0.0.1" });
    app.log.info(`internal recorder API listening on http://127.0.0.1:${config.internalPort}`);
  }
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
