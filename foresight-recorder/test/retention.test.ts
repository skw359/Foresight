import { describe, expect, it } from "vitest";
import { planRetention, type SegmentFile } from "../src/storage/retentionPlan.js";

const DAY = 86400;
const NOW_EPOCH = 1_000_000; // arbitrary "now" in epoch seconds
const NOW_MS = NOW_EPOCH * 1000;

function seg(epoch: number, bytes: number): SegmentFile {
  return { path: `/rec/seg_${epoch}.ts`, epoch, bytes };
}

describe("planRetention", () => {
  it("deletes only segments older than retentionDays", () => {
    const segs = [
      seg(NOW_EPOCH - 20 * DAY, 100), // expired
      seg(NOW_EPOCH - 5 * DAY, 100), // kept
      seg(NOW_EPOCH - 1 * DAY, 100), // kept
    ];
    const plan = planRetention(segs, {
      retentionDays: 14,
      maxBytes: Infinity,
      minFreeBytes: 0,
      freeBytes: Infinity,
      nowMs: NOW_MS,
    });
    expect(plan.toDelete.map((s) => s.epoch)).toEqual([NOW_EPOCH - 20 * DAY]);
    expect(plan.reasons).toEqual({ age: 1, disk: 0 });
  });

  it("enforces the disk cap by dropping the oldest segments first", () => {
    const segs = [seg(100, 50), seg(200, 50), seg(300, 50)]; // 150 bytes total
    const plan = planRetention(segs, {
      retentionDays: 14,
      maxBytes: 100, // must get under 100
      minFreeBytes: 0,
      freeBytes: Infinity,
      nowMs: 300 * 1000, // nothing age-expires
    });
    expect(plan.toDelete.map((s) => s.epoch)).toEqual([100]);
    expect(plan.reasons).toEqual({ age: 0, disk: 1 });
  });

  it("frees space until min-free is satisfied", () => {
    const segs = [seg(100, 50), seg(200, 50), seg(300, 50)];
    const plan = planRetention(segs, {
      retentionDays: 14,
      maxBytes: Infinity,
      minFreeBytes: 120,
      freeBytes: 0,
      nowMs: 300 * 1000,
    });
    // 0 free; each delete reclaims 50 → need 3 to reach >=120.
    expect(plan.toDelete.length).toBe(3);
    expect(plan.reasons.disk).toBe(3);
  });

  it("counts age-reclaimed bytes toward free space before disk pruning", () => {
    const segs = [seg(NOW_EPOCH - 20 * DAY, 50), seg(NOW_EPOCH - 1 * DAY, 50)];
    const plan = planRetention(segs, {
      retentionDays: 14,
      maxBytes: Infinity,
      minFreeBytes: 40,
      freeBytes: 0,
      nowMs: NOW_MS,
    });
    // The expired segment alone reclaims 50 >= 40, so no extra disk pruning.
    expect(plan.reasons).toEqual({ age: 1, disk: 0 });
    expect(plan.toDelete).toHaveLength(1);
  });

  it("keeps everything when under both limits", () => {
    const segs = [seg(NOW_EPOCH - 1 * DAY, 10), seg(NOW_EPOCH, 10)];
    const plan = planRetention(segs, {
      retentionDays: 14,
      maxBytes: Infinity,
      minFreeBytes: 0,
      freeBytes: Infinity,
      nowMs: NOW_MS,
    });
    expect(plan.toDelete).toHaveLength(0);
  });
});
