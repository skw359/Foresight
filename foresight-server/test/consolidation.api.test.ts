/**
 * End-to-end tests for consolidated-day-file playback through the real routes
 * (Fastify inject, no network): BYTERANGE playlist rendering, day-file HTTP
 * Range serving (200/206/416), the stale-playlist fallback that slices a
 * consolidated segment out of its day file, and range deletes that remove or
 * rewrite day files. Fixtures carry distinct byte content per segment so every
 * served slice is verified byte-for-byte.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dayFileName,
  dayIndexFileName,
  isDayIndex,
  segmentName,
  utcDayStamp,
  type DayIndex,
} from "@foresight/contract";
import type { FastifyInstance } from "fastify";
import type { Db } from "../src/db.js";

const here = join(fileURLToPath(import.meta.url), "..");
const migrationsDir = join(here, "..", "prisma", "migrations");
const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => /^\d+_/.test(name))
  .sort();

// Point the app at an isolated DB + deterministic secrets BEFORE importing it.
const dbDir = mkdtempSync(join(tmpdir(), "foresight-consol-db-"));
const dbPath = join(dbDir, "test.db");
process.env.DATABASE_URL = `file:${dbPath}`;
process.env.JWT_SECRET = "test-secret";
process.env.LIVEKIT_URL = "ws://localhost:7880";
process.env.LIVEKIT_PUBLIC_URL = "ws://localhost:7880";
process.env.LIVEKIT_API_KEY = "devkey";
process.env.LIVEKIT_API_SECRET = "secret";
process.env.PUBLIC_SERVER_URL = "http://localhost:3199";
// Isolated on-disk segment tree for the consolidated-day fixtures.
const recDir = mkdtempSync(join(tmpdir(), "foresight-consol-rec-"));
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
  await prisma.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(recDir, { recursive: true, force: true });
});

const json = (res: { json: () => unknown }) => res.json();

// A valid base64 32-byte X25519 public key for /pair/claim.
const CAMERA_PUBKEY = Buffer.alloc(32, 7).toString("base64");

/** UTC YYYY/MM/DD bucket dir for an epoch, under a camera dir. */
function bucketOf(dir: string, epoch: number): string {
  const d = new Date(epoch * 1000);
  return join(
    dir,
    String(d.getUTCFullYear()),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  );
}

/** Write a consolidated day (media concat + valid index) into a camera dir. */
function writeDay(dir: string, specs: Array<{ epoch: number; body: Buffer }>): void {
  const stamp = utcDayStamp(specs[0]!.epoch);
  const bucket = bucketOf(dir, specs[0]!.epoch);
  mkdirSync(bucket, { recursive: true });
  let offset = 0;
  const segments = specs.map((s) => {
    const entry = { epoch: s.epoch, offset, bytes: s.body.length, duration: 6 };
    offset += s.body.length;
    return entry;
  });
  writeFileSync(join(bucket, dayFileName(stamp)), Buffer.concat(specs.map((s) => s.body)));
  writeFileSync(
    join(bucket, dayIndexFileName(stamp)),
    JSON.stringify({ version: 1, day: stamp, file: dayFileName(stamp), totalBytes: offset, segments }),
  );
}

function writeSeg(dir: string, epoch: number, body: Buffer): void {
  const bucket = bucketOf(dir, epoch);
  mkdirSync(bucket, { recursive: true });
  writeFileSync(join(bucket, segmentName(epoch)), body);
}

const fill = (ch: string, len: number): Buffer => Buffer.alloc(len, ch);

// Consolidated day 2026-02-10 (three segments, distinct bytes) + one loose
// segment the following day.
const EA = Math.floor(Date.UTC(2026, 1, 10, 12, 0, 0) / 1000);
const EB = EA + 6;
const EC = EA + 12;
const BODY_A = fill("a", 100);
const BODY_B = fill("b", 150);
const BODY_C = fill("c", 200);
const DAY_TOTAL = 450;
const DAY_NAME = "day_20260210.ts";
const LOOSE_E = Math.floor(Date.UTC(2026, 1, 11, 12, 0, 0) / 1000);
const BODY_L = fill("l", 120);

describe("consolidated day files through the API", () => {
  let token: string;
  let homeId: string;
  let cameraId: string;

  /** GET a recordings URL for the fixture camera with auth (+ extra headers). */
  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}`, ...headers } });

  async function claimCamera(name: string): Promise<string> {
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
        name,
        cameraPublicKey: CAMERA_PUBKEY,
        capabilities: { lenses: [1], maxDigitalZoom: 4, torch: true, maxResolution: { width: 1, height: 1 }, supportsAudio: true },
      },
    });
    return (json(claim) as { camera: { id: string } }).camera.id;
  }

  it("sets up a home + camera and writes the consolidated fixture", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { identifier: "consol-owner", password: "pw" },
    });
    token = (json(reg) as { token: string }).token;

    const home = await app.inject({
      method: "POST",
      url: "/homes",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Consolidated House" },
    });
    homeId = (json(home) as { id: string }).id;
    cameraId = await claimCamera("Backyard");

    const dir = join(recDir, homeId, cameraId);
    writeDay(dir, [
      { epoch: EA, body: BODY_A },
      { epoch: EB, body: BODY_B },
      { epoch: EC, body: BODY_C },
    ]);
    writeSeg(dir, LOOSE_E, BODY_L);
  });

  it("coverage merges index entries with loose segs — bytes from the index, no day-file stats", async () => {
    const res = await get(`/cameras/${cameraId}/recordings`);
    expect(res.statusCode).toBe(200);
    const cov = json(res) as {
      spans: Array<{ start: string; end: string; segments: number; bytes: number }>;
      totalBytes: number;
      earliest: string | null;
    };
    expect(cov.spans).toHaveLength(2);
    expect(cov.spans[0]).toMatchObject({ segments: 3, bytes: DAY_TOTAL });
    expect(cov.spans[0]!.start).toBe(new Date(EA * 1000).toISOString());
    expect(cov.spans[0]!.end).toBe(new Date((EC + 6) * 1000).toISOString());
    expect(cov.spans[1]).toMatchObject({ segments: 1, bytes: 120 });
    expect(cov.totalBytes).toBe(DAY_TOTAL + 120);
  });

  it("range playlist emits HLS v4 BYTERANGE entries pointing at the day file", async () => {
    const res = await get(`/recordings/${cameraId}/playlist.m3u8?mode=range`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("#EXT-X-VERSION:4");
    // Every consolidated entry: explicit length@offset, then the CONTAINER URI.
    expect(res.body).toContain(`#EXT-X-BYTERANGE:100@0\nseg/${DAY_NAME}`);
    expect(res.body).toContain(`#EXT-X-BYTERANGE:150@100\nseg/${DAY_NAME}`);
    expect(res.body).toContain(`#EXT-X-BYTERANGE:200@250\nseg/${DAY_NAME}`);
    // The loose segment keeps its plain per-file URI, with no BYTERANGE line.
    expect(res.body).toContain(`seg/${segmentName(LOOSE_E)}`);
    expect(res.body).not.toContain(`#EXT-X-BYTERANGE:120`);
    expect(res.body).toContain("#EXT-X-ENDLIST");
  });

  it("serves the whole day file as a 200 with Accept-Ranges", async () => {
    const res = await get(`/recordings/${cameraId}/seg/${DAY_NAME}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(Number(res.headers["content-length"])).toBe(DAY_TOTAL);
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(res.rawPayload.equals(Buffer.concat([BODY_A, BODY_B, BODY_C]))).toBe(true);
  });

  it("serves a bounded Range as a 206 with the exact slice", async () => {
    const res = await get(`/recordings/${cameraId}/seg/${DAY_NAME}`, { range: "bytes=100-249" });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 100-249/${DAY_TOTAL}`);
    expect(Number(res.headers["content-length"])).toBe(150);
    expect(res.rawPayload.equals(BODY_B)).toBe(true);
  });

  it("serves open-ended and suffix Ranges", async () => {
    const open = await get(`/recordings/${cameraId}/seg/${DAY_NAME}`, { range: "bytes=250-" });
    expect(open.statusCode).toBe(206);
    expect(open.headers["content-range"]).toBe(`bytes 250-449/${DAY_TOTAL}`);
    expect(open.rawPayload.equals(BODY_C)).toBe(true);

    const suffix = await get(`/recordings/${cameraId}/seg/${DAY_NAME}`, { range: "bytes=-200" });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.headers["content-range"]).toBe(`bytes 250-449/${DAY_TOTAL}`);
    expect(suffix.rawPayload.equals(BODY_C)).toBe(true);

    // An end past EOF is clamped; an over-long suffix means the whole file.
    const clamped = await get(`/recordings/${cameraId}/seg/${DAY_NAME}`, { range: "bytes=250-9999" });
    expect(clamped.statusCode).toBe(206);
    expect(clamped.headers["content-range"]).toBe(`bytes 250-449/${DAY_TOTAL}`);
    const overSuffix = await get(`/recordings/${cameraId}/seg/${DAY_NAME}`, { range: "bytes=-9999" });
    expect(overSuffix.statusCode).toBe(206);
    expect(overSuffix.headers["content-range"]).toBe(`bytes 0-449/${DAY_TOTAL}`);
  });

  it("rejects an unsatisfiable Range with 416 + Content-Range: bytes */size", async () => {
    const res = await get(`/recordings/${cameraId}/seg/${DAY_NAME}`, { range: `bytes=${DAY_TOTAL}-` });
    expect(res.statusCode).toBe(416);
    expect(res.headers["content-range"]).toBe(`bytes */${DAY_TOTAL}`);
  });

  it("treats multi-range and malformed Range headers as a plain 200", async () => {
    const multi = await get(`/recordings/${cameraId}/seg/${DAY_NAME}`, { range: "bytes=0-0,449-449" });
    expect(multi.statusCode).toBe(200);
    expect(Number(multi.headers["content-length"])).toBe(DAY_TOTAL);

    const junk = await get(`/recordings/${cameraId}/seg/${DAY_NAME}`, { range: "bytes=junk" });
    expect(junk.statusCode).toBe(200);
    expect(Number(junk.headers["content-length"])).toBe(DAY_TOTAL);
  });

  it("stale-playlist fallback: a consolidated seg_* URI serves its exact byte slice", async () => {
    // No loose seg_20260210120006.ts exists — only the day index knows it.
    const res = await get(`/recordings/${cameraId}/seg/${segmentName(EB)}`);
    expect(res.statusCode).toBe(200);
    expect(Number(res.headers["content-length"])).toBe(150);
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(res.rawPayload.equals(BODY_B)).toBe(true);

    // Stale playlists never send Range — if one arrives anyway it is ignored
    // and the full entry slice is served as a 200.
    const ranged = await get(`/recordings/${cameraId}/seg/${segmentName(EB)}`, { range: "bytes=0-9" });
    expect(ranged.statusCode).toBe(200);
    expect(Number(ranged.headers["content-length"])).toBe(150);
    expect(ranged.rawPayload.equals(BODY_B)).toBe(true);
  });

  it("404s only when a segment exists neither loose nor in a day index", async () => {
    const unknownSeg = await get(`/recordings/${cameraId}/seg/seg_20260210130000.ts`);
    expect(unknownSeg.statusCode).toBe(404);
    const unknownDay = await get(`/recordings/${cameraId}/seg/day_20260215.ts`);
    expect(unknownDay.statusCode).toBe(404);
  });

  describe("range deletes over a consolidated day", () => {
    // Own camera so the read-only fixtures above stay untouched.
    let delCameraId: string;
    let delDir: string;
    const FA = Math.floor(Date.UTC(2026, 1, 12, 12, 0, 0) / 1000);
    const FB = FA + 6;
    const FC = FA + 12;
    const FD = FA + 18;
    const F_BODY_A = fill("w", 100);
    const F_BODY_B = fill("x", 150);
    const F_BODY_C = fill("y", 200);
    const F_BODY_D = fill("z", 250);
    const DAY_B_START = Math.floor(Date.UTC(2026, 1, 12, 0, 0, 0) / 1000);

    it("partial overlap rewrites the day file to exactly the kept windows", async () => {
      delCameraId = await claimCamera("Shed");
      delDir = join(recDir, homeId, delCameraId);
      writeDay(delDir, [
        { epoch: FA, body: F_BODY_A },
        { epoch: FB, body: F_BODY_B },
        { epoch: FC, body: F_BODY_C },
        { epoch: FD, body: F_BODY_D },
      ]);

      // [FB, FD) removes B and C; A and D survive.
      const del = await app.inject({
        method: "DELETE",
        url: `/cameras/${delCameraId}/recordings?from=${FB}&to=${FD}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(200);
      expect(json(del)).toMatchObject({ deletedSegments: 2, deletedBytes: 350 });

      const bucket = bucketOf(delDir, FA);
      const media = readFileSync(join(bucket, dayFileName("20260212")));
      expect(media.equals(Buffer.concat([F_BODY_A, F_BODY_D]))).toBe(true);
      const rewritten = JSON.parse(
        readFileSync(join(bucket, dayIndexFileName("20260212")), "utf8"),
      ) as DayIndex;
      expect(isDayIndex(rewritten)).toBe(true);
      expect(rewritten.totalBytes).toBe(350);

      // Post-delete coverage is fresh (cache invalidated) and reflects the gap.
      const cov = await get(`/cameras/${delCameraId}/recordings`);
      const body = json(cov) as { spans: Array<{ segments: number; bytes: number }>; totalBytes: number };
      expect(body.spans).toHaveLength(2);
      expect(body.spans[0]).toMatchObject({ segments: 1, bytes: 100 });
      expect(body.spans[1]).toMatchObject({ segments: 1, bytes: 250 });
      expect(body.totalBytes).toBe(350);
    });

    it("a fully-covered day loses both the day file and its index", async () => {
      const del = await app.inject({
        method: "DELETE",
        url: `/cameras/${delCameraId}/recordings?from=${DAY_B_START}&to=${DAY_B_START + 86_400}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(200);
      expect(json(del)).toMatchObject({ deletedSegments: 2, deletedBytes: 350 });

      const bucket = bucketOf(delDir, FA);
      expect(existsSync(join(bucket, dayFileName("20260212")))).toBe(false);
      expect(existsSync(join(bucket, dayIndexFileName("20260212")))).toBe(false);

      const cov = await get(`/cameras/${delCameraId}/recordings`);
      const body = json(cov) as { spans: unknown[]; totalBytes: number };
      expect(body.spans).toHaveLength(0);
      expect(body.totalBytes).toBe(0);
    });
  });
});
