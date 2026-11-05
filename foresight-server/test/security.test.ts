/**
 * Security regression suite for the production-readiness review findings:
 * server admin + registration policy (SEC-01), secret hygiene (SEC-02),
 * revocation + eviction (SEC-03), brute-force limits + revocable sessions
 * (SEC-04), authorization + audit (AUTHZ-01..03), error mapping + races
 * (API-01), webhook ordering (HOOK-01), camera self-unpair (CAM-01), E2EE
 * propagation + vault replacement (E2EE-01..03) and clip limits (REC-06).
 *
 * Unlike the functional suites, registration is NOT forced open and rate
 * limits are ON here — this is the production configuration.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import argon2 from "argon2";
import { AccessToken } from "livekit-server-sdk";
import type { FastifyInstance } from "fastify";
import type { Db } from "../src/db.js";
import { TEST_LIVEKIT_SECRET, TEST_RECORDER_SECRET, applyTestEnv } from "./testEnv.js";

const here = join(fileURLToPath(import.meta.url), "..");
const migrationsDir = join(here, "..", "prisma", "migrations");
const dbDir = mkdtempSync(join(tmpdir(), "foresight-sec-"));
const dbPath = join(dbDir, "test.db");
process.env.DATABASE_URL = `file:${dbPath}`;
applyTestEnv({ open: false, rateLimit: true });
delete process.env.ALLOW_REGISTRATION; // admin-controlled policy
process.env.LIVEKIT_URL = "ws://localhost:7880";
process.env.LIVEKIT_PUBLIC_URL = "ws://localhost:7880";
process.env.RECORDER_SHARED_SECRET = TEST_RECORDER_SECRET;
// Nothing listens here: recorder control calls fail fast and are tolerated.
process.env.RECORDER_URL = "http://127.0.0.1:9";
process.env.RECORDINGS_DIR = mkdtempSync(join(tmpdir(), "foresight-sec-rec-"));
{
  const db = new DatabaseSync(dbPath);
  for (const name of readdirSync(migrationsDir).filter((n) => /^\d+_/.test(n)).sort()) {
    db.exec(readFileSync(join(migrationsDir, name, "migration.sql"), "utf8"));
  }
  db.close();
}

// Record SFU side effects instead of calling LiveKit.
const sfu = vi.hoisted(() => ({
  broadcasts: [] as Array<{ homeId: string; msg: { type: string; epoch?: number } }>,
  evictedUsers: [] as Array<{ homeId: string; userId: string }>,
  evictedCameras: [] as Array<{ homeId: string; cameraId: string }>,
  closedRooms: [] as string[],
}));
vi.mock("../src/livekit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/livekit.js")>()),
  broadcastToHome: async (homeId: string, msg: { type: string; epoch?: number }) => {
    sfu.broadcasts.push({ homeId, msg });
  },
  evictUser: async (homeId: string, userId: string) => {
    sfu.evictedUsers.push({ homeId, userId });
    return 1;
  },
  evictCamera: async (homeId: string, cameraId: string) => {
    sfu.evictedCameras.push({ homeId, cameraId });
  },
  closeHomeRoom: async (homeId: string) => {
    sfu.closedRooms.push(homeId);
  },
}));

let app: FastifyInstance;
let internal: FastifyInstance;
let prisma: Db;
let limits: typeof import("../src/lib/rateLimit.js").limits;

beforeAll(async () => {
  prisma = (await import("../src/db.js")).prisma;
  limits = (await import("../src/lib/rateLimit.js")).limits;
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

/** Fresh limiter budgets per test (the rate-limit tests exhaust them on purpose). */
beforeEach(() => {
  for (const l of Object.values(limits)) l.clear();
});

const json = <T = Record<string, unknown>>(res: { json: () => unknown }) => res.json() as T;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const b64 = (bytes: number, fill = 1) => Buffer.alloc(bytes, fill).toString("base64");
const caps = { lenses: [1], maxDigitalZoom: 4, torch: true, maxResolution: { width: 1, height: 1 }, supportsAudio: true };

let admin = { token: "", id: "" };

async function register(identifier: string, password = "pw") {
  return app.inject({ method: "POST", url: "/auth/register", payload: { identifier, password } });
}

async function newUser(identifier: string): Promise<{ token: string; id: string }> {
  const res = await register(identifier);
  expect(res.statusCode).toBe(201);
  const body = json<{ token: string; user: { id: string } }>(res);
  return { token: body.token, id: body.user.id };
}

async function createHome(token: string, name = "House"): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/homes", headers: auth(token), payload: { name } });
  return json<{ id: string }>(res).id;
}

async function addMember(ownerToken: string, homeId: string, identifier: string, role?: string) {
  return app.inject({
    method: "POST",
    url: `/homes/${homeId}/members`,
    headers: auth(ownerToken),
    payload: role ? { identifier, role } : { identifier },
  });
}

async function pairCamera(token: string, homeId: string, name = "Cam") {
  const pair = await app.inject({ method: "POST", url: `/homes/${homeId}/cameras/pair`, headers: auth(token) });
  const ticket = json<{ token: string; serverUrl: string }>(pair);
  const claim = await app.inject({
    method: "POST",
    url: "/pair/claim",
    payload: { token: ticket.token, name, cameraPublicKey: b64(32, 9), capabilities: caps },
  });
  const body = json<{ camera: { id: string }; deviceSecret: string }>(claim);
  return { cameraId: body.camera.id, deviceSecret: body.deviceSecret, serverUrl: ticket.serverUrl };
}

// ================================================================== SEC-01
describe("SEC-01 server admin + registration policy", () => {
  it("makes the first account the admin and closes registration after it", async () => {
    const first = await register("admin@example.com");
    expect(first.statusCode).toBe(201);
    const body = json<{ token: string; user: { id: string; isAdmin: boolean } }>(first);
    expect(body.user.isAdmin).toBe(true);
    admin = { token: body.token, id: body.user.id };

    const second = await register("stranger");
    expect(second.statusCode).toBe(403);
    expect(json<{ details: { reason: string } }>(second).details.reason).toBe("registration_closed");
  });

  it("lets only the admin open registration", async () => {
    const open = await app.inject({
      method: "PUT",
      url: "/settings",
      headers: auth(admin.token),
      payload: { registrationOpen: true },
    });
    expect(open.statusCode).toBe(200);
    expect(json<{ registrationOpen: boolean; editable: boolean }>(open)).toMatchObject({
      registrationOpen: true,
      editable: true,
    });

    const member = await newUser("member1");
    const denied = await app.inject({
      method: "PUT",
      url: "/settings",
      headers: auth(member.token),
      payload: { registrationOpen: false, pairingServerUrl: "http://attacker:3199" },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("embeds only the admin-configured pairing URL, whoever creates the ticket", async () => {
    await app.inject({
      method: "PUT",
      url: "/settings",
      headers: auth(admin.token),
      payload: { pairingServerUrl: "https://cams.example.com" },
    });
    const owner = await newUser("sec01-owner");
    const homeId = await createHome(owner.token);
    const { serverUrl } = await pairCamera(owner.token, homeId);
    expect(serverUrl).toBe("https://cams.example.com");
    await app.inject({ method: "PUT", url: "/settings", headers: auth(admin.token), payload: { pairingServerUrl: null } });
  });

  it("audits server-setting changes", async () => {
    const rows = await prisma.auditEvent.findMany({ where: { homeId: null, action: "settings.updated" } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.actorId === admin.id)).toBe(true);
  });
});

// ================================================================== SEC-02
describe("SEC-02 secret hygiene", () => {
  it("refuses placeholder and short secrets unless insecure dev mode is on", async () => {
    const { checkSecret, secretProblem } = await import("../src/lib/secrets.js");
    for (const bad of ["secret", "devkey", "change-me-to-a-long-random-string", "change-me-recorder-secret", "short"]) {
      expect(secretProblem(bad)).not.toBeNull();
      expect(() => checkSecret("X", bad, {})).toThrow(/openssl rand/);
      expect(checkSecret("X", bad, { FORESIGHT_INSECURE_DEV: "1" })).toMatch(/X/);
    }
    expect(secretProblem("a".repeat(31))).not.toBeNull();
    expect(secretProblem(TEST_LIVEKIT_SECRET)).toBeNull();
  });

  it("compares shared secrets in constant time and length-independently", async () => {
    const { secretsEqual } = await import("../src/lib/secrets.js");
    expect(secretsEqual(TEST_RECORDER_SECRET, TEST_RECORDER_SECRET)).toBe(true);
    expect(secretsEqual("x", TEST_RECORDER_SECRET)).toBe(false);
    expect(secretsEqual(undefined, TEST_RECORDER_SECRET)).toBe(false);
    expect(secretsEqual(["a"], TEST_RECORDER_SECRET)).toBe(false);
  });
});

// ================================================================== SEC-04
describe("SEC-04 brute force + revocable sessions", () => {
  it("refuses the 6th failed login for an account within a minute", async () => {
    await newUser("victim");
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "POST", url: "/auth/login", payload: { identifier: "victim", password: `bad${i}` } });
      expect(res.statusCode).toBe(401);
    }
    const sixth = await app.inject({ method: "POST", url: "/auth/login", payload: { identifier: "victim", password: "pw" } });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers["retry-after"]).toBeDefined();
  });

  it("authenticates cameras with one indexed lookup and no argon2", async () => {
    const owner = await newUser("sec04-owner");
    const homeId = await createHome(owner.token);
    const cams = [await pairCamera(owner.token, homeId, "A"), await pairCamera(owner.token, homeId, "B")];
    const spy = vi.spyOn(argon2, "verify");
    const ok = await app.inject({ method: "POST", url: "/rt/token", payload: { homeId, role: "camera", deviceSecret: cams[1]!.deviceSecret } });
    expect(ok.statusCode).toBe(200);
    expect(json<{ identity: string }>(ok).identity).toBe(`camera:${cams[1]!.cameraId}`);
    const bad = await app.inject({ method: "POST", url: "/rt/token", payload: { homeId, role: "camera", deviceSecret: "f".repeat(64) } });
    expect(bad.statusCode).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("upgrades a legacy (argon2-only) camera to the indexed lookup on first use", async () => {
    const owner = await newUser("legacy-owner");
    const homeId = await createHome(owner.token);
    const cam = await pairCamera(owner.token, homeId);
    await prisma.camera.update({ where: { id: cam.cameraId }, data: { deviceSecretSha256: null } });
    const spy = vi.spyOn(argon2, "verify");
    const res = await app.inject({ method: "POST", url: "/rt/token", payload: { homeId, role: "camera", deviceSecret: cam.deviceSecret } });
    expect(res.statusCode).toBe(200);
    // The legacy path DOES use argon2 (proves the spy in the test above is live).
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    const row = await prisma.camera.findUnique({ where: { id: cam.cameraId } });
    expect(row?.deviceSecretSha256).toBe(createHash("sha256").update(cam.deviceSecret).digest("hex"));
  });

  it("rejects every older session after logout-everywhere", async () => {
    const u = await newUser("logout-all");
    const res = await app.inject({ method: "POST", url: "/auth/logout-all", headers: auth(u.token) });
    expect(res.statusCode).toBe(200);
    const fresh = json<{ token: string }>(res).token;
    expect((await app.inject({ method: "GET", url: "/homes", headers: auth(u.token) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/homes", headers: auth(fresh) })).statusCode).toBe(200);
  });

  it("changes the password, requires the re-wrapped vault, and revokes old sessions", async () => {
    const u = await newUser("pw-change");
    const vault = { publicKey: b64(32, 3), wrappedPrivateKey: b64(48, 3), nonce: b64(24, 3), kdf: { algo: "argon2id", opslimit: 3, memlimit: 67108864, saltB64: b64(16, 3) } };
    await app.inject({ method: "POST", url: "/me/keys", headers: auth(u.token), payload: vault });

    const wrong = await app.inject({ method: "POST", url: "/me/password", headers: auth(u.token), payload: { currentPassword: "nope", newPassword: "new", keyVault: vault } });
    expect(wrong.statusCode).toBe(401);
    const noVault = await app.inject({ method: "POST", url: "/me/password", headers: auth(u.token), payload: { currentPassword: "pw", newPassword: "new" } });
    expect(noVault.statusCode).toBe(400);
    const swapped = await app.inject({ method: "POST", url: "/me/password", headers: auth(u.token), payload: { currentPassword: "pw", newPassword: "new", keyVault: { ...vault, publicKey: b64(32, 4) } } });
    expect(swapped.statusCode).toBe(409);

    const rewrapped = { ...vault, wrappedPrivateKey: b64(48, 5), nonce: b64(24, 5) };
    const ok = await app.inject({ method: "POST", url: "/me/password", headers: auth(u.token), payload: { currentPassword: "pw", newPassword: "new", keyVault: rewrapped } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/me/keys", headers: auth(u.token) })).statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { identifier: "pw-change", password: "new" } });
    expect(login.statusCode).toBe(200);
    expect(json<{ keyVault: { wrappedPrivateKey: string } }>(login).keyVault.wrappedPrivateKey).toBe(rewrapped.wrappedPrivateKey);
  });

  it("does not accept a scoped clip-download token as a session", async () => {
    const u = await newUser("scoped");
    const forged = jwt.sign({ sub: u.id, tv: 0, typ: "clip" }, process.env.JWT_SECRET!);
    expect((await app.inject({ method: "GET", url: "/homes", headers: auth(forged) })).statusCode).toBe(401);
  });
});

// ============================================================ SEC-03 / AUTHZ
describe("SEC-03 revocation + AUTHZ-01/02 owner rules", () => {
  let owner: { token: string; id: string };
  let member: { token: string; id: string };
  let homeId: string;
  let cam: { cameraId: string; deviceSecret: string };

  it("sets up a shared Home", async () => {
    owner = await newUser("rev-owner");
    member = await newUser("rev-member");
    homeId = await createHome(owner.token);
    expect((await addMember(owner.token, homeId, "rev-member")).statusCode).toBe(200);
    cam = await pairCamera(member.token, homeId, "Porch");
  });

  it("AUTHZ-01: members cannot delete cameras, disable recording or delete footage", async () => {
    await app.inject({ method: "POST", url: `/cameras/${cam.cameraId}/recording`, headers: auth(member.token), payload: { enabled: true } });
    const off = await app.inject({ method: "POST", url: `/cameras/${cam.cameraId}/recording`, headers: auth(member.token), payload: { enabled: false } });
    expect(off.statusCode).toBe(403);
    const delFootage = await app.inject({ method: "DELETE", url: `/cameras/${cam.cameraId}/recordings?from=1&to=2`, headers: auth(member.token) });
    expect(delFootage.statusCode).toBe(403);
    const delCam = await app.inject({ method: "DELETE", url: `/cameras/${cam.cameraId}`, headers: auth(member.token) });
    expect(delCam.statusCode).toBe(403);
    const audit = await app.inject({ method: "GET", url: `/homes/${homeId}/audit`, headers: auth(member.token) });
    expect(audit.statusCode).toBe(403);
  });

  it("AUTHZ-01: owners can, and every action lands in the audit trail", async () => {
    const off = await app.inject({ method: "POST", url: `/cameras/${cam.cameraId}/recording`, headers: auth(owner.token), payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    const delFootage = await app.inject({ method: "DELETE", url: `/cameras/${cam.cameraId}/recordings?from=1&to=2`, headers: auth(owner.token) });
    expect(delFootage.statusCode).toBe(200);
    const res = await app.inject({ method: "GET", url: `/homes/${homeId}/audit`, headers: auth(owner.token) });
    expect(res.statusCode).toBe(200);
    const actions = json<{ events: Array<{ action: string; actorLabel: string }> }>(res).events.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["member.added", "camera.paired", "recording.enabled", "recording.disabled", "recordings.deleted"]),
    );
  });

  it("AUTHZ-02: an owner re-adding themselves or another owner never demotes anyone", async () => {
    const self = await addMember(owner.token, homeId, "rev-owner");
    expect(self.statusCode).toBe(400);
    expect((await addMember(owner.token, homeId, "rev-member", "owner")).statusCode).toBe(200);
    // Re-adding an existing owner with no explicit role leaves the role alone.
    expect((await addMember(owner.token, homeId, "rev-member")).statusCode).toBe(200);
    const m = await prisma.homeMember.findUnique({ where: { userId_homeId: { userId: member.id, homeId } } });
    expect(m?.role).toBe("owner");
    // Back to member for the rest of the suite.
    const demote = await app.inject({ method: "PATCH", url: `/homes/${homeId}/members/${member.id}`, headers: auth(owner.token), payload: { role: "member" } });
    expect(demote.statusCode).toBe(200);
  });

  it("AUTHZ-02: the last owner can be neither demoted nor removed", async () => {
    const demote = await app.inject({ method: "PATCH", url: `/homes/${homeId}/members/${owner.id}`, headers: auth(owner.token), payload: { role: "member" } });
    expect(demote.statusCode).toBe(409);
    const leave = await app.inject({ method: "DELETE", url: `/homes/${homeId}/members/${owner.id}`, headers: auth(owner.token) });
    expect(leave.statusCode).toBe(409);
    expect(json<{ details: { reason: string } }>(leave).details.reason).toBe("last_owner");
  });

  it("SEC-03: removing a member revokes REST access and evicts their live sessions", async () => {
    sfu.evictedUsers.length = 0;
    const del = await app.inject({ method: "DELETE", url: `/homes/${homeId}/members/${member.id}`, headers: auth(owner.token) });
    expect(del.statusCode).toBe(204);
    expect(sfu.evictedUsers).toEqual([{ homeId, userId: member.id }]);
    const rt = await app.inject({ method: "POST", url: "/rt/token", headers: auth(member.token), payload: { homeId, role: "viewer" } });
    expect(rt.statusCode).toBe(403);
    const key = await app.inject({ method: "GET", url: `/homes/${homeId}/key`, headers: auth(member.token) });
    expect(key.statusCode).toBe(403);
  });

  it("SEC-03: a member may leave on their own", async () => {
    const leaver = await newUser("leaver");
    await addMember(owner.token, homeId, "leaver");
    const res = await app.inject({ method: "DELETE", url: `/homes/${homeId}/members/${leaver.id}`, headers: auth(leaver.token) });
    expect(res.statusCode).toBe(204);
  });

  it("SEC-03: deleting a camera evicts it; deleting a Home closes its room", async () => {
    sfu.evictedCameras.length = 0;
    sfu.closedRooms.length = 0;
    const del = await app.inject({ method: "DELETE", url: `/cameras/${cam.cameraId}`, headers: auth(owner.token) });
    expect(del.statusCode).toBe(204);
    expect(sfu.evictedCameras).toEqual([{ homeId, cameraId: cam.cameraId }]);
    const home = await app.inject({ method: "DELETE", url: `/homes/${homeId}`, headers: auth(owner.token) });
    expect(home.statusCode).toBe(204);
    expect(sfu.closedRooms).toEqual([homeId]);
  });

  it("SEC-03: deleting an account evicts it from every surviving Home and flags E2EE rotation", async () => {
    const o = await newUser("acct-owner");
    const gone = await newUser("acct-gone");
    const h = await createHome(o.token);
    await addMember(o.token, h, "acct-gone");
    await prisma.home.update({ where: { id: h }, data: { keyEpoch: 1, lastKeyEpoch: 0 } });
    sfu.evictedUsers.length = 0;
    const res = await app.inject({ method: "DELETE", url: "/me", headers: auth(gone.token) });
    expect(res.statusCode).toBe(204);
    expect(sfu.evictedUsers).toEqual([{ homeId: h, userId: gone.id }]);
    const homes = json<Array<{ id: string; keyRotationRequired: boolean }>>(
      await app.inject({ method: "GET", url: "/homes", headers: auth(o.token) }),
    );
    expect(homes.find((x) => x.id === h)?.keyRotationRequired).toBe(true);
  });
});

// ================================================================= AUTHZ-03
describe("AUTHZ-03 narrow LiveKit grants", () => {
  it("lets viewers publish only microphone and cameras only camera + microphone", async () => {
    const o = await newUser("grants-owner");
    const h = await createHome(o.token);
    const cam = await pairCamera(o.token, h);
    const viewer = json<{ token: string }>(
      await app.inject({ method: "POST", url: "/rt/token", headers: auth(o.token), payload: { homeId: h, role: "viewer" } }),
    );
    const camera = json<{ token: string }>(
      await app.inject({ method: "POST", url: "/rt/token", payload: { homeId: h, role: "camera", deviceSecret: cam.deviceSecret } }),
    );
    const vg = (jwt.verify(viewer.token, TEST_LIVEKIT_SECRET) as { video: { canPublishSources: string[] } }).video;
    const cg = (jwt.verify(camera.token, TEST_LIVEKIT_SECRET) as { video: { canPublishSources: string[] } }).video;
    expect(vg.canPublishSources).toEqual(["microphone"]);
    expect(cg.canPublishSources).toEqual(["camera", "microphone"]);
  });
});

// =================================================================== API-01
describe("API-01 error mapping + races", () => {
  it("maps framework 4xx errors instead of returning 500", async () => {
    const big = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ identifier: "x", password: "y".repeat(1_100_000) }),
    });
    expect(big.statusCode).toBe(413);
    const malformed = await app.inject({ method: "POST", url: "/auth/login", headers: { "content-type": "application/json" }, payload: "{nope" });
    expect(malformed.statusCode).toBe(400);
    const wrongType = await app.inject({ method: "POST", url: "/auth/login", headers: { "content-type": "application/xml" }, payload: "<a/>" });
    expect(wrongType.statusCode).toBe(415);
  });

  it("turns a parallel duplicate registration into one 201 and one 409", async () => {
    const [a, b] = await Promise.all([register("racer"), register("racer")]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
  });

  it("lets exactly one of two parallel claims of a pairing code create a camera", async () => {
    const o = await newUser("claim-race");
    const h = await createHome(o.token);
    const pair = json<{ token: string }>(await app.inject({ method: "POST", url: `/homes/${h}/cameras/pair`, headers: auth(o.token) }));
    const claim = () =>
      app.inject({ method: "POST", url: "/pair/claim", payload: { token: pair.token, name: "X", cameraPublicKey: b64(32, 9), capabilities: caps } });
    const results = await Promise.all([claim(), claim()]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 400]);
    expect(await prisma.camera.count({ where: { homeId: h } })).toBe(1);
  });

  it("caps name lengths", async () => {
    const o = await newUser("lengths");
    const res = await app.inject({ method: "POST", url: "/homes", headers: auth(o.token), payload: { name: "x".repeat(65) } });
    expect(res.statusCode).toBe(400);
  });
});

// ================================================================== HOOK-01
describe("HOOK-01 webhook ordering", () => {
  async function webhook(event: string, identity: string, sid: string) {
    const body = JSON.stringify({ event, id: `EV_${Math.random()}`, room: { name: "r" }, participant: { sid, identity } });
    const at = new AccessToken("test-key", TEST_LIVEKIT_SECRET);
    at.sha256 = createHash("sha256").update(body).digest("base64");
    return app.inject({
      method: "POST",
      url: "/webhooks/livekit",
      headers: { "content-type": "application/webhook+json", authorization: await at.toJwt() },
      payload: body,
    });
  }

  it("ignores a late participant_left from a superseded session", async () => {
    const o = await newUser("hook-owner");
    const h = await createHome(o.token);
    const cam = await pairCamera(o.token, h);
    expect((await webhook("participant_joined", `camera:${cam.cameraId}`, "PA_old")).statusCode).toBe(200);
    expect((await webhook("participant_joined", `camera:${cam.cameraId}`, "PA_new")).statusCode).toBe(200);
    await webhook("participant_left", `camera:${cam.cameraId}`, "PA_old");
    expect((await prisma.camera.findUnique({ where: { id: cam.cameraId } }))?.online).toBe(true);
    await webhook("participant_left", `camera:${cam.cameraId}`, "PA_new");
    expect((await prisma.camera.findUnique({ where: { id: cam.cameraId } }))?.online).toBe(false);
  });
});

// =================================================================== CAM-01
describe("CAM-01 camera self-unpair", () => {
  it("removes the camera from the server when the phone unpairs", async () => {
    const o = await newUser("unpair-owner");
    const h = await createHome(o.token);
    const cam = await pairCamera(o.token, h);
    const bad = await app.inject({ method: "POST", url: `/cameras/${cam.cameraId}/unpair`, payload: { deviceSecret: "0".repeat(64) } });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: `/cameras/${cam.cameraId}/unpair`, payload: { deviceSecret: cam.deviceSecret } });
    expect(ok.statusCode).toBe(204);
    const list = json<unknown[]>(await app.inject({ method: "GET", url: `/homes/${h}/cameras`, headers: auth(o.token) }));
    expect(list).toHaveLength(0);
    const again = await app.inject({ method: "POST", url: `/cameras/${cam.cameraId}/unpair`, payload: { deviceSecret: cam.deviceSecret } });
    expect(again.statusCode).toBe(404);
  });
});

// ============================================================== E2EE-01..03
describe("E2EE propagation, rotation and vault replacement", () => {
  const vault = (fill: number) => ({
    publicKey: b64(32, fill),
    wrappedPrivateKey: b64(48, fill),
    nonce: b64(24, fill),
    kdf: { algo: "argon2id", opslimit: 3, memlimit: 67108864, saltB64: b64(16, fill) },
  });

  it("E2EE-02: replacing an existing vault needs the account password", async () => {
    const u = await newUser("vault-user");
    expect((await app.inject({ method: "POST", url: "/me/keys", headers: auth(u.token), payload: vault(1) })).statusCode).toBe(204);
    // Idempotent re-post of the same vault.
    expect((await app.inject({ method: "POST", url: "/me/keys", headers: auth(u.token), payload: vault(1) })).statusCode).toBe(204);
    const swap = await app.inject({ method: "POST", url: "/me/keys", headers: auth(u.token), payload: vault(2) });
    expect(swap.statusCode).toBe(409);
    expect(json<{ details: { reason: string } }>(swap).details.reason).toBe("vault_exists");
    const wrong = await app.inject({ method: "POST", url: "/me/keys", headers: auth(u.token), payload: { ...vault(2), currentPassword: "nope" } });
    expect(wrong.statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/me/keys", headers: auth(u.token), payload: { ...vault(2), currentPassword: "pw" } });
    expect(ok.statusCode).toBe(204);
  });

  let owner: { token: string; id: string };
  let homeId: string;
  let cameraId: string;

  it("E2EE-01: activation broadcasts rekey to the room from the server", async () => {
    owner = await newUser("e2ee-owner");
    await app.inject({ method: "POST", url: "/me/keys", headers: auth(owner.token), payload: vault(7) });
    homeId = await createHome(owner.token);
    cameraId = (await pairCamera(owner.token, homeId)).cameraId;
    sfu.broadcasts.length = 0;
    const init = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/init`,
      headers: auth(owner.token),
      payload: {
        keys: [
          { holderType: "user", holderId: owner.id, sealedKey: b64(80, 1) },
          { holderType: "camera", holderId: cameraId, sealedKey: b64(80, 2) },
        ],
      },
    });
    expect(init.statusCode).toBe(200);
    expect(sfu.broadcasts).toEqual([{ homeId, msg: expect.objectContaining({ type: "rekey", epoch: 1 }) }]);
  });

  it("E2EE-03: rotating with recorder consent must include the recorder's copy, and broadcasts", async () => {
    await internal.inject({
      method: "POST",
      url: "/internal/recorder-identity",
      headers: { "x-recorder-secret": TEST_RECORDER_SECRET },
      payload: { publicKey: b64(32, 50) },
    });
    const recorder = await prisma.recorderIdentity.findFirst();
    await app.inject({ method: "POST", url: `/homes/${homeId}/recorder-consent`, headers: auth(owner.token), payload: { enabled: true, sealedKey: b64(80, 3) } });
    const base = [
      { holderType: "user", holderId: owner.id, sealedKey: b64(80, 4) },
      { holderType: "camera", holderId: cameraId, sealedKey: b64(80, 5) },
    ];
    const missing = await app.inject({ method: "POST", url: `/homes/${homeId}/key/rotate`, headers: auth(owner.token), payload: { fromEpoch: 1, keys: base } });
    expect(missing.statusCode).toBe(409);
    expect(json<{ details: { reason: string } }>(missing).details.reason).toBe("recorder_key_required");

    sfu.broadcasts.length = 0;
    const ok = await app.inject({
      method: "POST",
      url: `/homes/${homeId}/key/rotate`,
      headers: auth(owner.token),
      payload: { fromEpoch: 1, keys: [...base, { holderType: "recorder", holderId: recorder!.id, sealedKey: b64(80, 6) }] },
    });
    expect(ok.statusCode).toBe(200);
    expect(sfu.broadcasts).toEqual([{ homeId, msg: expect.objectContaining({ type: "rekey", epoch: 2 }) }]);

    // The rotation-target list carries every holder, incl. the consented recorder.
    const holders = json<{ epoch: number; pending: Array<{ holderType: string }> }>(
      await app.inject({ method: "GET", url: `/homes/${homeId}/key/holders`, headers: auth(owner.token) }),
    );
    expect(holders.epoch).toBe(2);
    expect(holders.pending.map((h) => h.holderType).sort()).toEqual(["camera", "recorder", "user"]);

    // Recording enabled → the Home shows up in the reconcile, keyed, never "revoked".
    await app.inject({ method: "POST", url: `/cameras/${cameraId}/recording`, headers: auth(owner.token), payload: { enabled: true } });
    const rec = json<{ homeKeys: Array<{ homeId: string; epoch: number; sealedHmk: string | null; revoked: boolean }> }>(
      await internal.inject({ method: "GET", url: "/internal/recording-cameras", headers: { "x-recorder-secret": TEST_RECORDER_SECRET } }),
    );
    expect(rec.homeKeys.find((h) => h.homeId === homeId)).toEqual({ homeId, epoch: 2, sealedHmk: b64(80, 6), revoked: false });
  });

  it("E2EE-03: only an explicit consent revocation reports revoked", async () => {
    const off = await app.inject({ method: "POST", url: `/homes/${homeId}/recorder-consent`, headers: auth(owner.token), payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    // Re-enable recording without consent is refused, so force the row back to
    // check the reconcile classification directly.
    await prisma.camera.update({ where: { id: cameraId }, data: { recordingEnabled: true } });
    const rec = json<{ homeKeys: Array<{ homeId: string; revoked: boolean }> }>(
      await internal.inject({ method: "GET", url: "/internal/recording-cameras", headers: { "x-recorder-secret": TEST_RECORDER_SECRET } }),
    );
    expect(rec.homeKeys.find((h) => h.homeId === homeId)?.revoked).toBe(true);
  });
});

// =================================================================== REC-06
describe("REC-06 clip export limits", () => {
  it("rejects over-long ranges and signs range-scoped download URLs", async () => {
    const o = await newUser("clip-owner");
    const h = await createHome(o.token);
    const cam = await pairCamera(o.token, h);
    const tooLong = await app.inject({ method: "POST", url: `/recordings/${cam.cameraId}/clip-url?from=0&to=${3 * 3600}`, headers: auth(o.token) });
    expect(tooLong.statusCode).toBe(400);
    const res = await app.inject({ method: "POST", url: `/recordings/${cam.cameraId}/clip-url?from=1000&to=1060`, headers: auth(o.token) });
    expect(res.statusCode).toBe(200);
    const { url } = json<{ url: string }>(res);
    // No footage exists, but the signed URL authenticates (404, not 401) …
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    // … and only for exactly that range.
    const tampered = url.replace("to=1060", "to=1070");
    expect((await app.inject({ method: "GET", url: tampered })).statusCode).toBe(401);
  });

  it("refuses a second concurrent export for the same user", async () => {
    const { acquireClipSlot } = await import("../src/routes/recordings.js");
    const release = acquireClipSlot("u1");
    expect(() => acquireClipSlot("u1")).toThrow(/still running/);
    release();
    acquireClipSlot("u1")();
  });
});

// =================================================================== SEC-05
describe("SEC-05 headers + CORS", () => {
  it("sends baseline security headers and only reflects allowed origins", async () => {
    const res = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example" } });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    const dev = await app.inject({ method: "GET", url: "/health", headers: { origin: "http://localhost:5173" } });
    expect(dev.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });
});
