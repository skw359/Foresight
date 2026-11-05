/**
 * Server-wide settings. Readable by any signed-in user; ONLY THE SERVER ADMIN
 * may change them, because they affect every Home on the server.
 *  - GET /settings  → current values + the URL auto-detected from this request.
 *  - PUT /settings  → update settings (pairing server URL, registration).
 *
 * Why admin-only matters: the pairing URL goes into every QR code, and a camera
 * trusts that URL permanently. If any account could change it, one
 * self-registered user could point every newly paired camera — in every Home —
 * at their own server and harvest its credentials and video.
 *
 * The pairing server URL is the base address embedded into QR pairing tickets;
 * leaving it blank falls back to auto-detecting the address the dashboard used.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ServerSettings } from "@foresight/contract";
import { requireServerAdmin, requireUser } from "../auth.js";
import { audit, userActor } from "../lib/audit.js";
import { parseBody } from "../lib/validate.js";
import {
  PAIRING_SERVER_URL_KEY,
  REGISTRATION_OPEN_KEY,
  detectServerUrl,
  getSetting,
  registrationLocked,
  registrationOpen,
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
    .union([z.string().max(2048), z.null()])
    .transform((v) => (v === null ? null : v.trim()))
    .refine((v) => v === null || v === "" || isHttpUrl(v), {
      message: "must be a valid http(s) URL, e.g. http://192.168.1.20:3199",
    })
    .optional(),
  registrationOpen: z.boolean().optional(),
});

async function currentSettings(req: FastifyRequest): Promise<ServerSettings> {
  return {
    pairingServerUrl: await getSetting(PAIRING_SERVER_URL_KEY),
    detectedServerUrl: detectServerUrl(req),
    registrationOpen: await registrationOpen(),
    registrationLocked: registrationLocked(),
    editable: req.user?.isAdmin === true,
  };
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/settings", { preHandler: requireUser }, async (req): Promise<ServerSettings> => {
    return currentSettings(req);
  });

  app.put(
    "/settings",
    { preHandler: [requireUser, requireServerAdmin] },
    async (req): Promise<ServerSettings> => {
      const body = parseBody(updateSettings, req.body);
      const changed: Record<string, unknown> = {};
      if (body.pairingServerUrl !== undefined) {
        await setSetting(PAIRING_SERVER_URL_KEY, body.pairingServerUrl);
        changed.pairingServerUrl = body.pairingServerUrl || null;
      }
      if (body.registrationOpen !== undefined && !registrationLocked()) {
        await setSetting(REGISTRATION_OPEN_KEY, body.registrationOpen ? "true" : null);
        changed.registrationOpen = body.registrationOpen;
      }
      if (Object.keys(changed).length > 0) {
        await audit(
          { homeId: null, actor: userActor(req.user!), action: "settings.updated", details: changed },
          req.log,
        );
      }
      return currentSettings(req);
    },
  );
}
