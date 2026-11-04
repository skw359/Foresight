/**
 * Lightweight coverage listing over the segment tree, used by the control API's
 * /status for quick visibility. The server has its own richer reader; this is
 * intentionally minimal (the recorder's job is to WRITE segments, not serve them).
 *
 * Consolidated days: each day_<YYYYMMDD>.json index (see storage/consolidate.ts)
 * expands into per-segment refs carrying byte windows into its day file — no
 * per-segment stats needed. A segment found both loose (crash leftover) and in
 * an index dedupes to the index entry; an invalid index is skipped, so its day
 * simply shows as whatever loose segments remain (a gap at worst).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  coverageSpans,
  dayIndexFileName,
  dayIndexToRefs,
  isDayIndex,
  parseSegmentName,
  type SegmentRef,
} from "@foresight/contract";
import { cameraDir } from "./layout.js";

/** Cheap name gate so we only read JSON files that plausibly are day indexes. */
const DAY_INDEX_NAME = /^day_\d{8}\.json$/;

/** Segment refs for a camera (sorted oldest-first), or [] if none yet. */
export async function listCameraSegments(homeId: string, cameraId: string): Promise<SegmentRef[]> {
  const dir = cameraDir(homeId, cameraId);
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  const byEpoch = new Map<number, SegmentRef>();
  const indexed = new Map<number, SegmentRef>();
  for (const e of entries) {
    if (!e.isFile()) continue;
    const anyE = e as unknown as { parentPath?: string; path?: string };
    const parent = anyE.parentPath ?? anyE.path ?? dir;
    const epoch = parseSegmentName(e.name);
    if (epoch !== null) {
      let bytes = 0;
      try {
        bytes = (await fsp.stat(path.join(parent, e.name))).size;
      } catch {
        /* skip */
      }
      byEpoch.set(epoch, { epoch, name: e.name, bytes });
      continue;
    }
    if (!DAY_INDEX_NAME.test(e.name)) continue;
    try {
      const parsed: unknown = JSON.parse(await fsp.readFile(path.join(parent, e.name), "utf8"));
      // The filename must also match the stamped day, so a copied index can't
      // double-list a day it doesn't own.
      if (!isDayIndex(parsed) || dayIndexFileName(parsed.day) !== e.name) continue;
      for (const ref of dayIndexToRefs(parsed)) indexed.set(ref.epoch, ref);
    } catch {
      /* unreadable index → day shows as loose segs / gap */
    }
  }
  for (const [epoch, ref] of indexed) byEpoch.set(epoch, ref); // index wins over loose leftovers
  return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
}

/** Summary of stored footage for a camera. */
export async function cameraCoverage(
  homeId: string,
  cameraId: string,
): Promise<{ segments: number; bytes: number; earliest: number | null; latest: number | null }> {
  const refs = await listCameraSegments(homeId, cameraId);
  const spans = coverageSpans(refs);
  return {
    segments: refs.length,
    bytes: refs.reduce((s, r) => s + r.bytes, 0),
    earliest: spans[0]?.startEpoch ?? null,
    latest: spans[spans.length - 1]?.endEpoch ?? null,
  };
}
