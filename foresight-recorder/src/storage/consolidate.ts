/**
 * Segment consolidation: once a UTC day is safely over, its thousands of small
 * seg_*.ts files are concatenated (raw bytes, epoch order) into a single
 * day_<YYYYMMDD>.ts plus a day_<YYYYMMDD>.json byte index, and the sources are
 * deleted. MPEG-TS concatenates cleanly (every segment starts with PAT/PMT and
 * a keyframe via `independent_segments`), so serving [offset, offset+bytes)
 * out of the day file is byte-identical to serving the old segment file.
 *
 * CRASH SAFETY — the presence of the .json index flips authority for a day to
 * the day file (see the "Consolidated day files" section of
 * shared/ts/src/recording.ts). Until the index is renamed into place the loose
 * segments stay authoritative and any bare day_*.ts(.tmp) is a rebuildable
 * crash leftover; once the index exists we never rebuild — the only remaining
 * work is deleting the loose segments it lists. An index that fails validation
 * authorizes NOTHING: its bucket is skipped untouched.
 *
 * CONCURRENCY + SPACE (REC-03) — passes never overlap (a long backlog pass can
 * outlast the interval; two passes writing one tmp file would publish a day
 * file with zero-filled holes and then delete its sources). Each build writes a
 * UNIQUELY named tmp opened with O_EXCL, and is skipped when the volume lacks
 * room for a full copy of the day plus MIN_FREE_GB — a full disk would also
 * break the live encoders.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  computeSegments,
  dayFileName,
  dayIndexFileName,
  isDayIndex,
  parseDayFileName,
  parseSegmentName,
  segmentName,
  utcDayStamp,
  type DayIndex,
  type DayIndexSegment,
  type SegmentRef,
} from "@foresight/contract";
import { config } from "../config.js";
import { log } from "../log.js";

/**
 * A bucket is only consolidated once its newest segment is older than this —
 * a segment that started just before midnight could otherwise still be open.
 * Fixed by design (no config knob).
 */
const QUIET_SECONDS = 3600;
/** Copy buffer size for the stream-concat. */
const COPY_CHUNK = 1 << 20; // 1 MiB

const GB = 1024 * 1024 * 1024;

/** A tmp path no other pass (or crashed pass) can collide with. */
function uniqueTmp(finalPath: string): string {
  return `${finalPath}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
}

/** `day_<D>.ts…tmp` / `day_<D>.json…tmp` — legacy fixed names and unique ones. */
function isDayTmp(name: string, dayStamp: string): boolean {
  return (
    name.endsWith(".tmp") &&
    (name.startsWith(`${dayFileName(dayStamp)}.`) || name.startsWith(`${dayIndexFileName(dayStamp)}.`))
  );
}

async function removeDayTmpLeftovers(bucketDir: string, dayStamp: string): Promise<void> {
  let names: string[];
  try {
    names = await fsp.readdir(bucketDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (isDayTmp(name, dayStamp)) await fsp.rm(path.join(bucketDir, name), { force: true }).catch(() => undefined);
  }
}

/** Free bytes on the volume holding `dir`, or null when it can't be measured. */
async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await fsp.statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

export interface ConsolidateResult {
  /** Buckets freshly consolidated (resume-only cleanup does not count). */
  daysConsolidated: number;
  /** Source seg_*.ts files deleted (fresh builds + crash-leftover cleanup). */
  segmentsRemoved: number;
  /** Total bytes written into freshly built day files. */
  bytesConsolidated: number;
}

/** Immediate subdirectory names of `dir`, optionally filtered by shape. */
async function subdirs(dir: string, match?: RegExp): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && (!match || match.test(e.name)))
    .map((e) => e.name);
}

/** Append srcPath's bytes to the open destination handle; returns bytes copied. */
async function copyInto(dst: fsp.FileHandle, srcPath: string): Promise<number> {
  const src = await fsp.open(srcPath, "r");
  try {
    const buf = Buffer.allocUnsafe(COPY_CHUNK);
    let copied = 0;
    for (;;) {
      const { bytesRead } = await src.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      let off = 0;
      while (off < bytesRead) {
        const { bytesWritten } = await dst.write(buf, off, bytesRead - off, null);
        if (bytesWritten === 0) throw new Error(`short write appending ${srcPath}`);
        off += bytesWritten;
      }
      copied += bytesRead;
    }
    return copied;
  } finally {
    await src.close();
  }
}

/**
 * Consolidate (or resume consolidating) one day bucket. Never throws for
 * per-file trouble — a failed bucket aborts cleanly, leaving sources
 * authoritative; genuinely unexpected errors bubble to the per-bucket catch
 * in consolidateOnce.
 */
async function consolidateBucket(
  bucketDir: string,
  dayStamp: string,
  todayStamp: string,
  nowMs: number,
): Promise<ConsolidateResult> {
  const res: ConsolidateResult = { daysConsolidated: 0, segmentsRemoved: 0, bytesConsolidated: 0 };

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(bucketDir, { withFileTypes: true });
  } catch {
    return res; // bucket vanished mid-pass
  }

  const finalName = dayFileName(dayStamp);
  const indexName = dayIndexFileName(dayStamp);
  const finalPath = path.join(bucketDir, finalName);
  const indexPath = path.join(bucketDir, indexName);
  const tmpPath = uniqueTmp(finalPath);
  const indexTmpPath = uniqueTmp(indexPath);

  let hasIndex = false;
  const segs: Array<{ name: string; epoch: number }> = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name === indexName) {
      hasIndex = true;
      continue;
    }
    const epoch = parseSegmentName(e.name);
    if (epoch !== null) segs.push({ name: e.name, epoch });
    // Everything else (day file, .tmp leftovers, unparseable names) is either
    // handled explicitly below or deliberately left alone.
  }

  // ---- Index present: authority already flipped to the day file. ----------
  if (hasIndex) {
    let index: DayIndex | null = null;
    try {
      const parsed: unknown = JSON.parse(await fsp.readFile(indexPath, "utf8"));
      if (isDayIndex(parsed) && parsed.day === dayStamp) index = parsed;
    } catch {
      /* unreadable/corrupt → treated as invalid below */
    }
    if (index === null) {
      // Never delete anything on the say-so of an index we can't trust.
      log.warn("consolidate: invalid day index — skipping bucket", { bucketDir, indexPath });
      return res;
    }
    // Resume path: the build completed (index renamed into place) but a crash
    // may have interrupted source cleanup. Delete ONLY loose segments the
    // index lists; stragglers/unlisted files survive. Never rebuild.
    const listed = new Set(index.segments.map((s) => s.epoch));
    for (const seg of segs) {
      if (!listed.has(seg.epoch)) continue;
      try {
        await fsp.unlink(path.join(bucketDir, seg.name));
        res.segmentsRemoved++;
      } catch (err) {
        log.warn("consolidate: failed to delete leftover segment", {
          bucketDir,
          name: seg.name,
          err: String(err),
        });
      }
    }
    if (res.segmentsRemoved > 0) {
      log.info("consolidate: removed crash leftovers", {
        bucketDir,
        day: dayStamp,
        removed: res.segmentsRemoved,
      });
    }
    return res;
  }

  // ---- No index: loose segments are authoritative. Check eligibility. -----
  if (dayStamp >= todayStamp) return res; // never touch the live (or a future) day
  const inDay = segs
    .filter((s) => utcDayStamp(s.epoch) === dayStamp) // stragglers stay loose
    .sort((a, b) => a.epoch - b.epoch);
  if (inDay.length === 0) return res; // nothing to build (a bare day file without sources stays put)
  const newestEpoch = segs.reduce((max, s) => Math.max(max, s.epoch), -Infinity);
  if (Math.floor(nowMs / 1000) - newestEpoch <= QUIET_SECONDS) return res;

  // ---- Space check: the build needs a full second copy of the day. -------
  let needed = 0;
  for (const seg of inDay) {
    try {
      needed += (await fsp.stat(path.join(bucketDir, seg.name))).size;
    } catch {
      /* vanished — the copy loop below aborts cleanly */
    }
  }
  const free = await freeBytes(bucketDir);
  const reserve = config.minFreeGb * GB;
  if (free !== null && free < needed + reserve) {
    log.warn("consolidate: not enough free space to build day file — skipping bucket", {
      bucketDir,
      day: dayStamp,
      neededMB: Math.round(needed / (1024 * 1024)),
      freeMB: Math.round(free / (1024 * 1024)),
      reserveGB: config.minFreeGb,
    });
    return res;
  }

  // ---- Build: stream-concat sources (epoch order) into the tmp day file. --
  const parts: Array<{ epoch: number; offset: number; bytes: number }> = [];
  let totalBytes = 0;
  let ok = true;
  // "wx": O_CREAT|O_EXCL — never truncate a file another pass is writing.
  const fh = await fsp.open(tmpPath, "wx");
  try {
    for (const seg of inDay) {
      const srcPath = path.join(bucketDir, seg.name);
      // Re-stat immediately before copying: the copy must match this size
      // exactly or the whole bucket is aborted (sources stay authoritative).
      let size: number;
      try {
        size = (await fsp.stat(srcPath)).size;
      } catch {
        ok = false; // source vanished mid-pass
        break;
      }
      if (size === 0) continue; // zero-byte source: excluded (index requires bytes > 0), left on disk
      const copied = await copyInto(fh, srcPath);
      if (copied !== size) {
        log.warn("consolidate: source size changed mid-copy — aborting bucket", {
          srcPath,
          expected: size,
          copied,
        });
        ok = false;
        break;
      }
      parts.push({ epoch: seg.epoch, offset: totalBytes, bytes: size });
      totalBytes += size;
    }
    if (ok && parts.length > 0) {
      await fh.sync().catch(() => undefined); // fsync best-effort
    }
  } catch (err) {
    log.warn("consolidate: copy failed — aborting bucket", { bucketDir, err: String(err) });
    ok = false;
  } finally {
    await fh.close();
  }
  if (!ok || parts.length === 0) {
    await fsp.rm(tmpPath, { force: true });
    return res;
  }

  // Verify the tmp file is exactly the sum of its parts before it can ever
  // become authoritative.
  let tmpSize = -1;
  try {
    tmpSize = (await fsp.stat(tmpPath)).size;
  } catch {
    /* mismatch handled below */
  }
  if (tmpSize !== totalBytes) {
    log.warn("consolidate: tmp size mismatch — aborting bucket", {
      bucketDir,
      expected: totalBytes,
      actual: tmpSize,
    });
    await fsp.rm(tmpPath, { force: true });
    return res;
  }

  // Durations via the exact rule playback recomputes with (informational).
  const played = computeSegments(
    parts.map((p): SegmentRef => ({ epoch: p.epoch, name: segmentName(p.epoch), bytes: p.bytes })),
  );
  const index: DayIndex = {
    version: 1,
    day: dayStamp,
    file: finalName,
    totalBytes,
    segments: parts.map(
      (p, i): DayIndexSegment => ({
        epoch: p.epoch,
        offset: p.offset,
        bytes: p.bytes,
        duration: played[i]!.duration,
      }),
    ),
  };
  if (!isDayIndex(index)) {
    // Defense in depth: never publish an index readers would reject (or trust wrongly).
    log.error("consolidate: built index failed validation — aborting bucket", {
      bucketDir,
      day: dayStamp,
    });
    await fsp.rm(tmpPath, { force: true });
    return res;
  }

  // Swap in the day file. A pre-existing day_<D>.ts here is a crash leftover
  // (no index → never authoritative), and Windows rename won't overwrite it.
  await fsp.rm(finalPath, { force: true });
  await fsp.rename(tmpPath, finalPath);

  // Publish the index (tmp → rename): the atomic authority flip.
  const ifh = await fsp.open(indexTmpPath, "wx");
  try {
    await ifh.writeFile(JSON.stringify(index));
    await ifh.sync().catch(() => undefined);
  } finally {
    await ifh.close();
  }
  await fsp.rm(indexPath, { force: true }); // paranoia only — cannot exist on this path
  await fsp.rename(indexTmpPath, indexPath);

  // Sources are now redundant copies of bytes the index owns.
  for (const p of parts) {
    try {
      await fsp.unlink(path.join(bucketDir, segmentName(p.epoch)));
      res.segmentsRemoved++;
    } catch (err) {
      log.warn("consolidate: failed to delete source segment", {
        bucketDir,
        epoch: p.epoch,
        err: String(err),
      });
    }
  }
  // Crash leftovers of earlier (crashed) passes for this day: passes never
  // overlap in this process, so any other tmp for the day is abandoned.
  await removeDayTmpLeftovers(bucketDir, dayStamp);
  res.daysConsolidated = 1;
  res.bytesConsolidated = totalBytes;
  log.info("consolidated day", {
    bucketDir,
    day: dayStamp,
    segments: parts.length,
    bytes: totalBytes,
  });
  return res;
}

/**
 * One consolidation pass over the whole recordings tree
 * (<recordingsDir>/<homeId>/<cameraId>/<YYYY>/<MM>/<DD>, fixed depth).
 * Errors in one bucket never abort the pass. `nowMs` is injectable for tests.
 */
export async function consolidateOnce(nowMs: number = Date.now()): Promise<ConsolidateResult> {
  const root = config.recordingsDir;
  const todayStamp = utcDayStamp(Math.floor(nowMs / 1000));
  const totals: ConsolidateResult = { daysConsolidated: 0, segmentsRemoved: 0, bytesConsolidated: 0 };

  for (const homeId of await subdirs(root)) {
    for (const cameraId of await subdirs(path.join(root, homeId))) {
      const camDir = path.join(root, homeId, cameraId);
      for (const yyyy of await subdirs(camDir, /^\d{4}$/)) {
        for (const mm of await subdirs(path.join(camDir, yyyy), /^\d{2}$/)) {
          for (const dd of await subdirs(path.join(camDir, yyyy, mm), /^\d{2}$/)) {
            const dayStamp = `${yyyy}${mm}${dd}`;
            // Round-trip guard: impossible date dirs (e.g. month 13) are not buckets.
            if (parseDayFileName(dayFileName(dayStamp)) === null) continue;
            const bucketDir = path.join(camDir, yyyy, mm, dd);
            try {
              const r = await consolidateBucket(bucketDir, dayStamp, todayStamp, nowMs);
              totals.daysConsolidated += r.daysConsolidated;
              totals.segmentsRemoved += r.segmentsRemoved;
              totals.bytesConsolidated += r.bytesConsolidated;
            } catch (err) {
              log.warn("consolidate: bucket failed — continuing", {
                bucketDir,
                err: String(err),
              });
            }
          }
        }
      }
    }
  }

  if (totals.daysConsolidated > 0 || totals.segmentsRemoved > 0) {
    log.info("consolidation pass complete", {
      days: totals.daysConsolidated,
      segmentsRemoved: totals.segmentsRemoved,
      bytesMB: Math.round(totals.bytesConsolidated / (1024 * 1024)),
    });
  }
  return totals;
}

let passInFlight: Promise<ConsolidateResult> | null = null;

/** True while a consolidation pass is running (retention defers tmp cleanup meanwhile). */
export function consolidationRunning(): boolean {
  return passInFlight !== null;
}

/**
 * Run one pass unless one is already running — then join it instead. Passes
 * must never overlap (see the module docs).
 */
export function consolidateExclusive(nowMs?: number): Promise<ConsolidateResult> {
  if (passInFlight) return passInFlight;
  passInFlight = consolidateOnce(nowMs).finally(() => {
    passInFlight = null;
  });
  return passInFlight;
}

/** Start the periodic consolidation loop; returns a stop() handle. */
export function startConsolidationLoop(): () => void {
  const run = (label: string): void => {
    if (passInFlight) {
      log.info("consolidation pass still running — skipping this tick");
      return;
    }
    consolidateExclusive().catch((err) => log.error(label, { err: String(err) }));
  };
  const timer = setInterval(() => run("consolidation loop error"), config.consolidateIntervalMs);
  // Kick off shortly after boot (after retention's 5 s kickoff) so a backlog
  // of finished days starts draining without waiting a whole interval.
  const kickoff = setTimeout(() => run("consolidation kickoff error"), 30_000);
  return () => {
    clearInterval(timer);
    clearTimeout(kickoff);
  };
}
