/**
 * End-to-end API tests via Fastify `inject()` — no network, no running LiveKit
 * (the backend only MINTS tokens, it never opens a media socket). Runs against
 * an isolated temp SQLite DB built by replaying the init migration.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { segmentName } from "@foresight/contract";
import type { FastifyInstance } from "fastify";
import type { Db } from "../src/db.js";

const here = join(fileURLToPath(import.meta.url), "..");
const migrationsDir = join(here, "..", "prisma", "migrations");
const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => /^\d+_/.test(name))
  .sort();

// Point the app at an isolated DB + deterministic secrets BEFORE importing it.
const dbDir = mkdtempSync(join(tmpdir(), "foresight-test-"));
const dbPath = join(dbDir, "test.db");
process.env.DATABASE_URL = `file:${dbPath}`;
process.env.JWT_SECRET = "test-secret";
process.env.LIVEKIT_URL = "ws://localhost:7880";
// Pin the advertised URL so the pairing-ticket assertion is hermetic and does
// not pick up a developer .env's real LIVEKIT_PUBLIC_URL via dotenv.
process.env.LIVEKIT_PUBLIC_URL = "ws://localhost:7880";
process.env.LIVEKIT_API_KEY = "devkey";
process.env.LIVEKIT_API_SECRET = "secret";
process.env.PUBLIC_SERVER_URL = "http://localhost:3199";
// Isolated on-disk segment tree so the recordings delete test can write + prune
// real segment files without touching the dev recordings dir.
const recDir = mkdtempSync(join(tmpdir(), "foresight-rec-"));
process.env.RECORDINGS_DIR = recDir;

// Create + migrate the temp DB (replay every migration in order) so the
// adapter opens a ready schema.
{
  const db = new DatabaseSync(dbPath);
  for (const name of migrationFiles) {
    db.exec(readFileSync(join(migrationsDir, name, "migration.sql"), "utf8"));
  }
  db.close();
}

let app: FastifyInstance;
let prisma: Db;

beforeAll(async () => {
  prisma = (await import("../src/db.js")).prisma;
  const { buildApp } = await import("../src/app.js");
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  // Release the better-sqlite3 handle before deleting the DB, or Windows locks
  // the file (EBUSY on unlink).
  await prisma.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(recDir, { recursive: true, force: true });
});

const json = (res: { json: () => unknown }) => res.json();

// A valid base64 32-byte X25519 public key for /pair/claim (now required).
const CAMERA_PUBKEY = Buffer.alloc(32, 7).toString("base64");

describe("auth", () => {
  it("registers and logs in with a single identifier field", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { identifier: "alice@example.com", password: "anything" },
    });
    expect(reg.statusCode).toBe(201);
    const body = json(reg) as { token: string; user: { identifier: string } };
    expect(body.token).toBeTruthy();
    expect(body.user.identifier).toBe("alice@example.com");

    const dup = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { identifier: "alice@example.com", password: "x" },
    });
    expect(dup.statusCode).toBe(409);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { identifier: "alice@example.com", password: "anything" },
    });
    expect(login.statusCode).toBe(200);

    const bad = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { identifier: "alice@example.com", password: "wrong" },
    });
    expect(bad.statusCode).toBe(401);
  });
});

describe("full flow: home → pair → claim → rt token", () => {
  let token: string;
  let homeId: string;
  let cameraId: string;
  let deviceSecret: string;

  it("creates a home", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { identifier: "owner", password: "pw" },
    });
    token = (json(reg) as { token: string }).token;

    const home = await app.inject({
      method: "POST",
      url: "/homes",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "My House" },
    });
    expect(home.statusCode).toBe(201);
    const h = json(home) as { id: string; role: string };
    expect(h.role).toBe("owner");
    homeId = h.id;

    const list = await app.inject({
      method: "GET",
      url: "/homes",
      headers: { authorization: `Bearer ${token}` },
    });
    expect((json(list) as unknown[]).length).toBe(1);
  });

  it("pairs and claims a camera, then lists it", async () => {
    const pair = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/cameras/pair`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(pair.statusCode).toBe(201);
    const ticket = json(pair) as { token: string; livekitUrl: string; homeId: string };
    expect(ticket.homeId).toBe(homeId);
    expect(ticket.livekitUrl).toBe("ws://localhost:7880");

    const claim = await app.inject({
      method: "POST",
      url: "/pair/claim",
      payload: {
        token: ticket.token,
        name: "Front Door",
        cameraPublicKey: CAMERA_PUBKEY,
        capabilities: {
          lenses: [1],
          maxDigitalZoom: 4,
          torch: true,
          maxResolution: { width: 1920, height: 1080 },
          supportsAudio: true,
        },
      },
    });
    expect(claim.statusCode).toBe(201);
    const claimed = json(claim) as { camera: { id: string; name: string }; deviceSecret: string };
    expect(claimed.camera.name).toBe("Front Door");
    expect(claimed.deviceSecret).toHaveLength(64);

    // The same token cannot be reused.
    const reuse = await app.inject({
      method: "POST",
      url: "/pair/claim",
      payload: {
        token: ticket.token,
        name: "X",
        cameraPublicKey: CAMERA_PUBKEY,
        capabilities: { lenses: [1], maxDigitalZoom: 4, torch: true, maxResolution: { width: 1, height: 1 }, supportsAudio: true },
      },
    });
    expect(reuse.statusCode).toBe(400);

    const cams = await app.inject({
      method: "GET",
      url: `/homes/${homeId}/cameras`,
      headers: { authorization: `Bearer ${token}` },
    });
    const list = json(cams) as Array<{ id: string; capabilities: { torch: boolean } }>;
    expect(list).toHaveLength(1);
    expect(list[0].capabilities.torch).toBe(true);

    // Stash for the rt-token + rename/delete tests.
    cameraId = list[0].id;
    deviceSecret = claimed.deviceSecret;
  });

  it("mints a viewer token with correct grants, identity and metadata", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/rt/token",
      headers: { authorization: `Bearer ${token}` },
      payload: { homeId, role: "viewer" },
    });
    expect(res.statusCode).toBe(200);
    const body = json(res) as { token: string; room: string; identity: string };
    expect(body.room).toBe(`home:${homeId}`);
    expect(body.identity.startsWith("user:")).toBe(true);

    const decoded = jwt.verify(body.token, "secret") as Record<string, unknown>;
    const video = decoded.video as { room: string; roomJoin: boolean; canSubscribe: boolean; canPublishData: boolean };
    expect(video.room).toBe(`home:${homeId}`);
    expect(video.roomJoin).toBe(true);
    expect(video.canSubscribe).toBe(true);
    expect(video.canPublishData).toBe(true);
    const meta = JSON.parse(decoded.metadata as string);
    expect(meta.role).toBe("viewer");
  });

  it("mints a camera token from the device secret", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/rt/token",
      payload: { homeId, role: "camera", deviceSecret },
    });
    expect(res.statusCode).toBe(200);
    const body = json(res) as { identity: string; token: string };
    expect(body.identity).toBe(`camera:${cameraId}`);
    const decoded = jwt.verify(body.token, "secret") as Record<string, unknown>;
    expect((decoded.video as { canPublish: boolean }).canPublish).toBe(true);

    const bad = await app.inject({
      method: "POST",
      url: "/rt/token",
      payload: { homeId, role: "camera", deviceSecret: "nope" },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("renames and deletes the camera", async () => {
    const renamed = await app.inject({
      method: "PATCH",
      url: `/cameras/${cameraId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Porch" },
    });
    expect((json(renamed) as { name: string }).name).toBe("Porch");

    const del = await app.inject({
      method: "DELETE",
      url: `/cameras/${cameraId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);
  });

  it("forbids a non-member from viewing a home's cameras", async () => {
    const intruderReg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { identifier: "intruder", password: "pw" },
    });
    const intruderToken = (json(intruderReg) as { token: string }).token;

    const res = await app.inject({
      method: "GET",
      url: `/homes/${homeId}/cameras`,
      headers: { authorization: `Bearer ${intruderToken}` },
    });
    expect(res.statusCode).toBe(403);

    const noauth = await app.inject({ method: "GET", url: `/homes/${homeId}/cameras` });
    expect(noauth.statusCode).toBe(401);
  });
});

describe("server settings: pairing URL", () => {
  let token: string;
  let homeId: string;

  it("defaults to the auto-detected origin and honors an override", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { identifier: "settings-admin", password: "pw" },
    });
    token = (json(reg) as { token: string }).token;

    const home = await app.inject({
      method: "POST",
      url: "/homes",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Settings House" },
    });
    homeId = (json(home) as { id: string }).id;

    // No override yet: GET returns null + an auto-detected URL.
    const before = await app.inject({
      method: "GET",
      url: "/settings",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.statusCode).toBe(200);
    const s = json(before) as { pairingServerUrl: string | null; detectedServerUrl: string };
    expect(s.pairingServerUrl).toBeNull();
    expect(s.detectedServerUrl).toMatch(/^https?:\/\//);

    // A fresh ticket falls back to the detected origin, not the env localhost.
    const pair1 = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/cameras/pair`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect((json(pair1) as { serverUrl: string }).serverUrl).toBe(s.detectedServerUrl);

    // Set an explicit override.
    const put = await app.inject({
      method: "PUT",
      url: "/settings",
      headers: { authorization: `Bearer ${token}` },
      payload: { pairingServerUrl: "http://192.168.1.42:3199" },
    });
    expect(put.statusCode).toBe(200);
    expect((json(put) as { pairingServerUrl: string }).pairingServerUrl).toBe(
      "http://192.168.1.42:3199",
    );

    // New tickets now embed the override.
    const pair2 = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/cameras/pair`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect((json(pair2) as { serverUrl: string }).serverUrl).toBe("http://192.168.1.42:3199");

    // Invalid URLs are rejected.
    const bad = await app.inject({
      method: "PUT",
      url: "/settings",
      headers: { authorization: `Bearer ${token}` },
      payload: { pairingServerUrl: "not-a-url" },
    });
    expect(bad.statusCode).toBe(400);

    // Clearing (null) falls back to auto-detection again.
    const cleared = await app.inject({
      method: "PUT",
      url: "/settings",
      headers: { authorization: `Bearer ${token}` },
      payload: { pairingServerUrl: null },
    });
    expect((json(cleared) as { pairingServerUrl: string | null }).pairingServerUrl).toBeNull();
  });

  it("requires auth to read or change settings", async () => {
    const noauth = await app.inject({ method: "GET", url: "/settings" });
    expect(noauth.statusCode).toBe(401);
  });
});

describe("recordings: coverage + delete", () => {
  let token: string;
  let homeId: string;
  let cameraId: string;

  /** Write `count` contiguous 6s segments starting at `baseEpoch` into the tree. */
  function writeSegments(baseEpoch: number, count: number): void {
    const dir = join(recDir, homeId, cameraId);
    for (let i = 0; i < count; i++) {
      const epoch = baseEpoch + i * 6;
      const d = new Date(epoch * 1000);
      const bucket = join(
        dir,
        String(d.getUTCFullYear()),
        String(d.getUTCMonth() + 1).padStart(2, "0"),
        String(d.getUTCDate()).padStart(2, "0"),
      );
      mkdirSync(bucket, { recursive: true });
      writeFileSync(join(bucket, segmentName(epoch)), "x".repeat(1000));
    }
  }

  it("sets up a home + camera", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { identifier: "rec-owner", password: "pw" },
    });
    token = (json(reg) as { token: string }).token;

    const home = await app.inject({
      method: "POST",
      url: "/homes",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Rec House" },
    });
    homeId = (json(home) as { id: string }).id;

    const pair = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/cameras/pair`,
      headers: { authorization: `Bearer ${token}` },
    });
    const ticket = json(pair) as { token: string };
    const claim = await app.inject({
      method: "POST",
      url: "/pair/claim",
      payload: {
        token: ticket.token,
        name: "Garage",
        cameraPublicKey: CAMERA_PUBKEY,
        capabilities: { lenses: [1], maxDigitalZoom: 4, torch: true, maxResolution: { width: 1, height: 1 }, supportsAudio: true },
      },
    });
    cameraId = (json(claim) as { camera: { id: string } }).camera.id;
  });

  it("reports coverage, deletes a span, then reports it gone", async () => {
    const base = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
    writeSegments(base, 3); // one contiguous span: [base, base+18)

    const before = await app.inject({
      method: "GET",
      url: `/cameras/${cameraId}/recordings`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.statusCode).toBe(200);
    const cov = json(before) as { spans: Array<{ start: string; end: string }>; totalBytes: number };
    expect(cov.spans).toHaveLength(1);
    expect(cov.totalBytes).toBe(3000);

    const from = Math.floor(Date.parse(cov.spans[0].start) / 1000);
    const to = Math.floor(Date.parse(cov.spans[0].end) / 1000);
    const del = await app.inject({
      method: "DELETE",
      url: `/cameras/${cameraId}/recordings?from=${from}&to=${to}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(200);
    const result = json(del) as { deletedSegments: number; deletedBytes: number };
    expect(result.deletedSegments).toBe(3);
    expect(result.deletedBytes).toBe(3000);

    // Empty date-bucket dirs are pruned (the camera dir itself may remain).
    expect(existsSync(join(recDir, homeId, cameraId, "2026"))).toBe(false);

    const after = await app.inject({
      method: "GET",
      url: `/cameras/${cameraId}/recordings`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect((json(after) as { spans: unknown[] }).spans).toHaveLength(0);
  });

  it("live playlist reads only the current day bucket(s); range still sees everything", async () => {
    // Own camera (own dir) so the coverage/delete test above — whose final GET
    // cached a now-EMPTY listing for its camera — can't bleed into this one.
    const pair = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/cameras/pair`,
      headers: { authorization: `Bearer ${token}` },
    });
    const claim = await app.inject({
      method: "POST",
      url: "/pair/claim",
      payload: {
        token: (json(pair) as { token: string }).token,
        name: "Porch",
        cameraPublicKey: CAMERA_PUBKEY,
        capabilities: { lenses: [1], maxDigitalZoom: 4, torch: true, maxResolution: { width: 1, height: 1 }, supportsAudio: true },
      },
    });
    const camId = (json(claim) as { camera: { id: string } }).camera.id;
    const write = (epoch: number): void => {
      const d = new Date(epoch * 1000);
      const bucket = join(
        recDir,
        homeId,
        camId,
        String(d.getUTCFullYear()),
        String(d.getUTCMonth() + 1).padStart(2, "0"),
        String(d.getUTCDate()).padStart(2, "0"),
      );
      mkdirSync(bucket, { recursive: true });
      writeFileSync(join(bucket, segmentName(epoch)), "x".repeat(100));
    };

    // Live mode must not walk the whole retention tree, so it only lists the
    // current UTC day bucket (plus yesterday's within a short post-midnight
    // grace). Segments are written relative to the REAL clock here because
    // the route derives "today" from Date.now(); the 5-minute grace window
    // keeps this deterministic even if the suite runs right at UTC midnight.
    const now = Math.floor(Date.now() / 1000);
    const recent = [now - 12, now - 6, now]; // ~last 18s → today (or grace-covered)
    const old = now - 7 * 86_400; // a week ago → never in today/yesterday buckets
    write(old);
    for (const epoch of recent) write(epoch);

    const live = await app.inject({
      method: "GET",
      url: `/recordings/${camId}/playlist.m3u8`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(live.statusCode).toBe(200);
    expect(live.headers["content-type"]).toContain("mpegurl");
    for (const epoch of recent) expect(live.body).toContain(`seg/${segmentName(epoch)}`);
    expect(live.body).not.toContain(segmentName(old));
    // Wall-clock-derived media sequence (monotonic across pruning).
    expect(live.body).toContain(`#EXT-X-MEDIA-SEQUENCE:${Math.floor(recent[0]! / 6)}`);
    expect(live.body).not.toContain("#EXT-X-ENDLIST");

    // Range mode walks the full tree (via the listing cache) → old + recent.
    const range = await app.inject({
      method: "GET",
      url: `/recordings/${camId}/playlist.m3u8?mode=range`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(range.statusCode).toBe(200);
    expect(range.body).toContain(segmentName(old));
    for (const epoch of recent) expect(range.body).toContain(`seg/${segmentName(epoch)}`);
    expect(range.body).toContain("#EXT-X-ENDLIST");
  });

  it("rejects a delete with a bad range and forbids non-members", async () => {
    const bad = await app.inject({
      method: "DELETE",
      url: `/cameras/${cameraId}/recordings?from=100&to=100`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(bad.statusCode).toBe(400);

    const intruderReg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { identifier: "rec-intruder", password: "pw" },
    });
    const intruderToken = (json(intruderReg) as { token: string }).token;
    const forbidden = await app.inject({
      method: "DELETE",
      url: `/cameras/${cameraId}/recordings?from=1&to=2`,
      headers: { authorization: `Bearer ${intruderToken}` },
    });
    expect(forbidden.statusCode).toBe(403);

    const noauth = await app.inject({
      method: "DELETE",
      url: `/cameras/${cameraId}/recordings?from=1&to=2`,
    });
    expect(noauth.statusCode).toBe(401);
  });
});
