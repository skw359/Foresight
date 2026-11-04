/**
 * Integration tests for segment consolidation (storage/consolidate.ts), the
 * retention runner's day-file handling (storage/retention.ts), and the
 * catalog's index/loose merge (storage/catalog.ts). Everything runs against a
 * real tmp-dir tree with DISTINCT byte content per fake segment so
 * concatenation correctness is asserted byte-for-byte.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dayFileName,
  dayIndexFileName,
  isDayIndex,
  segmentName,
  utcDayStamp,
  type DayIndex,
} from "@foresight/contract";

// consolidate.ts / retention.ts / catalog.ts read config at import time; give
// them a test double so no .env is needed and recordingsDir points at a fresh
// tmp tree per test.
const testConfig = vi.hoisted(() => ({ recordingsDir: "" }));
vi.mock("../src/config.js", () => ({
  config: {
    get recordingsDir() {
      return testConfig.recordingsDir;
    },
    retentionDays: 14,
    retentionMaxGb: 1_000_000, // effectively no disk cap
    minFreeGb: 0, // never free-space prune
    retentionIntervalMs: 600_000,
    consolidateEnabled: true,
    consolidateIntervalMs: 3_600_000,
    segmentSeconds: 6,
  },
}));

import { consolidateOnce } from "../src/storage/consolidate.js";
import { runRetention } from "../src/storage/retention.js";
import { listCameraSegments } from "../src/storage/catalog.js";

/** 2026-01-15T00:00:00Z — a fully elapsed UTC day for most tests. */
const DAY = "20260115";
const DAY_EPOCH = Date.UTC(2026, 0, 15) / 1000;
/** Injected "now": two days after DAY, mid-day UTC. */
const NOW_MS = Date.UTC(2026, 0, 17, 12, 0, 0);

const HOME = "home1";
const CAM = "cam1";
const NOTHING = { daysConsolidated: 0, segmentsRemoved: 0, bytesConsolidated: 0 };

beforeEach(async () => {
  testConfig.recordingsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "foresight-consolidate-"));
});

afterEach(async () => {
  await fsp.rm(testConfig.recordingsDir, { recursive: true, force: true });
});

/** Bucket dir for an epoch's own UTC day (layout: <home>/<cam>/YYYY/MM/DD). */
function bucketDirFor(epoch: number, home = HOME, cam = CAM): string {
  const stamp = utcDayStamp(epoch);
  return path.join(
    testConfig.recordingsDir,
    home,
    cam,
    stamp.slice(0, 4),
    stamp.slice(4, 6),
    stamp.slice(6, 8),
  );
}

/** Write a fake segment; dir defaults to the epoch's own bucket. */
async function writeSeg(epoch: number, content: string, dir = bucketDirFor(epoch)): Promise<string> {
  await fsp.mkdir(dir, { recursive: true });
  const p = path.join(dir, segmentName(epoch));
  await fsp.writeFile(p, content);
  return p;
}

async function names(dir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(dir)).sort();
  } catch {
    return [];
  }
}

const exists = (p: string): Promise<boolean> =>
  fsp.access(p).then(
    () => true,
    () => false,
  );

describe("consolidateOnce", () => {
  it("concatenates a finished day byte-for-byte, writes a valid index, deletes sources", async () => {
    await writeSeg(DAY_EPOCH, "AAAAAAAAAA"); // 10 bytes
    await writeSeg(DAY_EPOCH + 6, "BBBBBBBBBBBB"); // 12 bytes
    await writeSeg(DAY_EPOCH + 12, "CCCCCCCC"); // 8 bytes

    const res = await consolidateOnce(NOW_MS);
    expect(res).toEqual({ daysConsolidated: 1, segmentsRemoved: 3, bytesConsolidated: 30 });

    const dir = bucketDirFor(DAY_EPOCH);
    const day = await fsp.readFile(path.join(dir, dayFileName(DAY)));
    expect(day.toString()).toBe("AAAAAAAAAA" + "BBBBBBBBBBBB" + "CCCCCCCC");

    const parsed: unknown = JSON.parse(
      await fsp.readFile(path.join(dir, dayIndexFileName(DAY)), "utf8"),
    );
    expect(isDayIndex(parsed)).toBe(true);
    const index = parsed as DayIndex;
    expect(index.day).toBe(DAY);
    expect(index.file).toBe(dayFileName(DAY));
    expect(index.totalBytes).toBe(30);
    expect(index.segments).toEqual([
      { epoch: DAY_EPOCH, offset: 0, bytes: 10, duration: 6 },
      { epoch: DAY_EPOCH + 6, offset: 10, bytes: 12, duration: 6 },
      { epoch: DAY_EPOCH + 12, offset: 22, bytes: 8, duration: 6 },
    ]);

    // Sources gone — only the day pair remains, no tmp litter.
    expect(await names(dir)).toEqual([dayIndexFileName(DAY), dayFileName(DAY)].sort());

    // The catalog now serves the day out of the index (byte windows attached).
    const refs = await listCameraSegments(HOME, CAM);
    expect(refs.map((r) => [r.epoch, r.bytes, r.byteRange?.offset, r.container])).toEqual([
      [DAY_EPOCH, 10, 0, dayFileName(DAY)],
      [DAY_EPOCH + 6, 12, 10, dayFileName(DAY)],
      [DAY_EPOCH + 12, 8, 22, dayFileName(DAY)],
    ]);

    // Idempotent: a second pass finds nothing left to do.
    expect(await consolidateOnce(NOW_MS)).toEqual(NOTHING);
  });

  it("rebuilds over crash leftovers (bare day file + tmp, no index)", async () => {
    const dir = bucketDirFor(DAY_EPOCH);
    await writeSeg(DAY_EPOCH, "AAAA");
    await writeSeg(DAY_EPOCH + 6, "BB");
    await fsp.writeFile(path.join(dir, dayFileName(DAY)), "stale-garbage");
    await fsp.writeFile(path.join(dir, dayFileName(DAY) + ".tmp"), "half-written");

    const res = await consolidateOnce(NOW_MS);
    expect(res).toEqual({ daysConsolidated: 1, segmentsRemoved: 2, bytesConsolidated: 6 });
    expect((await fsp.readFile(path.join(dir, dayFileName(DAY)))).toString()).toBe("AAAABB");
    expect(await exists(path.join(dir, dayFileName(DAY) + ".tmp"))).toBe(false);
    expect(isDayIndex(JSON.parse(await fsp.readFile(path.join(dir, dayIndexFileName(DAY)), "utf8")))).toBe(true);
  });

  it("resumes after a crash: deletes only index-listed leftovers, never rewrites the day file", async () => {
    const dir = bucketDirFor(DAY_EPOCH);
    await fsp.mkdir(dir, { recursive: true });
    // A completed build: day file + valid index for two segments…
    const dayBytes = "AAAAAAAAAA" + "BBBBBBBBBBBB";
    await fsp.writeFile(path.join(dir, dayFileName(DAY)), dayBytes);
    const index: DayIndex = {
      version: 1,
      day: DAY,
      file: dayFileName(DAY),
      totalBytes: 22,
      segments: [
        { epoch: DAY_EPOCH, offset: 0, bytes: 10, duration: 6 },
        { epoch: DAY_EPOCH + 6, offset: 10, bytes: 12, duration: 6 },
      ],
    };
    await fsp.writeFile(path.join(dir, dayIndexFileName(DAY)), JSON.stringify(index));
    // …but the crash left one listed source behind, plus an unlisted loose seg.
    await writeSeg(DAY_EPOCH, "AAAAAAAAAA");
    await writeSeg(DAY_EPOCH + 18, "ZZZ"); // not listed → must survive

    const res = await consolidateOnce(NOW_MS);
    expect(res).toEqual({ daysConsolidated: 0, segmentsRemoved: 1, bytesConsolidated: 0 });
    expect((await fsp.readFile(path.join(dir, dayFileName(DAY)))).toString()).toBe(dayBytes);
    expect(await exists(path.join(dir, segmentName(DAY_EPOCH)))).toBe(false);
    expect(await exists(path.join(dir, segmentName(DAY_EPOCH + 18)))).toBe(true);
    expect(await fsp.readFile(path.join(dir, dayIndexFileName(DAY)), "utf8")).toBe(
      JSON.stringify(index),
    );
  });

  it("never touches the live UTC day", async () => {
    const epoch = Math.floor(NOW_MS / 1000) - 8 * 3600; // this morning, well over an hour old
    await writeSeg(epoch, "LIVE");
    expect(await consolidateOnce(NOW_MS)).toEqual(NOTHING);
    expect(await names(bucketDirFor(epoch))).toEqual([segmentName(epoch)]);
  });

  it("waits an hour after the newest segment (midnight-spanning segment may still be open)", async () => {
    // Yesterday's bucket; its newest segment started 36 minutes before "now".
    const lastEpoch = Date.UTC(2026, 0, 15, 23, 59, 54) / 1000;
    const now = Date.UTC(2026, 0, 16, 0, 36, 0);
    await writeSeg(DAY_EPOCH, "AAAA");
    await writeSeg(lastEpoch, "BBBB");

    expect(await consolidateOnce(now)).toEqual(NOTHING);
    expect(await names(bucketDirFor(DAY_EPOCH))).toHaveLength(2);

    // The same tree an hour and a half later is eligible.
    const later = Date.UTC(2026, 0, 16, 1, 30, 0);
    const res = await consolidateOnce(later);
    expect(res).toEqual({ daysConsolidated: 1, segmentsRemoved: 2, bytesConsolidated: 8 });
    expect((await fsp.readFile(path.join(bucketDirFor(DAY_EPOCH), dayFileName(DAY)))).toString()).toBe(
      "AAAABBBB",
    );
  });

  it("leaves stragglers from another day and unparseable files alone", async () => {
    const dir = bucketDirFor(DAY_EPOCH);
    await writeSeg(DAY_EPOCH + 60, "AAAAAAAAAA"); // in-day
    const stragglerEpoch = Date.UTC(2026, 0, 14, 23, 59, 50) / 1000; // a Jan-14 seg in the Jan-15 bucket
    await writeSeg(stragglerEpoch, "SSSS", dir);
    await fsp.writeFile(path.join(dir, "notes.txt"), "not a segment");

    const res = await consolidateOnce(NOW_MS);
    expect(res).toEqual({ daysConsolidated: 1, segmentsRemoved: 1, bytesConsolidated: 10 });
    expect((await fsp.readFile(path.join(dir, dayFileName(DAY)))).toString()).toBe("AAAAAAAAAA");
    expect(await exists(path.join(dir, segmentName(stragglerEpoch)))).toBe(true);
    expect(await exists(path.join(dir, "notes.txt"))).toBe(true);
    expect(await exists(path.join(dir, segmentName(DAY_EPOCH + 60)))).toBe(false);
    const idx = JSON.parse(await fsp.readFile(path.join(dir, dayIndexFileName(DAY)), "utf8")) as DayIndex;
    expect(idx.segments.map((s) => s.epoch)).toEqual([DAY_EPOCH + 60]);
  });

  it("excludes zero-byte sources from the index and leaves them on disk", async () => {
    const dir = bucketDirFor(DAY_EPOCH);
    await writeSeg(DAY_EPOCH, "AAAA");
    await writeSeg(DAY_EPOCH + 6, ""); // zero-byte
    await writeSeg(DAY_EPOCH + 12, "CC");

    const res = await consolidateOnce(NOW_MS);
    expect(res).toEqual({ daysConsolidated: 1, segmentsRemoved: 2, bytesConsolidated: 6 });
    expect((await fsp.readFile(path.join(dir, dayFileName(DAY)))).toString()).toBe("AAAACC");
    const idx = JSON.parse(await fsp.readFile(path.join(dir, dayIndexFileName(DAY)), "utf8"));
    expect(isDayIndex(idx)).toBe(true);
    expect((idx as DayIndex).segments.map((s) => s.epoch)).toEqual([DAY_EPOCH, DAY_EPOCH + 12]);
    // Not listed in the index → never deleted.
    expect(await exists(path.join(dir, segmentName(DAY_EPOCH + 6)))).toBe(true);
  });

  it("skips a bucket with an invalid index and deletes nothing", async () => {
    const dir = bucketDirFor(DAY_EPOCH);
    await writeSeg(DAY_EPOCH, "AAAA");
    await fsp.writeFile(path.join(dir, dayFileName(DAY)), "whatever");
    // totalBytes lies → fails isDayIndex.
    const bad = {
      version: 1,
      day: DAY,
      file: dayFileName(DAY),
      totalBytes: 999,
      segments: [{ epoch: DAY_EPOCH, offset: 0, bytes: 4, duration: 6 }],
    };
    await fsp.writeFile(path.join(dir, dayIndexFileName(DAY)), JSON.stringify(bad));
    const before = await names(dir);

    expect(await consolidateOnce(NOW_MS)).toEqual(NOTHING);
    expect(await names(dir)).toEqual(before);
    expect((await fsp.readFile(path.join(dir, dayFileName(DAY)))).toString()).toBe("whatever");
    expect((await fsp.readFile(path.join(dir, segmentName(DAY_EPOCH)))).toString()).toBe("AAAA");
  });

  it("skips a bucket whose index is unreadable JSON", async () => {
    const dir = bucketDirFor(DAY_EPOCH);
    await writeSeg(DAY_EPOCH, "AAAA");
    await fsp.writeFile(path.join(dir, dayIndexFileName(DAY)), "{not json");

    expect(await consolidateOnce(NOW_MS)).toEqual(NOTHING);
    expect(await exists(path.join(dir, segmentName(DAY_EPOCH)))).toBe(true);
    expect((await fsp.readFile(path.join(dir, dayIndexFileName(DAY)), "utf8"))).toBe("{not json");
  });

  it("no-ops on an empty tree", async () => {
    expect(await consolidateOnce(NOW_MS)).toEqual(NOTHING);
  });
});

describe("runRetention with day files", () => {
  it("deletes an out-of-retention day file together with its index", async () => {
    // 2020-01-01 — ancient relative to the injected "now" (Jan 2026).
    const oldDir = path.join(testConfig.recordingsDir, HOME, CAM, "2020", "01", "01");
    await fsp.mkdir(oldDir, { recursive: true });
    await fsp.writeFile(path.join(oldDir, "day_20200101.ts"), "OLDDAYBYTES");
    await fsp.writeFile(path.join(oldDir, "day_20200101.json"), "{}");
    // A fresh loose segment that must survive the pass.
    const freshPath = await writeSeg(Math.floor(NOW_MS / 1000) - 3600, "FRESH");

    const freed = await runRetention(NOW_MS);
    expect(freed).toBeGreaterThanOrEqual("OLDDAYBYTES".length);
    expect(await exists(path.join(oldDir, "day_20200101.ts"))).toBe(false);
    expect(await exists(path.join(oldDir, "day_20200101.json"))).toBe(false);
    expect(await exists(freshPath)).toBe(true);
  });

  it("keeps a day file until the ENTIRE day is out of retention", async () => {
    // The day containing the cutoff instant: its start is already expired but
    // its last second is not — the whole-day file must survive this pass.
    const cutoffEpoch = Math.floor(NOW_MS / 1000) - 14 * 86400; // Jan 3 2026, 12:00 UTC
    const stamp = utcDayStamp(cutoffEpoch);
    const dir = path.join(
      testConfig.recordingsDir,
      HOME,
      CAM,
      stamp.slice(0, 4),
      stamp.slice(4, 6),
      stamp.slice(6, 8),
    );
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, dayFileName(stamp)), "BOUNDARY");
    await fsp.writeFile(path.join(dir, dayIndexFileName(stamp)), "{}");

    await runRetention(NOW_MS);
    expect(await exists(path.join(dir, dayFileName(stamp)))).toBe(true);
    expect(await exists(path.join(dir, dayIndexFileName(stamp)))).toBe(true);
  });
});

describe("listCameraSegments (catalog)", () => {
  it("merges index refs with loose segs, index winning on epoch collision", async () => {
    const dir = bucketDirFor(DAY_EPOCH);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, dayFileName(DAY)), "AAAAAAAAAA" + "BBBBBBBBBBBB");
    const index: DayIndex = {
      version: 1,
      day: DAY,
      file: dayFileName(DAY),
      totalBytes: 22,
      segments: [
        { epoch: DAY_EPOCH, offset: 0, bytes: 10, duration: 6 },
        { epoch: DAY_EPOCH + 6, offset: 10, bytes: 12, duration: 6 },
      ],
    };
    await fsp.writeFile(path.join(dir, dayIndexFileName(DAY)), JSON.stringify(index));
    await writeSeg(DAY_EPOCH, "XX"); // loose leftover of an indexed epoch — index must win
    await writeSeg(DAY_EPOCH + 18, "ZZZZZ"); // loose only

    const refs = await listCameraSegments(HOME, CAM);
    expect(refs.map((r) => r.epoch)).toEqual([DAY_EPOCH, DAY_EPOCH + 6, DAY_EPOCH + 18]);
    expect(refs[0]).toEqual({
      epoch: DAY_EPOCH,
      name: segmentName(DAY_EPOCH),
      bytes: 10, // index bytes, not the 2-byte loose leftover
      byteRange: { offset: 0, length: 10 },
      container: dayFileName(DAY),
    });
    expect(refs[1]!.byteRange).toEqual({ offset: 10, length: 12 });
    expect(refs[2]).toEqual({
      epoch: DAY_EPOCH + 18,
      name: segmentName(DAY_EPOCH + 18),
      bytes: 5,
    });
  });

  it("skips an invalid index — its day lists as whatever is loose", async () => {
    const dir = bucketDirFor(DAY_EPOCH);
    await writeSeg(DAY_EPOCH, "AA");
    await fsp.writeFile(
      path.join(dir, dayIndexFileName(DAY)),
      JSON.stringify({ version: 1, nope: true }),
    );
    const refs = await listCameraSegments(HOME, CAM);
    expect(refs).toEqual([{ epoch: DAY_EPOCH, name: segmentName(DAY_EPOCH), bytes: 2 }]);
  });
});
