/**
 * E2EE key-management API tests (E2EE_MODEL_B_PLAN.md M7). Uses the same
 * Fastify `inject()` + isolated temp SQLite bootstrap as api.test.ts, and also
 * imports the shared PrismaClient to set up edge cases (a camera with no pubkey)
 * and to assert row-level side effects (HomeKey cleanup, consent revoke).
 */
import { TEST_LIVEKIT_SECRET, TEST_RECORDER_SECRET, applyTestEnv } from "./testEnv.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Db } from "../src/db.js";

const here = join(fileURLToPath(import.meta.url), "..");
const migrationsDir = join(here, "..", "prisma", "migrations");
const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => /^\d+_/.test(name))
  .sort();

const dbDir = mkdtempSync(join(tmpdir(), "foresight-e2ee-"));
const dbPath = join(dbDir, "test.db");
process.env.DATABASE_URL = `file:${dbPath}`;
applyTestEnv();
process.env.LIVEKIT_URL = "ws://localhost:7880";
process.env.PUBLIC_SERVER_URL = "http://localhost:3199";
// Enables the /internal/* routes and the fire-and-forget recorder control calls
// (which harmlessly fail with ECONNREFUSED against a recorder that isn't running).
process.env.RECORDER_SHARED_SECRET = TEST_RECORDER_SECRET;

{
  const db = new DatabaseSync(dbPath);
  for (const name of migrationFiles) {
    db.exec(readFileSync(join(migrationsDir, name, "migration.sql"), "utf8"));
  }
  db.close();
}

// Capture server-originated room broadcasts instead of calling the SFU.
const broadcasts = vi.hoisted(() => [] as Array<{ homeId: string; msg: unknown }>);
vi.mock("../src/livekit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/livekit.js")>()),
  broadcastToHome: async (homeId: string, msg: unknown) => {
    broadcasts.push({ homeId, msg });
  },
}));

let app: FastifyInstance;
/** The loopback-only server↔recorder app (never mounted on the public one). */
let internal: FastifyInstance;
let prisma: Db;

beforeAll(async () => {
  prisma = (await import("../src/db.js")).prisma;
  const { buildApp, buildInternalApp } = await import("../src/app.js");
  app = buildApp();
  internal = buildInternalApp();
  await app.ready();
  await internal.ready();
});

afterAll(async () => {
  await app.close();
  await internal.close();
  await prisma.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

// --------------------------------------------------------------------- helpers
const json = (res: { json: () => unknown }) => res.json();
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const RECORDER_SECRET = { "x-recorder-secret": TEST_RECORDER_SECRET };

/** A base64 blob of exactly `bytes` bytes (deterministic by `fill`). */
const b64 = (bytes: number, fill = 1) => Buffer.alloc(bytes, fill).toString("base64");

const caps = {
  lenses: [1],
  maxDigitalZoom: 4,
  torch: true,
  maxResolution: { width: 1, height: 1 },
  supportsAudio: true,
};

const vault = (fill = 1) => ({
  publicKey: b64(32, fill),
  wrappedPrivateKey: b64(48, fill),
  nonce: b64(24, fill),
  kdf: { algo: "argon2id", opslimit: 3, memlimit: 67108864, saltB64: b64(16, fill) },
});

async function register(identifier: string): Promise<{ token: string; userId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { identifier, password: "pw" },
  });
  const body = json(res) as { token: string; user: { id: string } };
  return { token: body.token, userId: body.user.id };
}

async function setKeys(token: string, fill = 1) {
  return app.inject({ method: "POST", url: "/me/keys", headers: auth(token), payload: vault(fill) });
}

async function createHome(token: string, name: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/homes", headers: auth(token), payload: { name } });
  return (json(res) as { id: string }).id;
}

async function pairCamera(
  token: string,
  homeId: string,
  name: string,
): Promise<{ cameraId: string; deviceSecret: string }> {
  const pair = await app.inject({
    method: "POST",
    url: `/homes/${homeId}/cameras/pair`,
    headers: auth(token),
  });
  const ticket = json(pair) as { token: string };
  const claim = await app.inject({
    method: "POST",
    url: "/pair/claim",
    payload: { token: ticket.token, name, cameraPublicKey: b64(32, 9), capabilities: caps },
  });
  const c = json(claim) as { camera: { id: string }; deviceSecret: string };
  return { cameraId: c.camera.id, deviceSecret: c.deviceSecret };
}

/** Register the global recorder identity (idempotent for the same key). */
async function registerRecorder(fill: number) {
  return internal.inject({
    method: "POST",
    url: "/internal/recorder-identity",
    headers: RECORDER_SECRET,
    payload: { publicKey: b64(32, fill) },
  });
}

// ================================================================= zero-knowledge
it("server source contains no unsealing/KDF primitive names (zero-knowledge guard)", () => {
  const forbidden = ["crypto_box_seal" + "_open", "crypto_secretbox" + "_open", "crypto_" + "pwhash"];
  const srcDir = join(here, "..", "src");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
    });
  const offenders: string[] = [];
  for (const file of walk(srcDir)) {
    const text = readFileSync(file, "utf8");
    for (const f of forbidden) if (text.includes(f)) offenders.push(`${file}: ${f}`);
  }
  expect(offenders).toEqual([]);
});

// ============================================================== auth keyVault
describe("auth responses carry keyVault", () => {
  it("register → null, set keys, login + GET /me/keys → the stored vault", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { identifier: "kv-user", password: "pw" },
    });
    expect((json(reg) as { keyVault: unknown }).keyVault).toBeNull();
    const token = (json(reg) as { token: string }).token;

    const v = vault(5);
    const set = await app.inject({ method: "POST", url: "/me/keys", headers: auth(token), payload: v });
    expect(set.statusCode).toBe(204);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { identifier: "kv-user", password: "pw" },
    });
    expect((json(login) as { keyVault: unknown }).keyVault).toEqual(v);

    const me = await app.inject({ method: "GET", url: "/me/keys", headers: auth(token) });
    expect((json(me) as { keyVault: unknown }).keyVault).toEqual(v);
  });
});

// ============================================================ size validation
describe("blob size validation (shape/size only)", () => {
  it("rejects wrong-length vault blobs and sealed keys", async () => {
    const { token, userId } = await register("size-user");

    // publicKey must be 32 bytes.
    const badPk = await app.inject({
      method: "POST",
      url: "/me/keys",
      headers: auth(token),
      payload: { ...vault(1), publicKey: b64(31, 1) },
    });
    expect(badPk.statusCode).toBe(400);

    // nonce must be 24 bytes.
    const badNonce = await app.inject({
      method: "POST",
      url: "/me/keys",
      headers: auth(token),
      payload: { ...vault(1), nonce: b64(23, 1) },
    });
    expect(badNonce.statusCode).toBe(400);

    // A correctly-sized vault is accepted.
    expect((await setKeys(token)).statusCode).toBe(204);

    // sealedKey must be 80 bytes — exercised via key/init on an activated-able Home.
    const homeId = await createHome(token, "Size House");
    const { cameraId } = await pairCamera(token, homeId, "Cam");
    const badSealed = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/init`,
      headers: auth(token),
      payload: { keys: [{ holderType: "user", holderId: userId, sealedKey: b64(79, 2) }] },
    });
    expect(badSealed.statusCode).toBe(400);
    void cameraId;
  });
});

// ================================================= activation (key/init) 409 gate
describe("home key activation (key/init)", () => {
  it("409s until every camera has a pubkey, then activates to epoch 1", async () => {
    const { token, userId } = await register("init-owner");
    await setKeys(token);
    const homeId = await createHome(token, "Init House");
    const { cameraId } = await pairCamera(token, homeId, "Front Door");

    // Simulate a not-yet-migrated camera (paired before E2EE) → no pubkey.
    await prisma.camera.update({ where: { id: cameraId }, data: { publicKey: null } });

    const blocked = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/init`,
      headers: auth(token),
      payload: { keys: [{ holderType: "user", holderId: userId, sealedKey: b64(80, 1) }] },
    });
    expect(blocked.statusCode).toBe(409);
    const details = (json(blocked) as { details: { reason: string; cameras: { id: string }[] } }).details;
    expect(details.reason).toBe("cameras_missing_pubkey");
    expect(details.cameras.map((c) => c.id)).toContain(cameraId);

    // Camera registers its pubkey (device-authed migration path would do this).
    await prisma.camera.update({ where: { id: cameraId }, data: { publicKey: b64(32, 9) } });

    const ok = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/init`,
      headers: auth(token),
      payload: {
        keys: [
          { holderType: "user", holderId: userId, sealedKey: b64(80, 1) },
          { holderType: "camera", holderId: cameraId, sealedKey: b64(80, 2) },
        ],
      },
    });
    expect(ok.statusCode).toBe(200);
    expect((json(ok) as { keyEpoch: number }).keyEpoch).toBe(1);

    // Re-activation is refused.
    const again = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/init`,
      headers: auth(token),
      payload: { keys: [{ holderType: "user", holderId: userId, sealedKey: b64(80, 1) }] },
    });
    expect(again.statusCode).toBe(409);

    // The owner can read back their own sealed copy.
    const myKey = await app.inject({ method: "GET", url: `/homes/${homeId}/key`, headers: auth(token) });
    expect(json(myKey)).toEqual({ epoch: 1, sealedKey: b64(80, 1) });
  });

  it("requires the caller's own user copy in the init keys", async () => {
    const { token, userId } = await register("init-owner-2");
    await setKeys(token);
    const homeId = await createHome(token, "Init House 2");
    await pairCamera(token, homeId, "Cam");
    const res = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/init`,
      // Only a camera copy, missing the owner's own user copy.
      headers: auth(token),
      payload: { keys: [{ holderType: "user", holderId: "someone-else", sealedKey: b64(80, 1) }] },
    });
    expect(res.statusCode).toBe(400);
    void userId;
  });
});

// ================================================================ submit idempotency
describe("submit sealed keys", () => {
  it("is idempotent per holder+epoch and guards the epoch", async () => {
    const { token: ownerTok, userId: ownerId } = await register("submit-owner");
    await setKeys(ownerTok);
    const homeId = await createHome(ownerTok, "Submit House");
    const { cameraId } = await pairCamera(ownerTok, homeId, "Cam");
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/init`,
      headers: auth(ownerTok),
      payload: {
        keys: [
          { holderType: "user", holderId: ownerId, sealedKey: b64(80, 1) },
          { holderType: "camera", holderId: cameraId, sealedKey: b64(80, 2) },
        ],
      },
    });

    // A second member with a vault, added to the Home but not yet sealed to.
    const { token: bobTok, userId: bobId } = await register("submit-bob");
    await setKeys(bobTok, 6);
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/members`,
      headers: auth(ownerTok),
      payload: { identifier: "submit-bob" },
    });

    const body = { epoch: 1, keys: [{ holderType: "user", holderId: bobId, sealedKey: b64(80, 7) }] };
    const first = await app.inject({ method: "POST", url: `/homes/${homeId}/key`, headers: auth(ownerTok), payload: body });
    const second = await app.inject({ method: "POST", url: `/homes/${homeId}/key`, headers: auth(ownerTok), payload: body });
    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(204);

    const count = await prisma.homeKey.count({
      where: { homeId, epoch: 1, holderType: "user", holderId: bobId },
    });
    expect(count).toBe(1);

    // A stale epoch is rejected.
    const stale = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key`,
      headers: auth(ownerTok),
      payload: { epoch: 0, keys: [{ holderType: "user", holderId: bobId, sealedKey: b64(80, 7) }] },
    });
    expect(stale.statusCode).toBe(409);
    void bobTok;
  });
});

// ================================================================ rotate epoch guard
describe("rotate", () => {
  it("bumps the epoch and rejects a stale fromEpoch", async () => {
    const { token, userId } = await register("rotate-owner");
    await setKeys(token);
    const homeId = await createHome(token, "Rotate House");
    const { cameraId } = await pairCamera(token, homeId, "Cam");
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/init`,
      headers: auth(token),
      payload: {
        keys: [
          { holderType: "user", holderId: userId, sealedKey: b64(80, 1) },
          { holderType: "camera", holderId: cameraId, sealedKey: b64(80, 2) },
        ],
      },
    });

    const stale = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/rotate`,
      headers: auth(token),
      payload: { fromEpoch: 0, keys: [{ holderType: "user", holderId: userId, sealedKey: b64(80, 3) }] },
    });
    expect(stale.statusCode).toBe(409);
    expect((json(stale) as { details: { reason: string } }).details.reason).toBe("stale_epoch");

    const ok = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/rotate`,
      headers: auth(token),
      payload: { fromEpoch: 1, keys: [{ holderType: "user", holderId: userId, sealedKey: b64(80, 3) }] },
    });
    expect(ok.statusCode).toBe(200);
    expect((json(ok) as { keyEpoch: number }).keyEpoch).toBe(2);

    // The old epoch's rows survive as history.
    expect(await prisma.homeKey.count({ where: { homeId, epoch: 1 } })).toBeGreaterThan(0);
    expect(await prisma.homeKey.count({ where: { homeId, epoch: 2 } })).toBe(1);
  });
});

// ============================================================ rt token sealed key
describe("rt token carries keyEpoch + sealedHomeKey", () => {
  it("delivers the caller's sealed copy for both viewer and camera roles", async () => {
    const { token, userId } = await register("rt-owner");
    await setKeys(token);
    const homeId = await createHome(token, "RT House");
    const { cameraId, deviceSecret } = await pairCamera(token, homeId, "Cam");
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/init`,
      headers: auth(token),
      payload: {
        keys: [
          { holderType: "user", holderId: userId, sealedKey: b64(80, 11) },
          { holderType: "camera", holderId: cameraId, sealedKey: b64(80, 22) },
        ],
      },
    });

    const viewer = await app.inject({
      method: "POST",
      url: "/rt/token",
      headers: auth(token),
      payload: { homeId, role: "viewer" },
    });
    const vb = json(viewer) as { keyEpoch: number; sealedHomeKey: { ciphertext: string; epoch: number } | null };
    expect(vb.keyEpoch).toBe(1);
    expect(vb.sealedHomeKey).toEqual({ ciphertext: b64(80, 11), epoch: 1 });

    const cam = await app.inject({
      method: "POST",
      url: "/rt/token",
      payload: { homeId, role: "camera", deviceSecret },
    });
    const cb = json(cam) as { keyEpoch: number; sealedHomeKey: { ciphertext: string; epoch: number } | null };
    expect(cb.keyEpoch).toBe(1);
    expect(cb.sealedHomeKey).toEqual({ ciphertext: b64(80, 22), epoch: 1 });
  });

  it("returns epoch 0 + null for a non-activated Home", async () => {
    const { token } = await register("rt-plain");
    await setKeys(token);
    const homeId = await createHome(token, "Plain House");
    const res = await app.inject({
      method: "POST",
      url: "/rt/token",
      headers: auth(token),
      payload: { homeId, role: "viewer" },
    });
    const b = json(res) as { keyEpoch: number; sealedHomeKey: unknown };
    expect(b.keyEpoch).toBe(0);
    expect(b.sealedHomeKey).toBeNull();
  });
});

// ============================================================ holder-row cleanup
describe("HomeKey holder cleanup (no FK on holderId)", () => {
  it("deletes a camera's rows on camera deletion", async () => {
    const { token, userId } = await register("del-cam-owner");
    await setKeys(token);
    const homeId = await createHome(token, "DelCam House");
    const { cameraId } = await pairCamera(token, homeId, "Cam");
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/init`,
      headers: auth(token),
      payload: {
        keys: [
          { holderType: "user", holderId: userId, sealedKey: b64(80, 1) },
          { holderType: "camera", holderId: cameraId, sealedKey: b64(80, 2) },
        ],
      },
    });
    expect(await prisma.homeKey.count({ where: { holderType: "camera", holderId: cameraId } })).toBe(1);

    const del = await app.inject({ method: "DELETE", url: `/cameras/${cameraId}`, headers: auth(token) });
    expect(del.statusCode).toBe(204);
    expect(await prisma.homeKey.count({ where: { holderType: "camera", holderId: cameraId } })).toBe(0);
  });

  it("purges a user's rows across surviving Homes on DELETE /me", async () => {
    const alice = await register("cleanup-alice");
    const bob = await register("cleanup-bob");
    await setKeys(alice.token, 1);
    await setKeys(bob.token, 6);
    const homeId = await createHome(alice.token, "Shared House");
    const { cameraId } = await pairCamera(alice.token, homeId, "Cam");
    // Promote Bob to co-owner so the Home survives Alice's account deletion.
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/members`,
      headers: auth(alice.token),
      payload: { identifier: "cleanup-bob", role: "owner" },
    });
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/init`,
      headers: auth(alice.token),
      payload: {
        keys: [
          { holderType: "user", holderId: alice.userId, sealedKey: b64(80, 1) },
          { holderType: "camera", holderId: cameraId, sealedKey: b64(80, 2) },
        ],
      },
    });
    // Seal to Bob too.
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key`,
      headers: auth(alice.token),
      payload: { epoch: 1, keys: [{ holderType: "user", holderId: bob.userId, sealedKey: b64(80, 7) }] },
    });

    const del = await app.inject({ method: "DELETE", url: "/me", headers: auth(alice.token) });
    expect(del.statusCode).toBe(204);

    expect(await prisma.homeKey.count({ where: { holderType: "user", holderId: alice.userId } })).toBe(0);
    expect(await prisma.homeKey.count({ where: { holderType: "user", holderId: bob.userId } })).toBe(1);
    // The Home (and Bob's + the camera's rows) survive.
    expect(await prisma.homeKey.count({ where: { homeId } })).toBe(2);
  });
});

// ================================================= recording gate + recorder consent
describe("recording toggle consent gate + recorder consent", () => {
  let ownerTok = "";
  let ownerId = "";
  let epoch0Home = "";
  let epoch0Cam = "";
  let activeHome = "";
  let activeCam = "";

  beforeAll(async () => {
    await registerRecorder(3); // global recorder identity R1
    const owner = await register("rec-owner");
    ownerTok = owner.token;
    ownerId = owner.userId;
    await setKeys(ownerTok);

    epoch0Home = await createHome(ownerTok, "Plaintext Home");
    epoch0Cam = (await pairCamera(ownerTok, epoch0Home, "Cam0")).cameraId;

    activeHome = await createHome(ownerTok, "Encrypted Home");
    activeCam = (await pairCamera(ownerTok, activeHome, "CamA")).cameraId;
    await app.inject({
      method: "POST",
      url: `/homes/${activeHome}/key/init`,
      headers: auth(ownerTok),
      payload: {
        keys: [
          { holderType: "user", holderId: ownerId, sealedKey: b64(80, 1) },
          { holderType: "camera", holderId: activeCam, sealedKey: b64(80, 2) },
        ],
      },
    });
  });

  it("keeps today's behavior at epoch 0 (no gate)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/cameras/${epoch0Cam}/recording`,
      headers: auth(ownerTok),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect((json(res) as { recordingEnabled: boolean }).recordingEnabled).toBe(true);
  });

  it("409s when activated (epoch ≥ 1) without recorder consent", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/cameras/${activeCam}/recording`,
      headers: auth(ownerTok),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(409);
    expect((json(res) as { details: { reason: string } }).details.reason).toBe("recorder_consent_required");
    // Not persisted.
    const cam = await prisma.camera.findUnique({ where: { id: activeCam }, select: { recordingEnabled: true } });
    expect(cam?.recordingEnabled).toBe(false);
  });

  it("allows recording once recorder consent is granted", async () => {
    const identity = await app.inject({ method: "GET", url: "/e2ee/recorder-identity", headers: auth(ownerTok) });
    expect((json(identity) as { publicKey: string | null }).publicKey).toBe(b64(32, 3));

    const consent = await app.inject({
      method: "POST",
      url: `/homes/${activeHome}/recorder-consent`,
      headers: auth(ownerTok),
      payload: { enabled: true, sealedKey: b64(80, 33) },
    });
    expect(consent.statusCode).toBe(200);
    expect(json(consent)).toEqual({ recorderConsented: true, keyEpoch: 1 });

    const rec = await app.inject({
      method: "POST",
      url: `/cameras/${activeCam}/recording`,
      headers: auth(ownerTok),
      payload: { enabled: true },
    });
    expect(rec.statusCode).toBe(200);

    // HomeDTO now reports recorderConsented.
    const homes = await app.inject({ method: "GET", url: "/homes", headers: auth(ownerTok) });
    const dto = (json(homes) as Array<{ id: string; recorderConsented: boolean; keyEpoch: number }>).find(
      (h) => h.id === activeHome,
    );
    expect(dto?.recorderConsented).toBe(true);
    expect(dto?.keyEpoch).toBe(1);
  });

  it("revoke deletes recorder rows and disarms recording home-wide", async () => {
    // Precondition from the previous test: consent row + a recording camera.
    expect(await prisma.homeKey.count({ where: { homeId: activeHome, holderType: "recorder" } })).toBe(1);
    expect(await prisma.camera.count({ where: { homeId: activeHome, recordingEnabled: true } })).toBe(1);

    const res = await app.inject({
      method: "POST",
      url: `/homes/${activeHome}/recorder-consent`,
      headers: auth(ownerTok),
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ recorderConsented: false, keyEpoch: 1 });

    expect(await prisma.homeKey.count({ where: { homeId: activeHome, holderType: "recorder" } })).toBe(0);
    expect(await prisma.camera.count({ where: { homeId: activeHome, recordingEnabled: true } })).toBe(0);
  });
});

// ============================================== internal reconcile + recorder identity
describe("internal recorder API", () => {
  let ownerTok = "";
  let ownerId = "";
  let homeId = "";
  let cameraId = "";

  beforeAll(async () => {
    await registerRecorder(3); // R1 (idempotent)
    const owner = await register("internal-owner");
    ownerTok = owner.token;
    ownerId = owner.userId;
    await setKeys(ownerTok);
    homeId = await createHome(ownerTok, "Internal Home");
    cameraId = (await pairCamera(ownerTok, homeId, "Cam")).cameraId;
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/init`,
      headers: auth(ownerTok),
      payload: {
        keys: [
          { holderType: "user", holderId: ownerId, sealedKey: b64(80, 1) },
          { holderType: "camera", holderId: cameraId, sealedKey: b64(80, 2) },
        ],
      },
    });
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/recorder-consent`,
      headers: auth(ownerTok),
      payload: { enabled: true, sealedKey: b64(80, 44) },
    });
    await app.inject({
      method: "POST",
      url: `/cameras/${cameraId}/recording`,
      headers: auth(ownerTok),
      payload: { enabled: true },
    });
  });

  it("rejects a bad recorder secret", async () => {
    const res = await internal.inject({
      method: "GET",
      url: "/internal/recording-cameras",
      headers: { "x-recorder-secret": "nope" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("is not served by the public app at all, even with the right secret", async () => {
    const res = await app.inject({ method: "GET", url: "/internal/recording-cameras", headers: RECORDER_SECRET });
    expect(res.statusCode).toBe(404);
    const reg = await app.inject({
      method: "POST",
      url: "/internal/recorder-identity",
      headers: RECORDER_SECRET,
      payload: { publicKey: b64(32, 66) },
    });
    expect(reg.statusCode).toBe(404);
  });

  it("reconcile carries cameras + per-Home key state with the sealed HMK", async () => {
    const res = await internal.inject({ method: "GET", url: "/internal/recording-cameras", headers: RECORDER_SECRET });
    expect(res.statusCode).toBe(200);
    const body = json(res) as {
      cameras: { cameraId: string; homeId: string }[];
      homeKeys: { homeId: string; epoch: number; sealedHmk: string | null; revoked: boolean }[];
    };
    expect(body.cameras).toContainEqual({ cameraId, homeId });
    const hk = body.homeKeys.find((h) => h.homeId === homeId);
    expect(hk).toEqual({ homeId, epoch: 1, sealedHmk: b64(80, 44), revoked: false });
  });

  it("changing the recorder pubkey voids all consent everywhere", async () => {
    // A different key ⇒ prior consent is void.
    const change = await registerRecorder(4); // R2
    expect(change.statusCode).toBe(204);
    expect(await prisma.homeKey.count({ where: { holderType: "recorder" } })).toBe(0);

    const identity = await app.inject({ method: "GET", url: "/e2ee/recorder-identity", headers: auth(ownerTok) });
    expect((json(identity) as { publicKey: string | null }).publicKey).toBe(b64(32, 4));

    // The new identity holds no key: the Home waits for re-consent
    // (awaiting_consent). It is NOT reported as an owner revocation.
    const res = await internal.inject({ method: "GET", url: "/internal/recording-cameras", headers: RECORDER_SECRET });
    const hk = (json(res) as { homeKeys: { homeId: string; sealedHmk: string | null; revoked: boolean }[] }).homeKeys.find(
      (h) => h.homeId === homeId,
    );
    expect(hk?.revoked).toBe(false);
    expect(hk?.sealedHmk).toBeNull();

    // Re-registering the SAME (new) key is an idempotent no-op.
    const again = await registerRecorder(4);
    expect(again.statusCode).toBe(204);
    expect(await prisma.recorderIdentity.count()).toBe(1);
  });
});

// ================================================================ pending holders
describe("pending key holders (key/pending)", () => {
  it("at epoch 0 lists the activation candidates (members + cameras with pubkeys)", async () => {
    const { token, userId } = await register("pending-owner");
    await setKeys(token);
    const homeId = await createHome(token, "Pending House");
    const { cameraId } = await pairCamera(token, homeId, "Keyed Cam");
    const { cameraId: legacyCamId } = await pairCamera(token, homeId, "Legacy Cam");
    // Simulate a not-yet-migrated camera (paired before E2EE) → no pubkey.
    await prisma.camera.update({ where: { id: legacyCamId }, data: { publicKey: null } });
    // A member who has not set up a vault yet is not a candidate.
    const { userId: noVaultId } = await register("pending-no-vault");
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/members`,
      headers: auth(token),
      payload: { identifier: "pending-no-vault" },
    });

    const res = await app.inject({ method: "GET", url: `/homes/${homeId}/key/pending`, headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const body = json(res) as {
      epoch: number;
      pending: { holderType: string; holderId: string; publicKey: string; firstContact: boolean }[];
    };
    expect(body.epoch).toBe(0);
    const ids = body.pending.map((h) => `${h.holderType}:${h.holderId}`);
    expect(ids).toContain(`user:${userId}`);
    expect(ids).toContain(`camera:${cameraId}`);
    expect(ids).not.toContain(`camera:${legacyCamId}`);
    expect(ids).not.toContain(`user:${noVaultId}`);
    // First recorder consent is an explicit owner grant, never a pending candidate.
    expect(body.pending.some((h) => h.holderType === "recorder")).toBe(false);
    expect(body.pending.every((h) => h.firstContact)).toBe(true);
  });

  it("after activation lists only holders missing a current-epoch copy", async () => {
    const { token, userId } = await register("pending-owner-2");
    await setKeys(token);
    const homeId = await createHome(token, "Pending House 2");
    const { cameraId } = await pairCamera(token, homeId, "Cam");
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/init`,
      headers: auth(token),
      payload: {
        keys: [
          { holderType: "user", holderId: userId, sealedKey: b64(80, 1) },
          { holderType: "camera", holderId: cameraId, sealedKey: b64(80, 2) },
        ],
      },
    });

    const sealed = await app.inject({ method: "GET", url: `/homes/${homeId}/key/pending`, headers: auth(token) });
    expect(json(sealed)).toEqual({ epoch: 1, pending: [] });

    // A newly added member with a vault surfaces as a first-contact holder.
    const bob = await register("pending-bob");
    await setKeys(bob.token, 6);
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/members`,
      headers: auth(token),
      payload: { identifier: "pending-bob" },
    });
    const after = await app.inject({ method: "GET", url: `/homes/${homeId}/key/pending`, headers: auth(token) });
    expect(json(after)).toEqual({
      epoch: 1,
      pending: [
        { holderType: "user", holderId: bob.userId, publicKey: b64(32, 6), label: "pending-bob", firstContact: true },
      ],
    });
  });
});

// ======================================================== §10.5 seal authority
describe("seal authority (§10.5 first-contact owner-only)", () => {
  let ownerTok = "";
  let ownerId = "";
  let malloryTok = "";
  let malloryId = "";
  let bobId = "";
  let homeId = "";

  beforeAll(async () => {
    await registerRecorder(4); // keep whatever identity the earlier blocks left (idempotent)
    const owner = await register("authz-owner");
    ownerTok = owner.token;
    ownerId = owner.userId;
    await setKeys(ownerTok);
    homeId = await createHome(ownerTok, "Authority House");
    const { cameraId } = await pairCamera(ownerTok, homeId, "Cam");
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/init`,
      headers: auth(ownerTok),
      payload: {
        keys: [
          { holderType: "user", holderId: ownerId, sealedKey: b64(80, 1) },
          { holderType: "camera", holderId: cameraId, sealedKey: b64(80, 2) },
        ],
      },
    });

    // Mallory: a plain member with a vault. Deliberately NEVER sealed to —
    // membership alone is the poisoning-attack precondition.
    const mallory = await register("authz-mallory");
    malloryTok = mallory.token;
    malloryId = mallory.userId;
    await setKeys(malloryTok, 5);
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/members`,
      headers: auth(ownerTok),
      payload: { identifier: "authz-mallory" },
    });

    // Bob: the victim — a vaulted member awaiting his first (first-contact) grant.
    const bob = await register("authz-bob");
    bobId = bob.userId;
    await setKeys(bob.token, 6);
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/members`,
      headers: auth(ownerTok),
      payload: { identifier: "authz-bob" },
    });
  });

  it("403s a non-owner sealing a first-contact user (poisoning attempt)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key`,
      headers: auth(malloryTok),
      payload: { epoch: 1, keys: [{ holderType: "user", holderId: bobId, sealedKey: b64(80, 66) }] },
    });
    expect(res.statusCode).toBe(403);
    expect((json(res) as { details: { reason: string } }).details.reason).toBe("first_contact_owner_only");
    expect(await prisma.homeKey.count({ where: { homeId, holderType: "user", holderId: bobId } })).toBe(0);
  });

  it("403s a non-owner sealing a first-contact recorder", async () => {
    const identity = await prisma.recorderIdentity.findFirst({ orderBy: { createdAt: "desc" } });
    const res = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key`,
      headers: auth(malloryTok),
      payload: { epoch: 1, keys: [{ holderType: "recorder", holderId: identity!.id, sealedKey: b64(80, 67) }] },
    });
    expect(res.statusCode).toBe(403);
    expect(await prisma.homeKey.count({ where: { homeId, holderType: "recorder" } })).toBe(0);
  });

  it("lets a member seal a first-contact camera they paired, recording sealedBy", async () => {
    const { cameraId: newCam } = await pairCamera(malloryTok, homeId, "Mallory Cam");
    const res = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key`,
      headers: auth(malloryTok),
      payload: { epoch: 1, keys: [{ holderType: "camera", holderId: newCam, sealedKey: b64(80, 68) }] },
    });
    expect(res.statusCode).toBe(204);
    const row = await prisma.homeKey.findFirst({ where: { homeId, holderType: "camera", holderId: newCam } });
    expect(row?.sealedBy).toBe(malloryId);
  });

  it("lets the owner grant first contact; init + grant rows carry sealedBy", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key`,
      headers: auth(ownerTok),
      payload: { epoch: 1, keys: [{ holderType: "user", holderId: bobId, sealedKey: b64(80, 7) }] },
    });
    expect(res.statusCode).toBe(204);
    const grantRow = await prisma.homeKey.findFirst({
      where: { homeId, epoch: 1, holderType: "user", holderId: bobId },
    });
    expect(grantRow?.sealedBy).toBe(ownerId);
    // The activation (key/init) rows are audited too.
    const initRow = await prisma.homeKey.findFirst({
      where: { homeId, epoch: 1, holderType: "user", holderId: ownerId },
    });
    expect(initRow?.sealedBy).toBe(ownerId);
  });

  it("keeps epoch backfill open to any member (holder held a key at a prior epoch)", async () => {
    const rot = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/rotate`,
      headers: auth(ownerTok),
      payload: { fromEpoch: 1, keys: [{ holderType: "user", holderId: ownerId, sealedKey: b64(80, 9) }] },
    });
    expect(rot.statusCode).toBe(200);
    // Bob held an epoch-1 key ⇒ NOT first contact ⇒ mallory may backfill epoch 2.
    const res = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key`,
      headers: auth(malloryTok),
      payload: { epoch: 2, keys: [{ holderType: "user", holderId: bobId, sealedKey: b64(80, 10) }] },
    });
    expect(res.statusCode).toBe(204);
    const row = await prisma.homeKey.findFirst({
      where: { homeId, epoch: 2, holderType: "user", holderId: bobId },
    });
    expect(row?.sealedBy).toBe(malloryId);
  });

  it("records sealedBy on recorder-consent enable", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/recorder-consent`,
      headers: auth(ownerTok),
      payload: { enabled: true, sealedKey: b64(80, 44) },
    });
    expect(res.statusCode).toBe(200);
    const identity = await prisma.recorderIdentity.findFirst({ orderBy: { createdAt: "desc" } });
    const row = await prisma.homeKey.findFirst({
      where: { homeId, holderType: "recorder", holderId: identity!.id },
    });
    expect(row?.sealedBy).toBe(ownerId);
  });
});

// ============================================================ owner key repair
describe("owner key repair (DELETE /homes/:homeId/key/:holderType/:holderId)", () => {
  let ownerTok = "";
  let ownerId = "";
  let bobTok = "";
  let bobId = "";
  let homeId = "";

  beforeAll(async () => {
    const owner = await register("repair-owner");
    ownerTok = owner.token;
    ownerId = owner.userId;
    await setKeys(ownerTok);
    homeId = await createHome(ownerTok, "Repair House");
    const { cameraId } = await pairCamera(ownerTok, homeId, "Cam");
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/init`,
      headers: auth(ownerTok),
      payload: {
        keys: [
          { holderType: "user", holderId: ownerId, sealedKey: b64(80, 1) },
          { holderType: "camera", holderId: cameraId, sealedKey: b64(80, 2) },
        ],
      },
    });

    const bob = await register("repair-bob");
    bobTok = bob.token;
    bobId = bob.userId;
    await setKeys(bobTok, 6);
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/members`,
      headers: auth(ownerTok),
      payload: { identifier: "repair-bob" },
    });
    // Owner grants bob at epoch 1 (the copy we will "repair" away).
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key`,
      headers: auth(ownerTok),
      payload: { epoch: 1, keys: [{ holderType: "user", holderId: bobId, sealedKey: b64(80, 13) }] },
    });
  });

  it("403s a non-owner delete and keeps the row", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/homes/${homeId}/key/user/${bobId}`,
      headers: auth(bobTok),
    });
    expect(res.statusCode).toBe(403);
    expect(await prisma.homeKey.count({ where: { homeId, epoch: 1, holderType: "user", holderId: bobId } })).toBe(1);
  });

  it("owner delete drops the current-epoch row and returns the holder to pending", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/homes/${homeId}/key/user/${bobId}`,
      headers: auth(ownerTok),
    });
    expect(res.statusCode).toBe(204);
    expect(await prisma.homeKey.count({ where: { homeId, holderType: "user", holderId: bobId } })).toBe(0);

    // Bob's ONLY row was the epoch-1 copy, so deleting it returns him to FULL
    // first-contact state (no rows at ANY epoch ⇒ firstContact: true) — which is
    // exactly what locks a non-owner out of immediately re-poisoning the slot.
    const pending = await app.inject({ method: "GET", url: `/homes/${homeId}/key/pending`, headers: auth(ownerTok) });
    const bobPending = (
      json(pending) as { pending: { holderType: string; holderId: string; firstContact: boolean }[] }
    ).pending.find((h) => h.holderType === "user" && h.holderId === bobId);
    expect(bobPending).toBeDefined();
    expect(bobPending?.firstContact).toBe(true);
  });

  it("is idempotent — deleting the already-missing row is still 204", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/homes/${homeId}/key/user/${bobId}`,
      headers: auth(ownerTok),
    });
    expect(res.statusCode).toBe(204);
  });

  it("blocks a non-owner from re-poisoning the freed slot; owner re-grants", async () => {
    // Bob is a plain member; his freed slot is first-contact again ⇒ 403 for him.
    const attack = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key`,
      headers: auth(bobTok),
      payload: { epoch: 1, keys: [{ holderType: "user", holderId: bobId, sealedKey: b64(80, 99) }] },
    });
    expect(attack.statusCode).toBe(403);

    const regrant = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key`,
      headers: auth(ownerTok),
      payload: { epoch: 1, keys: [{ holderType: "user", holderId: bobId, sealedKey: b64(80, 21) }] },
    });
    expect(regrant.statusCode).toBe(204);

    const myKey = await app.inject({ method: "GET", url: `/homes/${homeId}/key`, headers: auth(bobTok) });
    expect(json(myKey)).toEqual({ epoch: 1, sealedKey: b64(80, 21) });
  });

  it("400s an unknown holder type and 409s a not-activated Home", async () => {
    const badType = await app.inject({
      method: "DELETE",
      url: `/homes/${homeId}/key/gremlin/xyz`,
      headers: auth(ownerTok),
    });
    expect(badType.statusCode).toBe(400);

    const plainHome = await createHome(ownerTok, "Repair Plain House");
    const res = await app.inject({
      method: "DELETE",
      url: `/homes/${plainHome}/key/user/${bobId}`,
      headers: auth(ownerTok),
    });
    expect(res.statusCode).toBe(409);
    expect((json(res) as { details: { reason: string } }).details.reason).toBe("not_activated");
  });
});

// =================================================================== key/disable
describe("turning E2EE off (key/disable)", () => {
  let ownerTok = "";
  let ownerId = "";
  let memberTok = "";
  let homeId = "";
  let cameraId = "";
  let deviceSecret = "";

  beforeAll(async () => {
    await registerRecorder(4); // same identity as the block above (idempotent)
    const owner = await register("off-owner");
    ownerTok = owner.token;
    ownerId = owner.userId;
    await setKeys(ownerTok);
    homeId = await createHome(ownerTok, "Off House");
    ({ cameraId, deviceSecret } = await pairCamera(ownerTok, homeId, "Cam"));

    // Activate, rotate once (epoch 2), consent the recorder and record.
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/init`,
      headers: auth(ownerTok),
      payload: {
        keys: [
          { holderType: "user", holderId: ownerId, sealedKey: b64(80, 1) },
          { holderType: "camera", holderId: cameraId, sealedKey: b64(80, 2) },
        ],
      },
    });
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/rotate`,
      headers: auth(ownerTok),
      payload: {
        fromEpoch: 1,
        keys: [
          { holderType: "user", holderId: ownerId, sealedKey: b64(80, 3) },
          { holderType: "camera", holderId: cameraId, sealedKey: b64(80, 4) },
        ],
      },
    });
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/recorder-consent`,
      headers: auth(ownerTok),
      payload: { enabled: true, sealedKey: b64(80, 5) },
    });
    const rec = await app.inject({
      method: "POST",
      url: `/cameras/${cameraId}/recording`,
      headers: auth(ownerTok),
      payload: { enabled: true },
    });
    expect(rec.statusCode).toBe(200);

    const member = await register("off-member");
    memberTok = member.token;
    await setKeys(memberTok, 7);
    await app.inject({
      method: "POST",
      url: `/homes/${homeId}/members`,
      headers: auth(ownerTok),
      payload: { identifier: "off-member" },
    });
  });

  it("403s a non-owner and 409s a Home that isn't encrypted", async () => {
    const asMember = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/disable`,
      headers: auth(memberTok),
    });
    expect(asMember.statusCode).toBe(403);

    const plainHome = await createHome(ownerTok, "Off Plain House");
    const plain = await app.inject({
      method: "POST",
      url: `/homes/${plainHome}/key/disable`,
      headers: auth(ownerTok),
    });
    expect(plain.statusCode).toBe(409);
    expect((json(plain) as { details: { reason: string } }).details.reason).toBe("not_activated");
  });

  it("drops every sealed copy, keeps recording on, and broadcasts rekey epoch 0", async () => {
    broadcasts.length = 0;
    const res = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/disable`,
      headers: auth(ownerTok),
    });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ keyEpoch: 0 });

    const home = await prisma.home.findUnique({ where: { id: homeId }, select: { keyEpoch: true, lastKeyEpoch: true } });
    expect(home).toEqual({ keyEpoch: 0, lastKeyEpoch: 2 });
    expect(await prisma.homeKey.count({ where: { homeId } })).toBe(0);
    const cam = await prisma.camera.findUnique({ where: { id: cameraId }, select: { recordingEnabled: true } });
    expect(cam?.recordingEnabled).toBe(true);

    const homes = await app.inject({ method: "GET", url: "/homes", headers: auth(ownerTok) });
    const dto = (json(homes) as Array<{ id: string; keyEpoch: number; recorderConsented: boolean }>).find(
      (h) => h.id === homeId,
    );
    expect(dto).toMatchObject({ keyEpoch: 0, recorderConsented: false });

    // The camera's next token says "plaintext".
    const camTok = await app.inject({
      method: "POST",
      url: "/rt/token",
      payload: { homeId, role: "camera", deviceSecret },
    });
    expect(json(camTok)).toMatchObject({ keyEpoch: 0, sealedHomeKey: null });

    expect(broadcasts).toEqual([{ homeId, msg: expect.objectContaining({ type: "rekey", epoch: 0 }) }]);

    const again = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/disable`,
      headers: auth(ownerTok),
    });
    expect(again.statusCode).toBe(409);
  });

  it("re-activates past the last epoch, as first contact for every holder", async () => {
    const pending = await app.inject({ method: "GET", url: `/homes/${homeId}/key/pending`, headers: auth(ownerTok) });
    const body = json(pending) as { epoch: number; pending: { holderType: string; firstContact: boolean }[] };
    expect(body.epoch).toBe(0);
    expect(body.pending.length).toBeGreaterThan(0);
    expect(body.pending.every((h) => h.firstContact)).toBe(true);
    expect(body.pending.some((h) => h.holderType === "recorder")).toBe(false);

    const init = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/init`,
      headers: auth(ownerTok),
      payload: {
        keys: [
          { holderType: "user", holderId: ownerId, sealedKey: b64(80, 8) },
          { holderType: "camera", holderId: cameraId, sealedKey: b64(80, 9) },
        ],
      },
    });
    expect(init.statusCode).toBe(200);
    expect(json(init)).toEqual({ keyEpoch: 3 });

    const myKey = await app.inject({ method: "GET", url: `/homes/${homeId}/key`, headers: auth(ownerTok) });
    expect(json(myKey)).toEqual({ epoch: 3, sealedKey: b64(80, 8) });
  });
});
