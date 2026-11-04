import { describe, expect, it } from "vitest";
import {
  capGeometry,
  evenGeometry,
  isLarger,
  resolveTargetGeometry,
} from "../src/media/geometry.js";

describe("evenGeometry", () => {
  it("rounds odd dimensions down (yuv420p needs even on both axes)", () => {
    expect(evenGeometry({ w: 641, h: 481 })).toEqual({ w: 640, h: 480 });
    expect(evenGeometry({ w: 1920, h: 1080 })).toEqual({ w: 1920, h: 1080 });
  });

  it("never collapses to zero", () => {
    expect(evenGeometry({ w: 1, h: 1 })).toEqual({ w: 2, h: 2 });
  });
});

describe("capGeometry", () => {
  it("passes through when under the cap or uncapped", () => {
    expect(capGeometry({ w: 1920, h: 1080 }, 1080)).toEqual({ w: 1920, h: 1080 });
    expect(capGeometry({ w: 3840, h: 2160 }, 0)).toEqual({ w: 3840, h: 2160 });
  });

  it("downscales 4K to the cap, keeping the aspect ratio and even dimensions", () => {
    expect(capGeometry({ w: 3840, h: 2160 }, 1080)).toEqual({ w: 1920, h: 1080 });
    const capped = capGeometry({ w: 1440, h: 1080 }, 720); // 4:3
    expect(capped).toEqual({ w: 960, h: 720 });
    expect(capped.w % 2).toBe(0);
  });
});

describe("resolveTargetGeometry", () => {
  const maxHeight = 0;

  it("uses the publication's declared geometry over the arriving frame size", () => {
    // The SFU is forwarding the 240x135 downscale of the low layer; the phone
    // says it publishes 1080p, so that is what we encode.
    expect(
      resolveTargetGeometry({
        declared: { w: 1920, h: 1080 },
        largestSeen: { w: 240, h: 135 },
        maxHeight,
      }),
    ).toEqual({ w: 1920, h: 1080 });
  });

  it("is stable across layer switches — the reason segments remux as one MP4", () => {
    const declared = { w: 1920, h: 1080 };
    const seen = [
      { w: 240, h: 135 },
      { w: 960, h: 540 },
      { w: 320, h: 180 },
      { w: 1280, h: 720 },
    ];
    const targets = seen.map((largestSeen) =>
      JSON.stringify(resolveTargetGeometry({ declared, largestSeen, maxHeight })),
    );
    expect(new Set(targets).size).toBe(1);
  });

  it("falls back to the largest frame seen when nothing is declared", () => {
    expect(
      resolveTargetGeometry({ declared: null, largestSeen: { w: 960, h: 540 }, maxHeight }),
    ).toEqual({ w: 960, h: 540 });
  });

  it("ignores a declared geometry the SFU reported as zero", () => {
    expect(
      resolveTargetGeometry({
        declared: { w: 0, h: 0 },
        largestSeen: { w: 960, h: 540 },
        maxHeight,
      }),
    ).toEqual({ w: 960, h: 540 });
  });

  it("applies the encode cap to whichever source won", () => {
    expect(
      resolveTargetGeometry({
        declared: { w: 3840, h: 2160 },
        largestSeen: { w: 960, h: 540 },
        maxHeight: 1080,
      }),
    ).toEqual({ w: 1920, h: 1080 });
  });
});

describe("isLarger", () => {
  it("compares by pixel count and accepts the first sample", () => {
    expect(isLarger({ w: 320, h: 180 }, null)).toBe(true);
    expect(isLarger({ w: 1920, h: 1080 }, { w: 960, h: 540 })).toBe(true);
    expect(isLarger({ w: 240, h: 135 }, { w: 960, h: 540 })).toBe(false);
  });
});
