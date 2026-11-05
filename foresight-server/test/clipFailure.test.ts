/**
 * REC-04 / REC-06: a clip export whose ffmpeg can't run must fail visibly (no
 * 200 with an empty body) and must not leak its concurrency slot.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { segmentName } from "@foresight/contract";
import type { FastifyInstance } from "fastify";
import type { Db } from "../src/db.js";
import { applyTestEnv } from "./testEnv.js";

const here = join(fileURLToPath(import.meta.url), "..");
const migrationsDir = join(here, "..", "prisma", "migrations");
const dbDir = mkdtempSync(join(tmpdir(), "foresight-clip-"));
const recDir = mkdtempSync(join(tmpdir(), "foresight-clip-rec-"));
process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
applyTestEnv();
process.env.LIVEKIT_URL = "ws://localhost:7880";
process.env.RECORDINGS_DIR = recDir;
process.env.FFMPEG_PATH = "/nonexistent/ffmpeg-for-test";
{
  const db = new DatabaseSync(join(dbDir, "test.db"));
  for (const name of readdirSync(migrationsDir).filter((n) => /^\d+_/.test(n)).sort()) {
    db.exec(readFileSync(join(migrationsDir, name, "migration.sql"), "utf8"));
  }
  db.close();
}

let app: FastifyInstance;
let prisma: Db;
beforeAll(async () => {
  prisma = (await import("../src/db.js")).prisma;
  app = (await import("../src/app.js")).buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(recDir, { recursive: true, force: true });
});

describe("clip export failure", () => {
  it("never reports a failed export as a successful download, and frees its slot", async () => {
    const reg = await app.inject({ method: "POST", url: "/auth/register", payload: { identifier: "clip", password: "pw" } });
    const token = (reg.json() as { token: string }).token;
    const auth = { authorization: `Bearer ${token}` };
    const homeId = (
      (await app.inject({ method: "POST", url: "/homes", headers: auth, payload: { name: "H" } })).json() as { id: string }
    ).id;
    const ticket = (await app.inject({ method: "POST", url: `/homes/${homeId}/cameras/pair`, headers: auth })).json() as {
      token: string;
    };
    const claim = await app.inject({
      method: "POST",
      url: "/pair/claim",
      payload: {
        token: ticket.token,
        name: "C",
        cameraPublicKey: Buffer.alloc(32, 7).toString("base64"),
        capabilities: { lenses: [1], maxDigitalZoom: 1, torch: false, maxResolution: { width: 1, height: 1 }, supportsAudio: false },
      },
    });
    const cameraId = (claim.json() as { camera: { id: string } }).camera.id;

    const base = Math.floor(Date.UTC(2026, 0, 15, 12) / 1000);
    const bucket = join(recDir, homeId, cameraId, "2026", "01", "15");
    mkdirSync(bucket, { recursive: true });
    writeFileSync(join(bucket, segmentName(base)), Buffer.alloc(188, 0x47));

    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "GET",
        url: `/recordings/${cameraId}/clip.mp4?from=${base}&to=${base + 6}`,
        headers: auth,
      }).catch((err: unknown) => ({ statusCode: -1, err }));
      // A failed export is a server error (JSON), never a "successful" empty
      // or truncated download — and a leaked slot would turn the 2nd/3rd
      // attempt into a 429 (one export per user).
      expect(res.statusCode).toBe(500);
      if ("headers" in res) {
        expect(res.headers["content-type"]).toContain("application/json");
        expect(res.headers["content-disposition"]).toBeUndefined();
      }
    }
  });
});
