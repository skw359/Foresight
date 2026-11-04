import { describe, expect, it } from "vitest";
import { isPathWithin } from "../src/lib/pathGuard.js";

const BASE = "/recordings/home1/cam1";

describe("isPathWithin (playback path-traversal guard)", () => {
  it("accepts paths strictly inside the base", () => {
    expect(isPathWithin(BASE, `${BASE}/2026/06/19/seg_1750348800.ts`)).toBe(true);
    expect(isPathWithin(BASE, `${BASE}/live.m3u8`)).toBe(true);
  });

  it("rejects the base itself (not a file inside it)", () => {
    expect(isPathWithin(BASE, BASE)).toBe(false);
  });

  it("rejects traversal escapes", () => {
    expect(isPathWithin(BASE, `${BASE}/../cam2/seg_1.ts`)).toBe(false);
    expect(isPathWithin(BASE, `${BASE}/../../etc/passwd`)).toBe(false);
    expect(isPathWithin(BASE, "/etc/passwd")).toBe(false);
    expect(isPathWithin(BASE, "/recordings/home1/cam1evil/seg_1.ts")).toBe(false);
  });

  it("normalizes redundant separators before checking", () => {
    expect(isPathWithin(BASE, `${BASE}/2026/../2026/seg_1.ts`)).toBe(true);
    expect(isPathWithin(BASE, `${BASE}/a/b/../../../cam2`)).toBe(false);
  });
});
