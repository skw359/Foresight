/**
 * Filesystem access to the recorder's on-disk segment tree. Segments are the
 * single source of truth; the server never trusts a DB catalog for playback.
 *
 * Layout (written by foresight-recorder):
 *   RECORDINGS_DIR/<homeId>/<cameraId>/<YYYY>/<MM>/<DD>/seg_<stamp>.ts      # live + recent days
 *   RECORDINGS_DIR/<homeId>/<cameraId>/<YYYY>/<MM>/<DD>/day_<YYYYMMDD>.ts   # consolidated old day
 *   RECORDINGS_DIR/<homeId>/<cameraId>/<YYYY>/<MM>/<DD>/day_<YYYYMMDD>.json # its byte-window index
 *
 * The recorder runs ffmpeg with TZ=UTC, so the YYYY/MM/DD buckets are UTC and
 * the server can derive a segment's bucket from its epoch deterministically
 * (no timezone coupling). Listing walks the tree regardless of bucket naming,
 * so even if a segment lands in an unexpected bucket it is still discovered.
 *
 * Consolidated days: the recorder folds each finished UTC day into ONE
 * `day_<D>.ts` (raw byte concat of that day's segments in epoch order) plus a
 * small JSON index of per-segment byte windows (`DayIndex` in the contract).
 * THE PRESENCE OF THE .json INDEX FLIPS AUTHORITY for that day to the day
 * file: listing expands the index into SegmentRefs carrying byteRange +
 * container (sizes come from the index — no stats), and DEDUPES against any
 * loose crash leftovers of the same epochs, preferring the index entry.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { finished, pipeline } from "node:stream/promises";
import { config } from "../config.js";
import {
  dayIndexFileName,
  dayIndexToRefs,
  isDayIndex,
  parseDayFileName,
  parseSegmentName,
  utcDayStamp,
  type DayIndex,
  type DayIndexSegment,
  type SegmentRef,
} from "@foresight/contract";
import { isPathWithin } from "./pathGuard.js";

export { isPathWithin } from "./pathGuard.js";

/** Absolute directory holding a single camera's segments. */
export function cameraDir(homeId: string, cameraId: string): string {
  return path.join(config.recordingsDir, homeId, cameraId);
}

/** Compute the UTC date bucket (YYYY/MM/DD) a given epoch-seconds falls into. */
function utcBucket(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return path.join(
    String(d.getUTCFullYear()),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  );
}

/**
 * Resolve a segment filename to a safe absolute path inside `dir`, or null when
 * the name is malformed (traversal guard via parseSegmentName) or the file is
 * absent. Tries the deterministic UTC bucket first, then falls back to a tree
 * scan for resilience to clock/timezone surprises.
 */
export async function safeSegmentPath(dir: string, name: string): Promise<string | null> {
  const epoch = parseSegmentName(name); // null for anything but seg_<digits>.ts
  if (epoch === null) return null;

  const candidate = path.join(dir, utcBucket(epoch), name);
  if (isPathWithin(dir, candidate) && (await exists(candidate))) return candidate;

  // Fallback: locate by filename anywhere under the camera dir (still guarded).
  const found = await findByName(dir, name);
  return found && isPathWithin(dir, found) ? found : null;
}

/**
 * Resolve a consolidated day filename (`day_<YYYYMMDD>.ts`) to a safe absolute
 * path inside `dir`, or null when the name is malformed (parseDayFileName is
 * the traversal guard) or no such file exists. The day's UTC start epoch pins
 * the deterministic bucket; like safeSegmentPath, a tree scan backs it up so a
 * day file the listing discovered in a surprise bucket is still servable.
 */
export async function safeDayFilePath(dir: string, name: string): Promise<string | null> {
  const dayStartEpoch = parseDayFileName(name); // null for anything but day_<8 digits>.ts
  if (dayStartEpoch === null) return null;

  const candidate = path.join(dir, utcBucket(dayStartEpoch), name);
  if (isPathWithin(dir, candidate) && (await exists(candidate))) return candidate;

  const found = await findByName(dir, name);
  return found && isPathWithin(dir, found) ? found : null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- Day indexes

/** Filename shape of a day index; content is validated separately (isDayIndex). */
const DAY_INDEX_NAME_RE = /^day_\d{8}\.json$/;

/**
 * Paths whose day index failed validation, so each broken file is warned about
 * once instead of on every listing (listings repeat every few seconds).
 */
const invalidIndexWarned = new Set<string>();

/**
 * Read + strictly validate a day index. Returns null (never throws) when the
 * file is missing (consolidator/retention race — silent), unparseable, or
 * fails isDayIndex (warn once per path: a broken index means that day's
 * footage is invisible until the consolidator rebuilds it, worth surfacing).
 */
export async function readDayIndex(indexPath: string): Promise<DayIndex | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(indexPath, "utf8");
  } catch {
    return null; // vanished mid-walk — expected under concurrent retention
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* fall through to the isDayIndex(null) failure below */
  }
  if (!isDayIndex(parsed)) {
    if (!invalidIndexWarned.has(indexPath)) {
      invalidIndexWarned.add(indexPath);
      console.warn(`[recordings] ignoring invalid day index: ${indexPath}`);
    }
    return null;
  }
  return parsed;
}

/** A loose seg_*.ts as discovered by the tree walk. */
interface LooseSegmentFile {
  epoch: number;
  name: string;
  /** Absolute path at the location the walk found it. */
  path: string;
}

/** A validated day index together with where it lives on disk. */
interface LoadedDayIndex {
  /** Absolute path of the day_<D>.json file. */
  indexPath: string;
  /** Directory holding the index — its day file sits beside it. */
  bucketDir: string;
  index: DayIndex;
}

/**
 * One recursive walk of a camera dir: loose segments (bounded by the inclusive
 * [fromEpoch, toEpoch] start-epoch window) plus every VALID day index found
 * anywhere in the tree (indexes are per-day and tiny, so they are returned
 * unbounded — callers window their entries). Invalid indexes are skipped, never
 * thrown on. Returns empty results when the dir does not exist yet.
 */
async function scanTree(
  dir: string,
  fromEpoch?: number,
  toEpoch?: number,
): Promise<{ loose: LooseSegmentFile[]; indexes: LoadedDayIndex[] }> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return { loose: [], indexes: [] };
  }

  const loose: LooseSegmentFile[] = [];
  const found: Array<{ indexPath: string; bucketDir: string }> = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (DAY_INDEX_NAME_RE.test(e.name)) {
      const bucketDir = direntParent(e, dir);
      found.push({ indexPath: path.join(bucketDir, e.name), bucketDir });
      continue;
    }
    const epoch = parseSegmentName(e.name);
    if (epoch === null) continue;
    if (fromEpoch !== undefined && epoch < fromEpoch) continue;
    if (toEpoch !== undefined && epoch > toEpoch) continue;
    loose.push({ epoch, name: e.name, path: path.join(direntParent(e, dir), e.name) });
  }

  // One tiny JSON read per day — a ~30-day retention is ~30 reads, nothing
  // next to the readdir above, so plain sequential I/O is fine here.
  const indexes: LoadedDayIndex[] = [];
  for (const f of found) {
    const index = await readDayIndex(f.indexPath);
    if (index) indexes.push({ ...f, index });
  }
  return { loose, indexes };
}

/**
 * How many stat() calls listSegments keeps in flight at once. Serial stats are
 * the killer on Windows (each is a full filesystem round-trip): 200k segments
 * statted one-by-one takes minutes, while a few dozen in flight amortizes the
 * per-call latency without flooding the volume with I/O.
 */
const STAT_CONCURRENCY = 48;

export interface ListSegmentsOptions {
  /**
   * Stat each LOOSE segment file for its byte size (default true). Playlist
   * generation only needs epoch + name, so callers that don't display sizes
   * should pass false and skip the stat sweep entirely — it is by far the
   * dominant cost of a large listing. Consolidated refs are unaffected: their
   * sizes come from the day index and are always present.
   */
  withBytes?: boolean;
}

/**
 * List every segment under a camera dir, optionally bounded by start-epoch
 * [fromEpoch, toEpoch] (inclusive). Merges loose seg_*.ts files with the
 * expanded entries of every valid day_*.json index — consolidated refs carry
 * `byteRange` + `container` and their index-recorded sizes (no stat needed).
 * A segment present BOTH loose and indexed (crash leftover) is reported once,
 * from the index (authority invariant). Returns SegmentRefs sorted
 * oldest-first; loose bytes are 0 when `withBytes` is false. Returns [] when
 * the dir does not exist yet.
 */
export async function listSegments(
  dir: string,
  fromEpoch?: number,
  toEpoch?: number,
  opts: ListSegmentsOptions = {},
): Promise<SegmentRef[]> {
  const { loose, indexes } = await scanTree(dir, fromEpoch, toEpoch);

  // Expand day indexes; the [from,to] window applies to the expanded refs.
  const consolidated = new Map<number, SegmentRef>();
  for (const { index } of indexes) {
    for (const ref of dayIndexToRefs(index)) {
      if (fromEpoch !== undefined && ref.epoch < fromEpoch) continue;
      if (toEpoch !== undefined && ref.epoch > toEpoch) continue;
      consolidated.set(ref.epoch, ref);
    }
  }

  // Dedupe BEFORE the stat sweep: leftovers lose to the index entry anyway, so
  // statting them would be paying I/O for a size we'd never report.
  const files =
    consolidated.size === 0 ? loose : loose.filter((f) => !consolidated.has(f.epoch));

  const out: SegmentRef[] = files.map((f) => ({ epoch: f.epoch, name: f.name, bytes: 0 }));
  if (opts.withBytes !== false) {
    // Bounded-concurrency stat sweep: a shared cursor + N workers, so at most
    // STAT_CONCURRENCY stats are in flight regardless of tree size.
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const i = cursor++;
        if (i >= files.length) return;
        try {
          out[i]!.bytes = (await fsp.stat(files[i]!.path)).size;
        } catch {
          /* file vanished mid-list (pruned/consolidated) — keep the ref, skip its size */
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(STAT_CONCURRENCY, files.length) }, worker),
    );
  }

  for (const ref of consolidated.values()) out.push(ref);
  out.sort((a, b) => a.epoch - b.epoch);
  return out;
}

/**
 * Look up one epoch's byte window inside its (deterministic) day file, for
 * serving a consolidated segment that a stale playlist still references by its
 * old seg_* name. Reads the epoch's UTC-day index from the deterministic
 * bucket; returns null when the day is not consolidated, the index is invalid,
 * the epoch is not listed, or the day file itself is missing.
 */
export async function lookupConsolidatedSegment(
  dir: string,
  epoch: number,
): Promise<{ dayFilePath: string; offset: number; bytes: number } | null> {
  const bucketDir = path.join(dir, utcBucket(epoch));
  const indexPath = path.join(bucketDir, dayIndexFileName(utcDayStamp(epoch)));
  if (!isPathWithin(dir, indexPath)) return null;

  const index = await readDayIndex(indexPath);
  if (!index) return null;
  const entry = index.segments.find((s) => s.epoch === epoch);
  if (!entry) return null;

  const dayFilePath = path.join(bucketDir, index.file); // index.file is validated canonical
  if (!isPathWithin(dir, dayFilePath) || !(await exists(dayFilePath))) return null;
  return { dayFilePath, offset: entry.offset, bytes: entry.bytes };
}

/**
 * Seconds after UTC midnight during which the live tail can still (partly)
 * live in the PREVIOUS day's bucket. The rolling live window is only ~36s
 * (6 × 6s segments), so a few minutes of grace is generous; the cost of being
 * generous is one extra single-day readdir, which is cheap.
 */
export const PREVIOUS_DAY_GRACE_SECONDS = 300;

const DAY_SECONDS = 86_400;

/**
 * List only the segments that can contain the live tail: the current UTC day
 * bucket, plus the previous day's bucket within a short window after UTC
 * midnight (so a tail spanning midnight isn't lost). The recorder writes UTC
 * buckets, so the newest segments are always here — walking the whole 14-day
 * tree (~200k files) on every hls.js live refresh is pure waste. Byte sizes
 * are skipped: playlists only use epoch + name. Consolidation never touches
 * the live day (nor yesterday within the grace window — the consolidator's
 * one-hour quiet rule covers it), so this path never sees day files.
 *
 * `nowEpochSeconds` is injectable for tests; production callers omit it.
 */
export async function listRecentSegments(
  dir: string,
  nowEpochSeconds: number = Math.floor(Date.now() / 1000),
): Promise<SegmentRef[]> {
  const buckets = [path.join(dir, utcBucket(nowEpochSeconds))];
  if (nowEpochSeconds % DAY_SECONDS < PREVIOUS_DAY_GRACE_SECONDS) {
    buckets.unshift(path.join(dir, utcBucket(nowEpochSeconds - DAY_SECONDS)));
  }
  const lists = await Promise.all(
    buckets.map((b) => listSegments(b, undefined, undefined, { withBytes: false })),
  );
  // Buckets are listed oldest-day-first and each list is sorted, but re-sort
  // the merged result anyway — it's at most ~2 days of names and keeps the
  // "sorted oldest-first" contract obviously true.
  const out = lists.flat();
  out.sort((a, b) => a.epoch - b.epoch);
  return out;
}

// ---------------------------------------------------------------- Listing cache
//
// Full-tree listings (coverage endpoint + range playlists) are the expensive
// path: one readdir over ~200k files plus a stat sweep. The dashboard hits
// them repeatedly (coverage on load, range playlist refreshes while scrubbing),
// so a short per-camera TTL cache turns the repeats into memory reads. 15s of
// staleness is acceptable — the recorder only prunes on a 10-minute cadence —
// EXCEPT for the server's own delete route, which must invalidate so the UI
// reflects the deletion immediately (deleteSegments below does exactly that).

interface ListingCacheEntry {
  /** Full-tree MERGED listing (loose + consolidated), sorted oldest-first. */
  refs: SegmentRef[];
  /** Date.now() when the listing completed. */
  at: number;
}

/** How long a cached full-tree listing stays fresh. */
export const LISTING_CACHE_TTL_MS = 15_000;

/**
 * Memory bound: entries are evicted oldest-inserted-first past this many
 * cameras. Refs are small (~3 fields), so even 200k-segment cameras cost only
 * a few MB each; 32 concurrent cameras is far beyond a single home's needs.
 */
const LISTING_CACHE_MAX_CAMERAS = 32;

const listingCache = new Map<string, ListingCacheEntry>();

/**
 * Cached variant of listSegments for full-tree consumers (coverage + range
 * playlists). Serves from the per-camera cache when fresh, otherwise lists the
 * whole tree (with bytes) and caches it. Bounds are applied by filtering the
 * cached listing in memory — an O(n) pass, trivially cheap next to the I/O it
 * replaces. Treat the returned array as read-only: unbounded calls share the
 * cached array.
 */
export async function listSegmentsCached(
  dir: string,
  fromEpoch?: number,
  toEpoch?: number,
): Promise<SegmentRef[]> {
  const hit = listingCache.get(dir);
  let refs: SegmentRef[];
  if (hit && Date.now() - hit.at < LISTING_CACHE_TTL_MS) {
    refs = hit.refs;
  } else {
    refs = await listSegments(dir);
    // Delete-then-set so refresh moves the key to the back of the Map's
    // insertion order, making the size bound evict the least-recently-listed.
    listingCache.delete(dir);
    listingCache.set(dir, { refs, at: Date.now() });
    if (listingCache.size > LISTING_CACHE_MAX_CAMERAS) {
      const oldest = listingCache.keys().next().value;
      if (oldest !== undefined) listingCache.delete(oldest);
    }
  }
  if (fromEpoch === undefined && toEpoch === undefined) return refs;
  return refs.filter(
    (r) =>
      (fromEpoch === undefined || r.epoch >= fromEpoch) &&
      (toEpoch === undefined || r.epoch <= toEpoch),
  );
}

/**
 * Drop the cached listing for one camera dir. Called by deleteSegments; also
 * exported so anything else that mutates the tree can keep the cache honest.
 */
export function invalidateListingCache(dir: string): void {
  listingCache.delete(dir);
}

// ------------------------------------------------------------------ Clip pieces

/** One ordered byte source for the clip remux pipeline. */
export interface ClipPiece {
  /** Absolute path to read from (a loose segment or a consolidated day file). */
  path: string;
  /** First byte to read (inclusive). Omitted → the whole file. */
  start?: number;
  /** Last byte to read (INCLUSIVE — createReadStream semantics). */
  end?: number;
}

/**
 * Resolve epoch-ordered SegmentRefs (as returned by listSegments) into the
 * ordered byte pieces to feed ffmpeg: consolidated refs become byte windows
 * into their (guard-resolved) day file, loose refs become whole files. Refs
 * that can no longer be resolved are skipped — including the race where a
 * loose segment was consolidated between listing and resolving, which falls
 * back to its day-index byte window so an in-flight export still completes.
 */
export async function resolveClipPieces(dir: string, refs: SegmentRef[]): Promise<ClipPiece[]> {
  const pieces: ClipPiece[] = [];
  // Resolve each container path once — a day can contribute thousands of refs.
  const containerPaths = new Map<string, string | null>();
  for (const ref of refs) {
    if (ref.byteRange && ref.container) {
      let dayPath = containerPaths.get(ref.container);
      if (dayPath === undefined) {
        dayPath = await safeDayFilePath(dir, ref.container);
        containerPaths.set(ref.container, dayPath);
      }
      if (!dayPath) continue;
      pieces.push({
        path: dayPath,
        start: ref.byteRange.offset,
        end: ref.byteRange.offset + ref.byteRange.length - 1,
      });
      continue;
    }
    const loosePath = await safeSegmentPath(dir, ref.name);
    if (loosePath) {
      pieces.push({ path: loosePath });
      continue;
    }
    const slice = await lookupConsolidatedSegment(dir, ref.epoch);
    if (slice) {
      pieces.push({
        path: slice.dayFilePath,
        start: slice.offset,
        end: slice.offset + slice.bytes - 1,
      });
    }
  }
  return pieces;
}

/**
 * Pipe every piece into `dest` sequentially with backpressure (pipeline with
 * `end: false` per piece), then end `dest` after the last one. Rejects on the
 * first failed piece — callers decide how to treat EPIPE-style errors (e.g.
 * ffmpeg exiting early is benign for the clip route).
 */
export async function pipePieces(
  pieces: ClipPiece[],
  dest: NodeJS.WritableStream,
): Promise<void> {
  for (const piece of pieces) {
    const src =
      piece.start !== undefined
        ? fs.createReadStream(piece.path, { start: piece.start, end: piece.end })
        : fs.createReadStream(piece.path);
    await pipeline(src, dest, { end: false });
  }
  dest.end();
}

// ---------------------------------------------------------------------- Delete

/**
 * Permanently delete every segment whose start epoch falls in the half-open
 * window [fromEpoch, toEpoch) under a camera dir (the segments backing one
 * coverage span — `span.end` is exclusive). Handles both worlds:
 *
 *   - LOOSE seg_*.ts files in the window are unlinked one by one.
 *   - CONSOLIDATED days: a day whose indexed epochs all fall inside the window
 *     loses its day file + index outright; a PARTIALLY covered day is rewritten
 *     in place — the kept entries' byte windows are streamed into a fresh
 *     `day_<D>.ts` and a recomputed index (offsets contiguous from 0) swapped
 *     in, so freed bytes are exact (old size − new size).
 *
 * Returns how many segments were removed and the bytes freed. Resilient to
 * files that vanish mid-delete (the recorder's retention may prune
 * concurrently); a day whose rewrite fails is skipped rather than failing the
 * whole request. Now-empty date-bucket directories are pruned afterwards; the
 * camera dir itself is kept.
 *
 * Always invalidates this camera's listing cache: the delete route's caller
 * refetches coverage immediately, and serving a cached pre-delete listing
 * would make the UI show footage that no longer exists.
 */
export async function deleteSegments(
  dir: string,
  fromEpoch: number,
  toEpoch: number,
): Promise<{ deletedSegments: number; deletedBytes: number }> {
  try {
    // Deliberately uncached: deleting must see the tree as it IS. scanTree's
    // loose bounds are inclusive; the exclusive end is applied below.
    const { loose, indexes } = await scanTree(dir, fromEpoch, toEpoch);
    let deletedSegments = 0;
    let deletedBytes = 0;

    // Loose files — including crash leftovers that are ALSO indexed: the
    // leftover file is real disk usage in the window, so it is removed and its
    // actual size counted (the indexed copy is handled separately below).
    for (const f of loose) {
      if (f.epoch >= toEpoch) continue;
      try {
        const size = (await fsp.stat(f.path)).size;
        await fsp.unlink(f.path);
        deletedSegments += 1;
        deletedBytes += size;
      } catch {
        /* already gone (pruned concurrently) — count nothing, keep going */
      }
    }

    // Consolidated days.
    for (const { indexPath, bucketDir, index } of indexes) {
      const inWindow = (s: DayIndexSegment) => s.epoch >= fromEpoch && s.epoch < toEpoch;
      const removed = index.segments.filter(inWindow);
      if (removed.length === 0) continue; // day untouched
      const kept = index.segments.filter((s) => !inWindow(s));

      const dayFilePath = path.join(bucketDir, index.file); // index.file is validated canonical
      if (!isPathWithin(dir, dayFilePath) || !isPathWithin(dir, indexPath)) continue;

      try {
        if (kept.length === 0) {
          // Whole day inside the window: drop the pair. Media first — if it is
          // held open (a viewer mid-stream on Windows), keep the pair intact
          // and skip, so the index never describes a missing file.
          let freed = index.totalBytes;
          try {
            await fsp.unlink(dayFilePath);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") continue;
            freed = 0; // file already gone — still retire the orphaned index
          }
          await fsp.unlink(indexPath).catch(() => undefined);
          deletedSegments += removed.length;
          deletedBytes += freed;
        } else {
          const newTotal = await rewriteDayFile(dayFilePath, indexPath, index, kept);
          deletedSegments += removed.length;
          deletedBytes += index.totalBytes - newTotal;
        }
      } catch {
        /* rewrite failed (day file busy/vanished) — skip this day, count nothing */
      }
    }

    await pruneEmptyDirs(dir);
    return { deletedSegments, deletedBytes };
  } finally {
    // In a finally so even a partial delete (unexpected throw) can't leave a
    // stale pre-delete listing behind.
    invalidateListingCache(dir);
  }
}

/**
 * Rewrite a consolidated day down to `kept` (epoch-ascending, a strict subset
 * of index.segments): stream each kept byte window into `day_<D>.ts.tmp`,
 * write the recomputed index (offsets contiguous from 0, exact totalBytes) to
 * `day_<D>.json.tmp`, then swap — Windows rename won't overwrite, so each
 * final is unlinked before its rename, media first, then index (the gap where
 * neither index nor a matching file exists is two local renames wide).
 * Returns the new day file's total bytes. Throws on failure with the tmp files
 * best-effort removed; the caller skips the day.
 */
async function rewriteDayFile(
  dayFilePath: string,
  indexPath: string,
  index: DayIndex,
  kept: DayIndexSegment[],
): Promise<number> {
  const newSegments: DayIndexSegment[] = [];
  let offset = 0;
  for (const s of kept) {
    newSegments.push({ epoch: s.epoch, offset, bytes: s.bytes, duration: s.duration });
    offset += s.bytes;
  }
  const newIndex: DayIndex = {
    version: 1,
    day: index.day,
    file: index.file,
    totalBytes: offset,
    segments: newSegments,
  };
  // Never swap in an index readers would reject (impossible unless the source
  // index lied, since isDayIndex validated it on read).
  if (!isDayIndex(newIndex)) throw new Error(`rewritten day index invalid: ${indexPath}`);

  // Unique, exclusive tmp names: two concurrent deletes touching the same day
  // (or a recorder consolidation leftover) must never share a tmp file.
  const tag = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const tmpTs = `${dayFilePath}.${tag}.tmp`;
  const tmpJson = `${indexPath}.${tag}.tmp`;
  const out = fs.createWriteStream(tmpTs, { flags: "wx" });
  try {
    await pipePieces(
      kept.map((s) => ({ path: dayFilePath, start: s.offset, end: s.offset + s.bytes - 1 })),
      out,
    );
    await finished(out); // fs streams resolve on 'close' — fd released before the swap
    await fsp.writeFile(tmpJson, JSON.stringify(newIndex), { flag: "wx" });
  } catch (err) {
    out.destroy();
    await fsp.rm(tmpTs, { force: true }).catch(() => undefined);
    await fsp.rm(tmpJson, { force: true }).catch(() => undefined);
    throw err;
  }

  await fsp.unlink(dayFilePath);
  await fsp.rename(tmpTs, dayFilePath);
  await fsp.unlink(indexPath);
  await fsp.rename(tmpJson, indexPath);
  return offset;
}

/** Remove empty subdirectories under `root` (bottom-up). `root` itself is kept. */
async function pruneEmptyDirs(root: string): Promise<void> {
  async function walk(d: string): Promise<boolean> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return false; // unreadable/missing — treat as non-empty so it's left alone
    }
    let empty = true;
    for (const e of entries) {
      if (!e.isDirectory()) {
        empty = false;
        continue;
      }
      const child = path.join(d, e.name);
      if (await walk(child)) {
        await fsp.rmdir(child).catch(() => undefined);
      } else {
        empty = false;
      }
    }
    return empty;
  }
  await walk(root);
}

/** Node 20.12+ exposes Dirent.parentPath; older exposed .path. Fall back to dir. */
function direntParent(e: fs.Dirent, dir: string): string {
  const anyE = e as unknown as { parentPath?: string; path?: string };
  return anyE.parentPath ?? anyE.path ?? dir;
}

async function findByName(dir: string, name: string): Promise<string | null> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name === name) return path.join(direntParent(e, dir), e.name);
  }
  return null;
}
