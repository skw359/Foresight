/**
 * Retention runner: keep the recordings tree under both an age limit and a disk
 * budget, whichever bites first. The pure DECISION lives in retentionPlan.ts
 * (unit-tested); this module measures disk/free-space, applies the plan, and
 * sweeps empty date folders.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  dayIndexFileName,
  parseDayFileName,
  parseSegmentName,
  utcDayStamp,
} from "@foresight/contract";
import { config } from "../config.js";
import { log } from "../log.js";
import { planRetention, type SegmentFile } from "./retentionPlan.js";

export {
  planRetention,
  type SegmentFile,
  type RetentionOptions,
  type RetentionPlan,
} from "./retentionPlan.js";

const GB = 1024 * 1024 * 1024;

/**
 * Recursively collect every deletable recording file under the recordings root:
 * loose seg_*.ts files plus consolidated day_*.ts files. A day file is ONE
 * SegmentFile stamped with its day's LAST second (start + 86399) so it only
 * age-expires once the whole day is out of retention; its sibling .json index
 * is remembered so the runner deletes the pair together.
 */
async function collectSegments(root: string): Promise<SegmentFile[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  const out: SegmentFile[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const anyE = e as unknown as { parentPath?: string; path?: string };
    const parent = anyE.parentPath ?? anyE.path ?? root;
    const full = path.join(parent, e.name);
    const segEpoch = parseSegmentName(e.name);
    if (segEpoch !== null) {
      try {
        out.push({ path: full, epoch: segEpoch, bytes: (await fsp.stat(full)).size });
      } catch {
        /* vanished mid-scan */
      }
      continue;
    }
    const dayEpoch = parseDayFileName(e.name);
    if (dayEpoch === null) continue;
    try {
      out.push({
        path: full,
        epoch: dayEpoch + 86399, // the day's last second
        bytes: (await fsp.stat(full)).size,
        indexPath: path.join(parent, dayIndexFileName(utcDayStamp(dayEpoch))),
      });
    } catch {
      /* vanished mid-scan */
    }
  }
  return out;
}

/** Measure free bytes on the recordings volume (best effort). */
async function freeBytesOf(dir: string): Promise<number> {
  try {
    const s = await fsp.statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return Number.MAX_SAFE_INTEGER; // can't measure → don't trigger free-space pruning
  }
}

/** One retention pass over the whole recordings tree. Returns bytes freed. */
export async function runRetention(nowMs: number = Date.now()): Promise<number> {
  const root = config.recordingsDir;
  const segments = await collectSegments(root);
  if (segments.length === 0) return 0;

  const plan = planRetention(segments, {
    retentionDays: config.retentionDays,
    maxBytes: config.retentionMaxGb * GB,
    minFreeBytes: config.minFreeGb * GB,
    freeBytes: await freeBytesOf(root),
    nowMs,
  });

  let freed = 0;
  for (const seg of plan.toDelete) {
    try {
      await fsp.unlink(seg.path);
      freed += seg.bytes;
    } catch (err) {
      log.warn("retention: failed to delete segment", { path: seg.path, err: String(err) });
      continue;
    }
    // A consolidated day file's JSON index lives and dies with it.
    if (seg.indexPath) {
      try {
        freed += (await fsp.stat(seg.indexPath)).size;
        await fsp.unlink(seg.indexPath);
      } catch (err) {
        log.warn("retention: failed to delete day index", {
          path: seg.indexPath,
          err: String(err),
        });
      }
    }
  }
  await sweepEmptyDirs(root);
  if (plan.toDelete.length > 0) {
    log.info("retention pass complete", {
      deleted: plan.toDelete.length,
      freedMB: Math.round(freed / (1024 * 1024)),
      age: plan.reasons.age,
      disk: plan.reasons.disk,
    });
  }
  return freed;
}

/** Remove now-empty date directories left behind by pruning (depth-first). */
async function sweepEmptyDirs(root: string): Promise<void> {
  async function walk(dir: string): Promise<boolean> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let empty = true;
    for (const e of entries) {
      if (e.isDirectory()) {
        const childEmpty = await walk(path.join(dir, e.name));
        if (!childEmpty) empty = false;
      } else {
        empty = false;
      }
    }
    if (empty && dir !== root) {
      await fsp.rmdir(dir).catch(() => undefined);
    }
    return empty;
  }
  await walk(root);
}

/** Start the periodic retention loop; returns a stop() handle. */
export function startRetentionLoop(): () => void {
  const timer = setInterval(() => {
    runRetention().catch((err) => log.error("retention loop error", { err: String(err) }));
  }, config.retentionIntervalMs);
  const kickoff = setTimeout(() => {
    runRetention().catch((err) => log.error("retention kickoff error", { err: String(err) }));
  }, 5000);
  return () => {
    clearInterval(timer);
    clearTimeout(kickoff);
  };
}
