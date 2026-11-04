/**
 * Unit tests for the segment-tree listing layer (src/lib/recordings.ts):
 * the bounded-concurrency stat sweep, the withBytes opt-out, the day-bucket
 * live listing (listRecentSegments), and the per-camera full-tree listing
 * cache — including the invariant that deleteSegments invalidates it so the
 * UI reflects a deletion immediately.
 *
 * Everything runs against throwaway mkdtemp trees; "now" is injected where the
 * code under test is time-dependent so the midnight-grace behavior is
 * deterministic regardless of when the suite runs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { segmentName } from "@foresight/contract";

// The lib imports src/config.ts, which fails fast on missing env — pin
// deterministic values BEFORE the dynamic import below (dotenv never
// overwrites pre-set values, so a developer .env can't leak in).
process.env.JWT_SECRET = "test-secret";
process.env.LIVEKIT_URL = "ws://localhost:7880";
process.env.LIVEKIT_API_KEY = "devkey";
process.env.LIVEKIT_API_SECRET = "secret";

let lib: typeof import("../src/lib/recordings.js");

const root = mkdtempSync(join(tmpdir(), "foresight-reclib-"));

/** Write one segment file into its UTC YYYY/MM/DD bucket under `dir`. */
function writeSeg(dir: string, epoch: number, bytes: number): void {
  const d = new Date(epoch * 1000);
  const bucket = join(
    dir,
    String(d.getUTCFullYear()),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  );
  mkdirSync(bucket, { recursive: true });
  writeFileSync(join(bucket, segmentName(epoch)), "x".repeat(bytes));
}

beforeAll(async () => {
  lib = await import("../src/lib/recordings.js");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// A fixed, timezone-proof reference instant: 2026-06-15 12:00:00 UTC.
const MIDDAY = Math.floor(Date.UTC(2026, 5, 15, 12, 0, 0) / 1000);

describe("listSegments", () => {
  const dir = join(root, "camA");
  const t0 = MIDDAY;

  it("lists sorted refs with byte sizes and ignores non-segment files", async () => {
    writeSeg(dir, t0 + 12, 300);
    writeSeg(dir, t0, 100);
    writeSeg(dir, t0 + 6, 200);
    // A stray non-segment file must not appear in the listing.
    writeFileSync(join(dir, "2026", "06", "15", "live.m3u8"), "#EXTM3U");

    const refs = await lib.listSegments(dir);
    expect(refs.map((r) => r.epoch)).toEqual([t0, t0 + 6, t0 + 12]);
    expect(refs.map((r) => r.bytes)).toEqual([100, 200, 300]);
  });

  it("skips the stat sweep when withBytes is false", async () => {
    const refs = await lib.listSegments(dir, undefined, undefined, { withBytes: false });
    expect(refs.map((r) => r.epoch)).toEqual([t0, t0 + 6, t0 + 12]);
    expect(refs.every((r) => r.bytes === 0)).toBe(true);
  });

  it("applies inclusive [from,to] bounds", async () => {
    const refs = await lib.listSegments(dir, t0 + 6, t0 + 6);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.epoch).toBe(t0 + 6);
  });

  it("returns [] for a directory that does not exist yet", async () => {
    expect(await lib.listSegments(join(root, "nope"))).toEqual([]);
  });

  it("keeps every ref paired with ITS OWN size across the concurrent stat sweep", async () => {
    // More files than the stat concurrency limit, each with a unique size, so
    // any index/order mix-up between the readdir pass and the worker pool
    // would surface as a mismatched byte count.
    const many = join(root, "camMany");
    const base = MIDDAY - 7 * 86_400;
    for (let i = 0; i < 120; i++) writeSeg(many, base + i * 6, i + 1);

    const refs = await lib.listSegments(many);
    expect(refs).toHaveLength(120);
    for (let i = 0; i < 120; i++) {
      expect(refs[i]!.epoch).toBe(base + i * 6);
      expect(refs[i]!.bytes).toBe(i + 1);
    }
  });
});

describe("listRecentSegments (live-tail day buckets)", () => {
  const dir = join(root, "camB");
  const yesterdayNight = Math.floor(Date.UTC(2026, 5, 14, 23, 59, 54) / 1000);
  const lastWeek = MIDDAY - 7 * 86_400;

  it("lists only the current UTC day bucket in the middle of the day", async () => {
    writeSeg(dir, lastWeek, 10); // old bucket — must never appear
    writeSeg(dir, yesterdayNight, 20); // yesterday's bucket
    writeSeg(dir, MIDDAY - 6, 30);
    writeSeg(dir, MIDDAY, 40);

    const refs = await lib.listRecentSegments(dir, MIDDAY);
    expect(refs.map((r) => r.epoch)).toEqual([MIDDAY - 6, MIDDAY]);
    // Playlists only need epoch + name, so the stat sweep is skipped.
    expect(refs.every((r) => r.bytes === 0)).toBe(true);
  });

  it("also includes the previous day's bucket just after UTC midnight", async () => {
    // 60s past midnight — within PREVIOUS_DAY_GRACE_SECONDS, so a tail that
    // spans midnight (yesterdayNight above) must still be found.
    const justAfterMidnight = Math.floor(Date.UTC(2026, 5, 15, 0, 1, 0) / 1000);
    expect(justAfterMidnight % 86_400).toBeLessThan(lib.PREVIOUS_DAY_GRACE_SECONDS);

    const refs = await lib.listRecentSegments(dir, justAfterMidnight);
    expect(refs.map((r) => r.epoch)).toContain(yesterdayNight);
    expect(refs.map((r) => r.epoch)).not.toContain(lastWeek);
    // Merged across buckets and still sorted oldest-first.
    expect(refs.map((r) => r.epoch)).toEqual([...refs.map((r) => r.epoch)].sort((a, b) => a - b));
  });

  it("drops yesterday's bucket once the grace window has passed", async () => {
    const midMorning = Math.floor(Date.UTC(2026, 5, 15, 9, 0, 0) / 1000);
    const refs = await lib.listRecentSegments(dir, midMorning);
    expect(refs.map((r) => r.epoch)).not.toContain(yesterdayNight);
  });
});

describe("listSegmentsCached + invalidation", () => {
  const dir = join(root, "camC");
  const t0 = MIDDAY - 14 * 86_400;

  it("serves repeat listings from the cache within the TTL", async () => {
    writeSeg(dir, t0, 100);
    writeSeg(dir, t0 + 6, 100);

    const first = await lib.listSegmentsCached(dir);
    expect(first).toHaveLength(2);

    // A file written AFTER the listing must be invisible until the TTL lapses
    // (or the cache is invalidated) — that's the whole point of the cache.
    writeSeg(dir, t0 + 12, 100);
    const second = await lib.listSegmentsCached(dir);
    expect(second).toHaveLength(2);

    // Bounded queries are filtered from the same cached listing.
    const bounded = await lib.listSegmentsCached(dir, t0 + 6);
    expect(bounded.map((r) => r.epoch)).toEqual([t0 + 6]);
  });

  it("invalidateListingCache forces the next listing to re-read the tree", async () => {
    lib.invalidateListingCache(dir);
    const refs = await lib.listSegmentsCached(dir);
    expect(refs).toHaveLength(3);
  });

  it("deleteSegments invalidates so a fresh cache entry reflects the deletion", async () => {
    // Prime the cache, then delete [t0, t0+6) — exactly the first segment.
    await lib.listSegmentsCached(dir);
    const result = await lib.deleteSegments(dir, t0, t0 + 6);
    expect(result).toEqual({ deletedSegments: 1, deletedBytes: 100 });

    // Well inside the 15s TTL, yet the deletion must already be visible.
    const refs = await lib.listSegmentsCached(dir);
    expect(refs.map((r) => r.epoch)).toEqual([t0 + 6, t0 + 12]);
  });
});
