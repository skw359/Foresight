/**
 * Foresight Security backend entrypoint. Boots the Fastify app and listens on
 * all interfaces (0.0.0.0) so iPhones and browsers on the LAN can reach it.
 */
import os from "node:os";
import { buildApp } from "./app.js";
import { config } from "./config.js";
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
  ];

  process.stdout.write(banner({ subtitle: "server", rows }) + "\n\n");
}

const app = buildApp({ logger: true });

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then(() => announceBoot(app))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
