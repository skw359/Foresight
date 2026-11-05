/**
 * REC-07: under disk pressure, "fair" retention trims the camera holding the
 * most footage first, so one high-bitrate camera (or another Home on a shared
 * server) can't evict everyone else's history; "oldest" keeps the old FIFO.
 */
import { describe, expect, it } from "vitest";
import { planRetention, type SegmentFile } from "../src/storage/retentionPlan.js";

const now = Date.UTC(2026, 10, 5) ;
const seg = (owner: string, epoch: number, bytes: number): SegmentFile => ({
  path: `/${owner}/${epoch}`,
  epoch,
  bytes,
  owner,
});

// Camera A: old, small segments. Camera B: newer but 10x bigger.
const base = now / 1000 - 3600;
const segments = [
  ...Array.from({ length: 10 }, (_, i) => seg("h1/a", base + i * 6, 100)),
  ...Array.from({ length: 10 }, (_, i) => seg("h2/b", base + 600 + i * 6, 1000)),
];
const opts = { retentionDays: 14, maxBytes: 8000, minFreeBytes: 0, freeBytes: 1e12, nowMs: now };

describe("retention policy", () => {
  it("oldest-first evicts the small camera's whole history", () => {
    const plan = planRetention(segments, { ...opts, policy: "oldest" });
    const owners = new Set(plan.toDelete.map((s) => s.owner));
    expect(owners.has("h1/a")).toBe(true);
  });

  it("fair share trims the camera using the most space and keeps the small one intact", () => {
    const plan = planRetention(segments, { ...opts, policy: "fair" });
    expect(plan.toDelete.every((s) => s.owner === "h2/b")).toBe(true);
    // Budget met: 11000 total → ≤ 8000 needs three of B's 1000-byte segments, oldest first.
    expect(plan.toDelete.map((s) => s.epoch)).toEqual([base + 600, base + 606, base + 612]);
  });
});
