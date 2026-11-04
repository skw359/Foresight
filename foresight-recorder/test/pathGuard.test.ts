import { describe, expect, it } from "vitest";
import { parseSegmentName, segmentName } from "@foresight/contract";

describe("segment filename guard (parseSegmentName)", () => {
  it("round-trips a generated segment name to its epoch", () => {
    expect(parseSegmentName(segmentName(1750348800))).toBe(1750348800);
    expect(parseSegmentName(segmentName(0))).toBe(0);
  });

  it("accepts a well-formed seg_<YYYYMMDDHHMMSS>.ts (UTC)", () => {
    expect(parseSegmentName("seg_19700101000000.ts")).toBe(0);
    expect(parseSegmentName("seg_20250619180006.ts")).toBe(
      Math.floor(Date.UTC(2025, 5, 19, 18, 0, 6) / 1000),
    );
  });

  it("rejects the legacy epoch-seconds name (%s, unsupported on Windows)", () => {
    // The old scheme produced these; they must no longer parse so a stray legacy
    // file can't be misread as a year-55000+ timestamp.
    expect(parseSegmentName("seg_1750348806.ts")).toBeNull();
    expect(parseSegmentName("seg_42.ts")).toBeNull();
  });

  it("rejects traversal and malformed names (path-injection guard)", () => {
    const bad = [
      "../seg_1.ts",
      "../../etc/passwd",
      "seg_1.ts/../x",
      "sub/seg_1.ts",
      "seg_.ts",
      "seg_1.mp4",
      "seg_-1.ts",
      "seg_1e3.ts",
      "seg_ 1.ts",
      "..",
      "/etc/passwd",
      "live.m3u8",
      "",
    ];
    for (const name of bad) {
      expect(parseSegmentName(name), `should reject: ${JSON.stringify(name)}`).toBeNull();
    }
  });

  it("rejects absurdly large (non-safe-integer) epochs", () => {
    expect(parseSegmentName(`seg_${"9".repeat(20)}.ts`)).toBeNull();
  });
});
