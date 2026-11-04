/**
 * Server-wide settings, readable and editable by any signed-in user.
 *  - GET /settings  → current values + the URL auto-detected from this request.
 *  - PUT /settings  → update settings (currently the pairing server URL).
 *
 * The pairing server URL is the base address embedded into QR pairing tickets.
 * It must be reachable by the phones being paired — "localhost" only works on
 * this machine — which is why it is overridable from the dashboard. Leaving it
 * blank falls back to auto-detecting the address the dashboard used to reach us.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ServerSettings } from "@foresight/contract";
import { requireUser } from "../auth.js";
import { parseBody } from "../lib/validate.js";
import {
  PAIRING_SERVER_URL_KEY,
  detectServerUrl,
  getSetting,
  setSetting,
} from "../lib/settings.js";

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const updateSettings = z.object({
  // null or "" clears the override (back to auto-detect); otherwise must be a URL.
  pairingServerUrl: z
    .union([z.string(), z.null()])
    .transform((v) => (v === null ? null : v.trim()))
    .refine((v) => v === null || v === "" || isHttpUrl(v), {
      message: "must be a valid http(s) URL, e.g. http://192.168.1.20:3199",
    }),
});

async function currentSettings(req: FastifyRequest): Promise<ServerSettings> {
  return {
    pairingServerUrl: await getSetting(PAIRING_SERVER_URL_KEY),
    detectedServerUrl: detectServerUrl(req),
  };
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/settings", { preHandler: requireUser }, async (req): Promise<ServerSettings> => {
    return currentSettings(req);
  });

  app.put("/settings", { preHandler: requireUser }, async (req): Promise<ServerSettings> => {
    const { pairingServerUrl } = parseBody(updateSettings, req.body);
    await setSetting(PAIRING_SERVER_URL_KEY, pairingServerUrl);
    return currentSettings(req);
  });
}
