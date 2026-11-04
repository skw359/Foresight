/**
 * Pure retention planning — the DECISION of which segments to delete, isolated
 * from config + filesystem so it can be unit-tested directly. The runner in
 * retention.ts measures disk/free-space and applies the plan.
 */

/** A segment on disk, as the planner sees it. */
export interface SegmentFile {
  path: string;
  /**
   * Start epoch SECONDS (from the filename). A consolidated day file is one
   * SegmentFile stamped with its day's LAST second (start + 86399), so age
   * expiry fires only once the entire day is out of retention.
   */
  epoch: number;
  bytes: number;
  /**
   * Consolidated day files only: the sibling day_<YYYYMMDD>.json index, which
   * the runner unlinks together with the day file.
   */
  indexPath?: string;
}

export interface RetentionOptions {
  /** Delete segments whose start is older than this many days. */
  retentionDays: number;
  /** Hard cap on total bytes of the recordings tree. */
  maxBytes: number;
  /** Delete oldest until at least this many free bytes are available. */
  minFreeBytes: number;
  /** Current free bytes on the recordings volume (measured by the runner). */
  freeBytes: number;
  /** "now" in epoch milliseconds (injectable for tests). */
  nowMs: number;
}

export interface RetentionPlan {
  toDelete: SegmentFile[];
  reasons: { age: number; disk: number };
}

/**
 * Decide which segments to delete. Age-expired segments always go. Then, if the
 * remaining total still exceeds the disk cap OR free space is below the floor,
 * delete the oldest remaining segments until both constraints are satisfied.
 * Deterministic and side-effect free.
 */
export function planRetention(segments: SegmentFile[], opts: RetentionOptions): RetentionPlan {
  const sorted = [...segments].sort((a, b) => a.epoch - b.epoch); // oldest first
  const cutoffEpoch = opts.nowMs / 1000 - opts.retentionDays * 86400;
  const toDelete: SegmentFile[] = [];
  let ageCount = 0;

  const survivors: SegmentFile[] = [];
  for (const seg of sorted) {
    if (seg.epoch < cutoffEpoch) {
      toDelete.push(seg);
      ageCount++;
    } else {
      survivors.push(seg);
    }
  }

  let totalBytes = survivors.reduce((sum, s) => sum + s.bytes, 0);
  const reclaimedForFree = toDelete.reduce((sum, s) => sum + s.bytes, 0);
  let freeBytes = opts.freeBytes + reclaimedForFree;
  let diskCount = 0;

  // survivors is already oldest-first; drop from the front while over budget.
  let i = 0;
  while (i < survivors.length && (totalBytes > opts.maxBytes || freeBytes < opts.minFreeBytes)) {
    const seg = survivors[i]!;
    toDelete.push(seg);
    totalBytes -= seg.bytes;
    freeBytes += seg.bytes;
    diskCount++;
    i++;
  }

  return { toDelete, reasons: { age: ageCount, disk: diskCount } };
}
