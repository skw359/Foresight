/**
 * Unit tests for consolidated-day-file support in the listing layer
 * (src/lib/recordings.ts): merging day_*.json indexes into listings (with the
 * index winning over loose crash leftovers), the guarded day-file path
 * resolver, the stale-playlist byte-slice lookup, consolidated-aware range
 * deletion (full-day removal + partial-day rewrite, byte-exact), and the
 * ordered piece piping that feeds the clip remux.
 *
 * Fixtures are throwaway mkdtemp trees whose day files carry DISTINCT byte
 * content per segment, so every slice/rewrite assertion is byte-verifiable.
 */
import { TEST_LIVEKIT_SECRET, TEST_RECORDER_SECRET, applyTestEnv } from "./testEnv.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import {
  dayFileName,
  dayIndexFileName,
  isDayIndex,
  segmentName,
  utcDayStamp,
  type DayIndex,
} from "@foresight/contract";

// The lib imports src/config.ts, which fails fast on missing env — pin
// deterministic values BEFORE the dynamic import below (dotenv never
// overwrites pre-set values, so a developer .env can't leak in).
applyTestEnv();
process.env.LIVEKIT_URL = "ws://localhost:7880";

let lib: typeof import("../src/lib/recordings.js");

const root = mkdtempSync(join(tmpdir(), "foresight-consol-"));

beforeAll(async () => {
  lib = await import("../src/lib/recordings.js");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** UTC YYYY/MM/DD bucket dir for an epoch, under `dir`. */
function bucketOf(dir: string, epoch: number): string {
  const d = new Date(epoch * 1000);
  return join(
    dir,
    String(d.getUTCFullYear()),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  );
}

/** Write one loose segment file with the given body into its UTC bucket. */
function writeSeg(dir: string, epoch: number, body: Buffer): void {
  const bucket = bucketOf(dir, epoch);
  mkdirSync(bucket, { recursive: true });
  writeFileSync(join(bucket, segmentName(epoch)), body);
}

interface DaySegSpec {
  epoch: number;
  body: Buffer;
}

/**
 * Write a consolidated day: `day_<D>.ts` as the byte concat of the specs (epoch
 * order) plus a valid `day_<D>.json` index with contiguous offsets.
 */
function writeDay(
  dir: string,
  specs: DaySegSpec[],
): { stamp: string; bucket: string; totalBytes: number; tsPath: string; jsonPath: string } {
  const stamp = utcDayStamp(specs[0]!.epoch);
  const bucket = bucketOf(dir, specs[0]!.epoch);
  mkdirSync(bucket, { recursive: true });
  let offset = 0;
  const segments = specs.map((s) => {
    const entry = { epoch: s.epoch, offset, bytes: s.body.length, duration: 6 };
    offset += s.body.length;
    return entry;
  });
  const tsPath = join(bucket, dayFileName(stamp));
  const jsonPath = join(bucket, dayIndexFileName(stamp));
  writeFileSync(tsPath, Buffer.concat(specs.map((s) => s.body)));
  writeFileSync(
    jsonPath,
    JSON.stringify({ version: 1, day: stamp, file: dayFileName(stamp), totalBytes: offset, segments }),
  );
  return { stamp, bucket, totalBytes: offset, tsPath, jsonPath };
}

/** A buffer of `len` bytes, every byte the char `ch` — distinct per segment. */
const fill = (ch: string, len: number): Buffer => Buffer.alloc(len, ch);

// Fixed, timezone-proof reference instants (UTC).
const DAY1_START = Math.floor(Date.UTC(2026, 2, 10, 0, 0, 0) / 1000); // 2026-03-10 → stamp 20260310
const NOON = DAY1_START + 12 * 3600;
const DAY2_NOON = NOON + 86_400; // 2026-03-11 12:00

describe("listSegments merges day indexes", () => {
  const dir = join(root, "camMerge");

  it("expands index entries (byteRange + container + index bytes) and merges loose segs", async () => {
    writeDay(dir, [
      { epoch: NOON, body: fill("a", 100) },
      { epoch: NOON + 6, body: fill("b", 150) },
      { epoch: NOON + 12, body: fill("c", 200) },
    ]);
    writeSeg(dir, NOON + 60, fill("x", 77)); // loose, same day
    writeSeg(dir, DAY2_NOON, fill("y", 55)); // loose, next day

    const refs = await lib.listSegments(dir);
    expect(refs.map((r) => r.epoch)).toEqual([NOON, NOON + 6, NOON + 12, NOON + 60, DAY2_NOON]);

    const [a, b, c, x, y] = refs;
    expect(a!.byteRange).toEqual({ offset: 0, length: 100 });
    expect(b!.byteRange).toEqual({ offset: 100, length: 150 });
    expect(c!.byteRange).toEqual({ offset: 250, length: 200 });
    for (const r of [a!, b!, c!]) expect(r.container).toBe("day_20260310.ts");
    expect([a!.bytes, b!.bytes, c!.bytes]).toEqual([100, 150, 200]);
    // Consolidated names are the canonical seg_* names rebuilt from the epoch.
    expect(a!.name).toBe(segmentName(NOON));

    // Loose refs stay plain files with stat'ed sizes.
    expect(x!.byteRange).toBeUndefined();
    expect(x!.container).toBeUndefined();
    expect([x!.bytes, y!.bytes]).toEqual([77, 55]);
  });

  it("applies from/to bounds to the EXPANDED refs", async () => {
    const only = await lib.listSegments(dir, NOON + 6, NOON + 6);
    expect(only).toHaveLength(1);
    expect(only[0]!.epoch).toBe(NOON + 6);
    expect(only[0]!.byteRange).toEqual({ offset: 100, length: 150 });

    const tail = await lib.listSegments(dir, NOON + 7);
    expect(tail.map((r) => r.epoch)).toEqual([NOON + 12, NOON + 60, DAY2_NOON]);
  });

  it("withBytes:false skips loose stats but consolidated sizes still come from the index", async () => {
    const refs = await lib.listSegments(dir, undefined, undefined, { withBytes: false });
    const consolidated = refs.filter((r) => r.byteRange);
    const loose = refs.filter((r) => !r.byteRange);
    expect(consolidated.map((r) => r.bytes)).toEqual([100, 150, 200]);
    expect(loose.every((r) => r.bytes === 0)).toBe(true);
  });

  it("dedupes a crash leftover present both loose and indexed — the index wins", async () => {
    const dir2 = join(root, "camDedupe");
    writeDay(dir2, [
      { epoch: NOON, body: fill("a", 100) },
      { epoch: NOON + 6, body: fill("b", 150) },
    ]);
    // Leftover loose copy of the second segment with a DIFFERENT size: if the
    // loose file won (or both appeared), sizes/counts would betray it.
    writeSeg(dir2, NOON + 6, fill("z", 999));

    const refs = await lib.listSegments(dir2);
    expect(refs.map((r) => r.epoch)).toEqual([NOON, NOON + 6]);
    expect(refs[1]!.bytes).toBe(150);
    expect(refs[1]!.byteRange).toEqual({ offset: 100, length: 150 });
    expect(refs[1]!.container).toBe("day_20260310.ts");
  });

  it("skips unparseable and structurally invalid indexes without throwing", async () => {
    const dir3 = join(root, "camBadIndex");
    const bucket1 = bucketOf(dir3, NOON);
    mkdirSync(bucket1, { recursive: true });
    writeFileSync(join(bucket1, "day_20260310.json"), "{ this is not json");
    const bucket2 = bucketOf(dir3, DAY2_NOON);
    mkdirSync(bucket2, { recursive: true });
    // Parses, but violates the DayIndex invariants (totalBytes ≠ sum).
    writeFileSync(
      join(bucket2, "day_20260311.json"),
      JSON.stringify({ version: 1, day: "20260311", file: "day_20260311.ts", totalBytes: 5, segments: [] }),
    );
    writeSeg(dir3, DAY2_NOON, fill("q", 42));

    const refs = await lib.listSegments(dir3);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.epoch).toBe(DAY2_NOON);
    expect(refs[0]!.byteRange).toBeUndefined();
  });
});

describe("safeDayFilePath", () => {
  const dir = join(root, "camSafe");

  it("resolves a day file in its deterministic UTC bucket", async () => {
    const { tsPath } = writeDay(dir, [{ epoch: NOON, body: fill("a", 10) }]);
    expect(await lib.safeDayFilePath(dir, "day_20260310.ts")).toBe(tsPath);
  });

  it("returns null for malformed names and missing files", async () => {
    expect(await lib.safeDayFilePath(dir, "day_20260311.ts")).toBeNull(); // absent
    expect(await lib.safeDayFilePath(dir, "day_2026031.ts")).toBeNull(); // 7 digits
    expect(await lib.safeDayFilePath(dir, "day_20261301.ts")).toBeNull(); // month 13
    expect(await lib.safeDayFilePath(dir, "seg_20260310120000.ts")).toBeNull();
    expect(await lib.safeDayFilePath(dir, "..\\day_20260310.ts")).toBeNull();
  });

  it("falls back to a tree scan for a day file in a surprise bucket", async () => {
    // day_20260312.ts stranded inside 2026/03/10 — the listing would still
    // discover its index there, so serving must find the file too.
    const strayPath = join(bucketOf(dir, NOON), "day_20260312.ts");
    writeFileSync(strayPath, fill("s", 8));
    expect(await lib.safeDayFilePath(dir, "day_20260312.ts")).toBe(strayPath);
  });
});

describe("lookupConsolidatedSegment (stale-playlist slices)", () => {
  const dir = join(root, "camLookup");

  it("returns the exact byte window for an indexed epoch", async () => {
    const { tsPath } = writeDay(dir, [
      { epoch: NOON, body: fill("a", 100) },
      { epoch: NOON + 6, body: fill("b", 150) },
    ]);
    const hit = await lib.lookupConsolidatedSegment(dir, NOON + 6);
    expect(hit).toEqual({ dayFilePath: tsPath, offset: 100, bytes: 150 });
  });

  it("returns null for unindexed epochs and unconsolidated days", async () => {
    expect(await lib.lookupConsolidatedSegment(dir, NOON + 1)).toBeNull(); // not an entry
    expect(await lib.lookupConsolidatedSegment(dir, DAY2_NOON)).toBeNull(); // no index at all
  });
});

describe("deleteSegments over consolidated days", () => {
  it("removes a fully-covered day (file + index) and counts its bytes", async () => {
    const dir = join(root, "camDelFull");
    const { tsPath, jsonPath, bucket } = writeDay(dir, [
      { epoch: NOON, body: fill("a", 100) },
      { epoch: NOON + 6, body: fill("b", 150) },
      { epoch: NOON + 12, body: fill("c", 200) },
    ]);

    const result = await lib.deleteSegments(dir, DAY1_START, DAY1_START + 86_400);
    expect(result).toEqual({ deletedSegments: 3, deletedBytes: 450 });
    expect(existsSync(tsPath)).toBe(false);
    expect(existsSync(jsonPath)).toBe(false);
    expect(existsSync(bucket)).toBe(false); // empty bucket pruned
    expect(await lib.listSegments(dir)).toEqual([]);
  });

  it("rewrites a partially-covered day byte-exactly and recomputes the index", async () => {
    const dir = join(root, "camDelPart");
    const a = fill("a", 100);
    const b = fill("b", 150);
    const c = fill("c", 200);
    const d = fill("d", 250);
    const { tsPath, jsonPath } = writeDay(dir, [
      { epoch: NOON, body: a },
      { epoch: NOON + 6, body: b },
      { epoch: NOON + 12, body: c },
      { epoch: NOON + 18, body: d },
    ]);

    // Half-open [NOON+6, NOON+18) → B and C go, A and D stay.
    const result = await lib.deleteSegments(dir, NOON + 6, NOON + 18);
    expect(result).toEqual({ deletedSegments: 2, deletedBytes: 350 });

    // Remaining media is exactly the kept windows, in epoch order.
    expect(readFileSync(tsPath).equals(Buffer.concat([a, d]))).toBe(true);
    // No tmp leftovers from the swap.
    expect(existsSync(`${tsPath}.tmp`)).toBe(false);
    expect(existsSync(`${jsonPath}.tmp`)).toBe(false);

    // The rewritten index is valid and byte-contiguous from 0.
    const rewritten = JSON.parse(readFileSync(jsonPath, "utf8")) as DayIndex;
    expect(isDayIndex(rewritten)).toBe(true);
    expect(rewritten.totalBytes).toBe(350);
    expect(rewritten.segments.map((s) => [s.epoch, s.offset, s.bytes])).toEqual([
      [NOON, 0, 100],
      [NOON + 18, 100, 250],
    ]);

    // And the listing serves the new windows.
    const refs = await lib.listSegments(dir);
    expect(refs.map((r) => r.epoch)).toEqual([NOON, NOON + 18]);
    expect(refs[0]!.byteRange).toEqual({ offset: 0, length: 100 });
    expect(refs[1]!.byteRange).toEqual({ offset: 100, length: 250 });
  });

  it("counts loose files (incl. indexed leftovers) alongside day-file bytes", async () => {
    const dir = join(root, "camDelMix");
    const { tsPath } = writeDay(dir, [
      { epoch: NOON, body: fill("a", 100) },
      { epoch: NOON + 6, body: fill("b", 150) },
    ]);
    writeSeg(dir, NOON + 6, fill("z", 999)); // crash leftover of the indexed seg
    writeSeg(dir, NOON + 120, fill("e", 321)); // plain loose seg in the window

    const result = await lib.deleteSegments(dir, NOON + 6, NOON + 600);
    // 3 removals: the indexed entry, its loose leftover file, the loose seg —
    // every byte actually freed from disk is counted (150 + 999 + 321).
    expect(result).toEqual({ deletedSegments: 3, deletedBytes: 1470 });
    expect(readFileSync(tsPath).equals(fill("a", 100))).toBe(true);
  });
});

describe("clip piece resolution + ordered piping", () => {
  it("streams consolidated windows and loose files in epoch order, byte-exactly", async () => {
    const dir = join(root, "camClip");
    const a = fill("a", 100);
    const b = fill("b", 150);
    const c = fill("c", 200);
    const d = fill("d", 40);
    writeDay(dir, [
      { epoch: NOON, body: a },
      { epoch: NOON + 6, body: b },
      { epoch: NOON + 12, body: c },
    ]);
    writeSeg(dir, NOON + 60, d);

    const refs = await lib.listSegments(dir, undefined, undefined, { withBytes: false });
    const pieces = await lib.resolveClipPieces(dir, refs);
    expect(pieces).toHaveLength(4);
    // Day windows carry inclusive byte bounds; the loose file has none.
    expect(pieces[1]).toMatchObject({ start: 100, end: 249 });
    expect(pieces[3]!.start).toBeUndefined();

    const dest = new PassThrough();
    const chunks: Buffer[] = [];
    dest.on("data", (chunk: Buffer) => chunks.push(chunk));
    await lib.pipePieces(pieces, dest);
    await finished(dest);
    expect(Buffer.concat(chunks).equals(Buffer.concat([a, b, c, d]))).toBe(true);
  });

  it("skips refs that resolve nowhere instead of failing the clip", async () => {
    const dir = join(root, "camClipGone");
    writeSeg(dir, NOON, fill("a", 10));
    const refs = await lib.listSegments(dir, undefined, undefined, { withBytes: false });
    // A ref for footage that vanished entirely (no loose file, no index).
    refs.push({ epoch: NOON + 6, name: segmentName(NOON + 6), bytes: 0 });
    const pieces = await lib.resolveClipPieces(dir, refs);
    expect(pieces).toHaveLength(1);
  });
});
