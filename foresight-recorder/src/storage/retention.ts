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
 * Temp files older than this are abandoned (crashed ffmpeg `seg_*.ts.tmp`,
 * crashed consolidation/rewrite `day_*.tmp`) and are deleted. Live ones are
 * seconds (segments) to minutes (a day build) old and keep being written.
 */
export const STALE_TMP_MS = 24 * 60 * 60 * 1000;

/** "<homeId>/<cameraId>" for a file under the recordings root, for fair-share retention. */
function ownerOf(root: string, file: string): string | undefined {
  const parts = path.relative(root, file).split(path.sep);
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : undefined;
}

/**
 * Recursively collect every deletable recording file under the recordings root:
 * loose seg_*.ts files plus consolidated day_*.ts files. A day file is ONE
 * SegmentFile stamped with its day's LAST second (start + 86399) so it only
 * age-expires once the whole day is out of retention; its sibling .json index
 * is remembered so the runner deletes the pair together.
 */
async function collectSegments(
  root: string,
  nowMs: number,
): Promise<{ segments: SegmentFile[]; staleTmp: string[] }> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { recursive: true, withFileTypes: true });
  } catch {
    return { segments: [], staleTmp: [] };
  }
  const out: SegmentFile[] = [];
  const staleTmp: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const anyE = e as unknown as { parentPath?: string; path?: string };
    const parent = anyE.parentPath ?? anyE.path ?? root;
    const full = path.join(parent, e.name);
    if (e.name.endsWith(".tmp") && (e.name.startsWith("seg_") || e.name.startsWith("day_"))) {
      try {
        if (nowMs - (await fsp.stat(full)).mtimeMs > STALE_TMP_MS) staleTmp.push(full);
      } catch {
        /* vanished mid-scan */
      }
      continue;
    }
    const segEpoch = parseSegmentName(e.name);
    if (segEpoch !== null) {
      try {
        out.push({ path: full, epoch: segEpoch, bytes: (await fsp.stat(full)).size, owner: ownerOf(root, full) });
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
        owner: ownerOf(root, full),
      });
    } catch {
      /* vanished mid-scan */
    }
  }
  return { segments: out, staleTmp };
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
  const { segments, staleTmp } = await collectSegments(root, nowMs);

  let freed = 0;
  for (const tmp of staleTmp) {
    try {
      const size = (await fsp.stat(tmp)).size;
      await fsp.unlink(tmp);
      freed += size;
      log.info("retention: removed abandoned temp file", { path: tmp });
    } catch {
      /* already gone */
    }
  }
  if (segments.length === 0) return freed;

  const plan = planRetention(segments, {
    retentionDays: config.retentionDays,
    maxBytes: config.retentionMaxGb * GB,
    minFreeBytes: config.minFreeGb * GB,
    freeBytes: await freeBytesOf(root),
    nowMs,
    policy: config.retentionPolicy,
  });

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

/** Start the periodic retention loop; returns a stop() handle. Passes never overlap. */
export function startRetentionLoop(): () => void {
  let running = false;
  const run = (label: string): void => {
    if (running) return; // a slow pass (huge tree, slow disk) must not stack up
    running = true;
    runRetention()
      .catch((err) => log.error(label, { err: String(err) }))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(() => run("retention loop error"), config.retentionIntervalMs);
  const kickoff = setTimeout(() => run("retention kickoff error"), 5000);
  return () => {
    clearInterval(timer);
    clearTimeout(kickoff);
  };
}
