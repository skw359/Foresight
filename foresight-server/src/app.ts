/**
 * Build the Fastify applications (separated from index.ts so tests can import
 * and inject them without binding a port).
 *
 *  - buildApp(): the PUBLIC app — CORS, security headers, error handling, a raw
 *    body parser for LiveKit webhooks, every public route group, and (when a
 *    production web build exists) the dashboard on the same origin.
 *  - buildInternalApp(): the server↔recorder API, served on its own listener
 *    bound to 127.0.0.1 only (see index.ts). It is NOT reachable through the
 *    public port, the LAN, or a reverse proxy in front of the public port.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { Prisma } from "@prisma/client";
import { config } from "./config.js";
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

/** Machine-readable codes for the 4xx errors Fastify itself raises. */
function clientErrorCode(status: number): string {
  switch (status) {
    case 404:
      return "not_found";
    case 405:
      return "method_not_allowed";
    case 406:
      return "not_acceptable";
    case 413:
      return "payload_too_large";
    case 415:
      return "unsupported_media_type";
    case 429:
      return "rate_limited";
    default:
      return "bad_request";
  }
}

/** Shared error handler: HttpErrors → ApiError, framework 4xx passed through, unique violations → 409. */
function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _req, reply) => {
    // A route may already have set a media type / attachment for a stream
    // that then failed before any bytes went out (e.g. a clip export whose
    // ffmpeg can't start). The error body is JSON, and must not be saved as
    // "clip.mp4".
    reply.removeHeader("content-disposition");
    // Streams get their headers copied onto the raw response (setHeader)
    // before piping; drop it there too while nothing has been sent.
    if (!reply.raw.headersSent) reply.raw.removeHeader("content-disposition");
    reply.type("application/json; charset=utf-8");
    if (err instanceof HttpError) {
      if (err.statusCode === 429) {
        const wait = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
        if (wait) reply.header("Retry-After", String(wait));
      }
      return reply.code(err.statusCode).send(err.toBody());
    }
    // A race the route didn't anticipate (two concurrent creates of the same
    // unique value) is a conflict, not a server fault.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return reply.code(409).send({ error: "conflict", message: "That already exists" });
    }
    // Fastify's own client errors (malformed JSON, body too large, wrong
    // content type, …) keep their status instead of becoming a 500.
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return reply.code(status).send({ error: clientErrorCode(status), message: (err as Error).message });
    }
    reply.log.error(err);
    return reply.code(500).send({ error: "internal_error", message: "Something went wrong" });
  });
}

/** True for http(s)://localhost / 127.0.0.1 / [::1] on any port — local dev servers (Vite). */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

/**
 * CORS allow-list. The dashboard is normally served from this same origin (no
 * CORS involved). Cross-origin calls are allowed only from CORS_ORIGINS, from
 * loopback dev servers, and from pages whose host matches the API's own host
 * (a dev Vite server on the same LAN address). CORS_ORIGINS=* allows any.
 */
export function corsOriginAllowed(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin) return true; // same-origin navigations, curl, native apps
  const normalized = origin.replace(/\/$/, "");
  if (config.corsOrigins.includes("*") || config.corsOrigins.includes(normalized)) return true;
  if (isLoopbackOrigin(normalized)) return true;
  try {
    const host = hostHeader?.split(":")[0];
    return !!host && new URL(normalized).hostname === host;
  } catch {
    return false;
  }
}

/** The LiveKit endpoints the dashboard must be allowed to connect to (CSP connect-src). */
function liveKitConnectSources(): string[] {
  const out = new Set<string>();
  for (const raw of [config.livekitPublicUrl, config.livekitUrl]) {
    try {
      const u = new URL(raw);
      const wsProto = u.protocol === "wss:" || u.protocol === "https:" ? "wss:" : "ws:";
      const httpProto = wsProto === "wss:" ? "https:" : "http:";
      out.add(`${wsProto}//${u.host}`);
      // livekit-client probes /rtc/validate over http(s) after a failed connect.
      out.add(`${httpProto}//${u.host}`);
      // LiveKit Cloud: region discovery on the project's other hosts.
      if (u.hostname.endsWith(".livekit.cloud")) {
        out.add("wss://*.livekit.cloud");
        out.add("https://*.livekit.cloud");
      }
    } catch {
      /* unparseable — config validation reports it elsewhere */
    }
  }
  return [...out];
}

/**
 * Content-Security-Policy for the dashboard. The JWT lives in localStorage, so
 * an injected script would own the session: no inline scripts, no third-party
 * script hosts. 'wasm-unsafe-eval' is libsodium's WebAssembly; blob: covers
 * hls.js's worker + MediaSource and snapshot downloads; inline STYLE is needed
 * for React style props only.
 */
function dashboardCsp(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    "font-src 'self'",
    "worker-src 'self' blob:",
    `connect-src 'self' ${liveKitConnectSources().join(" ")}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

export function buildApp(opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ? fastifyLogger() : false,
    // Behind a reverse proxy, req.ip must be the real client (rate-limit key).
    trustProxy: config.trustProxy,
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
  // it is served from this same origin. Only allow-listed origins are reflected.
  app.register(cors, {
    delegator: (req, cb) => {
      cb(null, { origin: corsOriginAllowed(req.headers.origin, req.headers.host) });
    },
  });

  // Baseline security headers on every response; the CSP applies to the
  // dashboard's HTML (API JSON responses can't execute anything).
  const csp = dashboardCsp();
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()");
    const type = String(reply.getHeader("content-type") ?? "");
    if (type.startsWith("text/html")) reply.header("Content-Security-Policy", csp);
    return payload;
  });

  // LiveKit webhooks arrive as application/webhook+json; keep the raw string so
  // the signature (computed over the raw body) verifies.
  app.addContentTypeParser(
    "application/webhook+json",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );

  // Translate thrown HttpErrors (and anything else) into the ApiError shape.
  installErrorHandler(app);

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

/**
 * The server↔recorder internal API. index.ts binds it to 127.0.0.1 on
 * INTERNAL_PORT; it is never registered on the public app.
 */
export function buildInternalApp(opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ? fastifyLogger() : false,
    disableRequestLogging: true,
  });
  installErrorHandler(app);
  app.get("/health", async () => ({ ok: true }));
  app.register(internalRoutes);
  return app;
}
