/**
 * Contract tests for consolidated day files (@foresight/contract): naming
 * round-trips, strict index validation, ref expansion, and BYTERANGE playlist
 * rendering. These guard the invariants BOTH the recorder's consolidator and
 * the server's playback rely on (see the "Consolidated day files" section of
 * shared/ts/src/recording.ts).
 */
import { describe, expect, it } from "vitest";
import {
  dayFileName,
  dayIndexFileName,
  dayIndexToRefs,
  isDayIndex,
  parseDayFileName,
  parseSegmentName,
  renderPlaylist,
  segmentName,
  utcDayStamp,
  type DayIndex,
  type SegmentRef,
} from "@foresight/contract";

/** 2026-07-18T00:00:00Z — the UTC day used across these tests. */
const DAY_EPOCH = Date.UTC(2026, 6, 18) / 1000;
const DAY = "20260718";

function validIndex(): DayIndex {
  return {
    version: 1,
    day: DAY,
    file: dayFileName(DAY),
    totalBytes: 30,
    segments: [
      { epoch: DAY_EPOCH, offset: 0, bytes: 10, duration: 6 },
      { epoch: DAY_EPOCH + 6, offset: 10, bytes: 12, duration: 6 },
      { epoch: DAY_EPOCH + 12, offset: 22, bytes: 8, duration: 6 },
    ],
  };
}

describe("day file naming", () => {
  it("round-trips name → epoch → name", () => {
    expect(dayFileName(DAY)).toBe("day_20260718.ts");
    expect(dayIndexFileName(DAY)).toBe("day_20260718.json");
    expect(parseDayFileName("day_20260718.ts")).toBe(DAY_EPOCH);
    expect(utcDayStamp(DAY_EPOCH)).toBe(DAY);
    // Any second within the day maps to the same stamp.
    expect(utcDayStamp(DAY_EPOCH + 86399)).toBe(DAY);
  });

  it("rejects malformed and impossible names (traversal guard)", () => {
    for (const bad of [
      "day_2026071.ts", // 7 digits
      "day_202607181.ts", // 9 digits
      "day_20261318.ts", // month 13
      "day_20260732.ts", // day 32
      "day_20260718.json", // wrong extension
      "seg_20260718.ts",
      "../day_20260718.ts",
      "day_20260718.ts/..",
    ]) {
      expect(parseDayFileName(bad), bad).toBeNull();
    }
  });

  it("day names never collide with segment names", () => {
    expect(parseSegmentName(dayFileName(DAY))).toBeNull();
    expect(parseDayFileName(segmentName(DAY_EPOCH))).toBeNull();
  });
});

describe("isDayIndex", () => {
  it("accepts a well-formed index (including an empty day)", () => {
    expect(isDayIndex(validIndex())).toBe(true);
    expect(
      isDayIndex({ version: 1, day: DAY, file: dayFileName(DAY), totalBytes: 0, segments: [] }),
    ).toBe(true);
  });

  it("rejects structural violations", () => {
    const cases: Array<[string, (i: DayIndex) => unknown]> = [
      ["wrong version", (i) => ({ ...i, version: 2 })],
      ["file/day mismatch", (i) => ({ ...i, file: "day_20260719.ts" })],
      ["impossible day", (i) => ({ ...i, day: "20261301", file: "day_20261301.ts" })],
      ["totalBytes mismatch", (i) => ({ ...i, totalBytes: 31 })],
      [
        "non-contiguous offsets",
        (i) => ({
          ...i,
          segments: [i.segments[0]!, { ...i.segments[1]!, offset: 11 }, i.segments[2]!],
        }),
      ],
      [
        "first offset not 0",
        (i) => ({ ...i, segments: i.segments.map((s) => ({ ...s, offset: s.offset + 1 })) }),
      ],
      [
        "epochs not ascending",
        (i) => ({
          ...i,
          segments: [i.segments[1]!, { ...i.segments[0]!, offset: 12 }, i.segments[2]!],
        }),
      ],
      [
        "epoch outside stamped day",
        (i) => ({
          ...i,
          segments: [{ ...i.segments[0]!, epoch: DAY_EPOCH - 1 }, ...i.segments.slice(1)],
        }),
      ],
      [
        "zero-byte segment",
        (i) => ({
          ...i,
          segments: [{ ...i.segments[0]!, bytes: 0 }, ...i.segments.slice(1)],
        }),
      ],
    ];
    for (const [label, mutate] of cases) {
      expect(isDayIndex(mutate(validIndex())), label).toBe(false);
    }
    expect(isDayIndex(null)).toBe(false);
    expect(isDayIndex("{}")).toBe(false);
  });
});

describe("dayIndexToRefs + renderPlaylist", () => {
  it("expands to refs with canonical seg names and byte windows", () => {
    const refs = dayIndexToRefs(validIndex());
    expect(refs).toHaveLength(3);
    expect(refs[0]).toEqual({
      epoch: DAY_EPOCH,
      name: segmentName(DAY_EPOCH),
      bytes: 10,
      byteRange: { offset: 0, length: 10 },
      container: "day_20260718.ts",
    });
    // Canonical names dedupe against loose crash leftovers by name equality.
    expect(refs[1]!.name).toBe("seg_20260718000006.ts");
  });

  it("renders EXT-X-BYTERANGE entries against the day file at HLS v4", () => {
    const refs = dayIndexToRefs(validIndex());
    const m3u8 = renderPlaylist(refs, { mode: "range", uri: (n) => `seg/${n}` });
    expect(m3u8).toContain("#EXT-X-VERSION:4");
    expect(m3u8).toContain("#EXT-X-BYTERANGE:10@0\nseg/day_20260718.ts");
    expect(m3u8).toContain("#EXT-X-BYTERANGE:12@10\nseg/day_20260718.ts");
    expect(m3u8).toContain("#EXT-X-BYTERANGE:8@22\nseg/day_20260718.ts");
    expect(m3u8).toContain("#EXT-X-ENDLIST");
    // No per-segment URIs — every entry points into the container.
    expect(m3u8).not.toContain("seg/seg_");
  });

  it("mixed loose + consolidated refs render both URI styles, still v4", () => {
    const loose: SegmentRef = {
      epoch: DAY_EPOCH + 18,
      name: segmentName(DAY_EPOCH + 18),
      bytes: 9,
    };
    const m3u8 = renderPlaylist([...dayIndexToRefs(validIndex()), loose], {
      mode: "range",
      uri: (n) => `seg/${n}`,
    });
    expect(m3u8).toContain("#EXT-X-VERSION:4");
    expect(m3u8).toContain("seg/seg_20260718000018.ts");
    // The loose entry carries no BYTERANGE line directly above its URI.
    expect(m3u8).not.toMatch(/#EXT-X-BYTERANGE:[^\n]*\nseg\/seg_20260718000018\.ts/);
  });

  it("pure per-file playlists stay at HLS v3", () => {
    const loose: SegmentRef = { epoch: DAY_EPOCH, name: segmentName(DAY_EPOCH), bytes: 9 };
    const m3u8 = renderPlaylist([loose], { mode: "live", uri: (n) => `seg/${n}` });
    expect(m3u8).toContain("#EXT-X-VERSION:3");
    expect(m3u8).not.toContain("BYTERANGE");
  });
});
