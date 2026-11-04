/**
 * Build the Fastify application (separated from index.ts so tests can import
 * and inject it without binding a port). Registers CORS, error handling, a raw
 * body parser for LiveKit webhooks, all route groups, and — when a production
 * web build exists — serves the dashboard so the whole app runs from one origin.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { HttpError } from "./lib/errors.js";
import { fastifyLogger } from "./logging.js";
import { authRoutes } from "./routes/auth.js";
import { accountRoutes } from "./routes/account.js";
import { homeRoutes } from "./routes/homes.js";
import { cameraRoutes } from "./routes/cameras.js";
import { pairingRoutes } from "./routes/pairing.js";
import { rtRoutes } from "./routes/rt.js";
import { keyRoutes } from "./routes/keys.js";
import { settingsRoutes } from "./routes/settings.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { recordingRoutes } from "./routes/recordings.js";
import { internalRoutes } from "./routes/internal.js";

/**
 * Locate the built web dashboard (Foresight-web-client/dist) by walking up from
 * this file. Returns null when the web client has not been built, in which case
 * the backend runs API-only (dev, where Vite serves the UI on its own port).
 */
function findWebDist(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "Foresight-web-client", "dist");
    if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function buildApp(opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ? fastifyLogger() : false,
    // Fastify's stock request logging emits two records per request ("incoming
    // request" then "request completed") and neither carries method+url+status
    // together. The onResponse hook below replaces both with one record that
    // does — same information, one line, and the console theme can align it
    // into a proper HTTP column.
    disableRequestLogging: true,
  });

  // One log record per completed request. /health is polled by the recorder and
  // by uptime checks, so it drops to debug and stays out of the way.
  app.addHook("onResponse", (req, reply, done) => {
    const status = reply.statusCode;
    const record = {
      http: { method: req.method, url: req.url, status, ms: reply.elapsedTime },
    };
    // Written out rather than indexed by a computed level so the overloaded
    // pino signatures still resolve.
    if (status >= 500) req.log.error(record, "request");
    else if (status >= 400) req.log.warn(record, "request");
    else if (req.url === "/health") req.log.debug(record, "request");
    else req.log.info(record, "request");
    done();
  });

  // Browser dashboard runs on a different origin in dev (Vite on :5173); in prod
  // it is served from this same origin. Reflecting the origin covers both.
  app.register(cors, { origin: true });

  // LiveKit webhooks arrive as application/webhook+json; keep the raw string so
  // the signature (computed over the raw body) verifies.
  app.addContentTypeParser(
    "application/webhook+json",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );

  // Translate thrown HttpErrors (and anything else) into the ApiError shape.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send(err.toBody());
    }
    if ((err as { statusCode?: number }).statusCode === 400) {
      return reply.code(400).send({ error: "bad_request", message: (err as Error).message });
    }
    reply.log.error(err);
    return reply.code(500).send({ error: "internal_error", message: "Something went wrong" });
  });

  app.get("/health", async () => ({ ok: true }));

  app.register(authRoutes);
  app.register(accountRoutes);
  app.register(homeRoutes);
  app.register(cameraRoutes);
  app.register(pairingRoutes);
  app.register(rtRoutes);
  app.register(keyRoutes);
  app.register(settingsRoutes);
  app.register(webhookRoutes);
  app.register(recordingRoutes);
  app.register(internalRoutes);

  // In production, serve the compiled web dashboard from this same origin so the
  // whole app runs on one port. Any unknown non-API GET falls back to the SPA
  // shell (index.html) so client-side routing works on deep links and refresh.
  const webDist = findWebDist(path.dirname(fileURLToPath(import.meta.url)));
  if (webDist) {
    app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      // Client routes (e.g. /homes/:id) share the SAME path namespace as the API
      // (/homes), so the path alone can't tell a page reload from an API call.
      // The request *intent* can: a top-level browser navigation (typing a URL,
      // refresh, deep link) sends `Sec-Fetch-Mode: navigate` and `Accept:
      // text/html`; the dashboard's own fetch() calls send neither. Serve the SPA
      // shell only for GET navigations so client-side routing survives a refresh;
      // everything else (unknown API calls, missing assets) gets a JSON 404.
      const accept = req.headers.accept ?? "";
      const isNavigation =
        req.headers["sec-fetch-mode"] === "navigate" || accept.includes("text/html");
      if (req.method === "GET" && isNavigation) {
        return reply.sendFile("index.html");
      }
      return reply
        .code(404)
        .send({ error: "not_found", message: `Cannot ${req.method} ${req.url}` });
    });
    app.log.info(`Serving web dashboard from ${webDist}`);
  }

  return app;
}
