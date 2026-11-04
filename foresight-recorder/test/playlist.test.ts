import { describe, expect, it } from "vitest";
import {
  computeSegments,
  coverageSpans,
  renderPlaylist,
  type SegmentRef,
} from "@foresight/contract";

// Three contiguous 6-second segments.
const contiguous: SegmentRef[] = [
  { epoch: 1000, name: "seg_1000.ts", bytes: 10 },
  { epoch: 1006, name: "seg_1006.ts", bytes: 10 },
  { epoch: 1012, name: "seg_1012.ts", bytes: 10 },
];

describe("computeSegments", () => {
  it("derives each duration from the next segment's start", () => {
    const segs = computeSegments(contiguous, { segmentSeconds: 6 });
    expect(segs.map((s) => s.duration)).toEqual([6, 6, 6]);
    expect(segs.some((s) => s.discontinuity)).toBe(false);
  });

  it("falls back to the nominal duration for the final segment", () => {
    const segs = computeSegments(contiguous, { segmentSeconds: 6 });
    expect(segs[segs.length - 1]!.duration).toBe(6);
  });

  it("marks a discontinuity across a gap", () => {
    const gapped = [...contiguous, { epoch: 2000, name: "seg_2000.ts", bytes: 10 }];
    const segs = computeSegments(gapped, { segmentSeconds: 6 });
    expect(segs[3]!.discontinuity).toBe(true);
    expect(segs.slice(0, 3).some((s) => s.discontinuity)).toBe(false);
  });

  it("sorts unordered input by start epoch", () => {
    const shuffled = [contiguous[2]!, contiguous[0]!, contiguous[1]!];
    expect(computeSegments(shuffled).map((s) => s.epoch)).toEqual([1000, 1006, 1012]);
  });
});

describe("renderPlaylist", () => {
  it("renders a finite VOD playlist for range mode", () => {
    const m = renderPlaylist(contiguous, { mode: "range", uri: (n) => `seg/${n}` });
    expect(m).toContain("#EXTM3U");
    expect(m).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(m).toContain("#EXT-X-ENDLIST");
    expect(m).toContain("#EXT-X-PROGRAM-DATE-TIME:");
    expect(m).toContain("seg/seg_1000.ts");
    expect(m).toContain("#EXTINF:6.000,");
  });

  it("omits ENDLIST for a live (rolling) playlist", () => {
    const m = renderPlaylist(contiguous, { mode: "live", uri: (n) => n });
    expect(m).not.toContain("#EXT-X-ENDLIST");
    expect(m).not.toContain("#EXT-X-PLAYLIST-TYPE:VOD");
  });

  it("inserts a DISCONTINUITY tag across gaps", () => {
    const gapped = [...contiguous, { epoch: 5000, name: "seg_5000.ts", bytes: 10 }];
    const m = renderPlaylist(gapped, { mode: "range", uri: (n) => n });
    expect(m).toContain("#EXT-X-DISCONTINUITY");
  });

  it("sets TARGETDURATION to the ceil of the longest segment", () => {
    const m = renderPlaylist(contiguous, { mode: "range", uri: (n) => n });
    expect(m).toContain("#EXT-X-TARGETDURATION:6");
  });

  it("honors a custom media sequence", () => {
    const m = renderPlaylist(contiguous, { mode: "live", uri: (n) => n, mediaSequence: 42 });
    expect(m).toContain("#EXT-X-MEDIA-SEQUENCE:42");
  });
});

describe("coverageSpans", () => {
  it("collapses contiguous segments and splits on gaps", () => {
    const refs: SegmentRef[] = [
      { epoch: 1000, name: "seg_1000.ts", bytes: 5 },
      { epoch: 1006, name: "seg_1006.ts", bytes: 5 },
      { epoch: 9000, name: "seg_9000.ts", bytes: 7 },
    ];
    const spans = coverageSpans(refs, { segmentSeconds: 6 });
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ startEpoch: 1000, segments: 2, bytes: 10 });
    expect(spans[1]).toMatchObject({ startEpoch: 9000, segments: 1, bytes: 7 });
  });

  it("returns no spans for empty input", () => {
    expect(coverageSpans([])).toEqual([]);
  });

  it("attributes each segment's bytes to its own span, even from unsorted input", () => {
    // Distinct byte sizes per segment so a wrong lookup (or a lookup against
    // the unsorted input order) would produce a detectably wrong sum.
    const refs: SegmentRef[] = [
      { epoch: 9000, name: "seg_9000.ts", bytes: 400 },
      { epoch: 1006, name: "seg_1006.ts", bytes: 20 },
      { epoch: 1000, name: "seg_1000.ts", bytes: 10 },
      { epoch: 9006, name: "seg_9006.ts", bytes: 800 },
    ];
    const spans = coverageSpans(refs, { segmentSeconds: 6 });
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ startEpoch: 1000, endEpoch: 1012, segments: 2, bytes: 30 });
    expect(spans[1]).toMatchObject({ startEpoch: 9000, endEpoch: 9012, segments: 2, bytes: 1200 });
  });

  it("handles a 14-day-retention-sized listing quickly (linear, not quadratic)", () => {
    // 50k synthetic refs ≈ 3.5 days of 24/7 6s segments. The old per-segment
    // refs.find() made this O(n²) (~2.5 billion comparisons — many seconds
    // here, minutes at the real ~200k); the Map-indexed version is O(n log n)
    // and finishes in tens of milliseconds. The 2s budget is a ~40x margin so
    // a loaded CI box can't flake it, while a quadratic regression (well over
    // 2s at this size) still fails loudly.
    const COUNT = 50_000;
    const refs: SegmentRef[] = [];
    for (let i = 0; i < COUNT; i++) {
      // A 60s gap every 1000 segments → deterministic span boundaries.
      const gaps = Math.floor(i / 1000);
      refs.push({ epoch: 1_000_000 + i * 6 + gaps * 60, name: `seg_${i}.ts`, bytes: 1 });
    }
    const started = Date.now();
    const spans = coverageSpans(refs, { segmentSeconds: 6 });
    const elapsedMs = Date.now() - started;

    expect(spans).toHaveLength(COUNT / 1000);
    expect(spans.reduce((sum, s) => sum + s.segments, 0)).toBe(COUNT);
    expect(spans.reduce((sum, s) => sum + s.bytes, 0)).toBe(COUNT);
    // Every span is 1000 contiguous 6s segments → exactly 6000s of coverage.
    expect(spans.every((s) => s.endEpoch - s.startEpoch === 6000)).toBe(true);
    expect(elapsedMs).toBeLessThan(2000);
  });
});
