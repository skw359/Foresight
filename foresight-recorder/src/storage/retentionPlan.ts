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
  /** Which camera the footage belongs to ("<homeId>/<cameraId>"), for fair-share pruning. */
  owner?: string;
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
  /**
   * How disk-pressure pruning picks victims (age expiry is always global):
   *  - "oldest": globally oldest first — one high-bitrate camera (or one Home on
   *    a shared server) can evict everyone else's history.
   *  - "fair" (default): the camera currently using the MOST space loses its
   *    oldest footage first, so storage pressure is shared out between cameras.
   */
  policy?: "fair" | "oldest";
}

export interface RetentionPlan {
  toDelete: SegmentFile[];
  reasons: { age: number; disk: number };
}

/**
 * Decide which segments to delete. Age-expired segments always go. Then, if the
 * remaining total still exceeds the disk cap OR free space is below the floor,
 * delete more (per `policy`) until both constraints are satisfied.
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
  const overBudget = (): boolean => totalBytes > opts.maxBytes || freeBytes < opts.minFreeBytes;
  const take = (seg: SegmentFile): void => {
    toDelete.push(seg);
    totalBytes -= seg.bytes;
    freeBytes += seg.bytes;
    diskCount++;
  };

  if ((opts.policy ?? "fair") === "oldest") {
    // survivors is already oldest-first; drop from the front while over budget.
    for (let i = 0; i < survivors.length && overBudget(); i++) take(survivors[i]!);
    return { toDelete, reasons: { age: ageCount, disk: diskCount } };
  }

  // Fair share: per-owner queues (oldest first) and per-owner byte totals;
  // repeatedly trim the oldest segment of whichever camera holds the most.
  const queues = new Map<string, { segs: SegmentFile[]; next: number; bytes: number }>();
  for (const seg of survivors) {
    const key = seg.owner ?? "";
    let q = queues.get(key);
    if (!q) {
      q = { segs: [], next: 0, bytes: 0 };
      queues.set(key, q);
    }
    q.segs.push(seg);
    q.bytes += seg.bytes;
  }
  while (overBudget()) {
    let victim: { segs: SegmentFile[]; next: number; bytes: number } | null = null;
    for (const q of queues.values()) {
      if (q.next >= q.segs.length) continue;
      if (!victim || q.bytes > victim.bytes) victim = q;
    }
    if (!victim) break;
    const seg = victim.segs[victim.next++]!;
    victim.bytes -= seg.bytes;
    take(seg);
  }

  return { toDelete, reasons: { age: ageCount, disk: diskCount } };
}
