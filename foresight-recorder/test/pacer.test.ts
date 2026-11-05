/**
 * REC-02: frames must land on the constant-rate output timeline by their real
 * timestamps, so media time equals wall time whatever rate frames arrive at.
 */
import { describe, expect, it } from "vitest";
import { FramePacer, frameTimestampUs } from "../src/media/pacer.js";

const SEC = 1_000_000;

/** Feed `frames` timestamps; returns frames written (incl. repeats) and drops. */
function feed(pacer: FramePacer, timestamps: number[]) {
  let written = 0;
  let repeats = 0;
  let drops = 0;
  let resyncs = 0;
  for (const ts of timestamps) {
    const d = pacer.push(ts);
    if (d.kind === "emit") {
      written += d.repeatPrevious + 1;
      repeats += d.repeatPrevious;
    } else if (d.kind === "drop") drops++;
    else resyncs++;
  }
  return { written, repeats, drops, resyncs };
}

const at = (fps: number, seconds: number, startUs = 5 * SEC) =>
  Array.from({ length: Math.round(fps * seconds) }, (_, i) => startUs + Math.round((i * SEC) / fps));

describe("FramePacer", () => {
  it("turns 20 fps into 30 fps of media that spans the same wall time (the reproduced bug)", () => {
    const pacer = new FramePacer(30, 60);
    const ts = at(20, 12);
    const r = feed(pacer, ts);
    // 12 s of wall clock → 12 s of media (± one slot), not 8 s.
    const wall = (ts[ts.length - 1]! - ts[0]!) / SEC;
    expect(Math.abs(pacer.mediaSeconds - wall)).toBeLessThan(2 / 30);
    expect(r.repeats).toBeGreaterThan(100);
    expect(r.drops).toBe(0);
  });

  it("drops extras when frames arrive faster than the output rate", () => {
    const pacer = new FramePacer(30, 60);
    const r = feed(pacer, at(60, 6));
    expect(Math.abs(pacer.mediaSeconds - 6)).toBeLessThan(2 / 30);
    expect(r.drops).toBeGreaterThan(150);
    expect(r.repeats).toBe(0);
  });

  it("is exact at the native rate", () => {
    const pacer = new FramePacer(30, 60);
    const r = feed(pacer, at(30, 10));
    expect(r.written).toBe(300);
    expect(r.repeats + r.drops).toBe(0);
  });

  it("fills a short freeze with repeats and resyncs on one longer than the fill budget", () => {
    const pacer = new FramePacer(30, 60);
    feed(pacer, [0, SEC / 30]);
    // 1 s freeze → 29 repeated slots, then the new frame.
    expect(pacer.push(SEC + SEC / 30)).toEqual({ kind: "emit", repeatPrevious: 29 });
    // 5 s freeze > 2 s budget → resync instead of a 150-frame burst.
    const d = pacer.push(6 * SEC);
    expect(d.kind).toBe("resync");
  });

  it("keeps backpressure-skipped slots owed instead of compressing time", () => {
    const pacer = new FramePacer(30, 60);
    pacer.push(0);
    expect(pacer.push(SEC / 30)).toEqual({ kind: "emit", repeatPrevious: 0 });
    pacer.unemit(1); // the encoder couldn't take that frame
    // The next frame fills the owed slot first.
    expect(pacer.push((2 * SEC) / 30)).toEqual({ kind: "emit", repeatPrevious: 1 });
  });

  it("treats a backwards clock jump as a resync", () => {
    const pacer = new FramePacer(30, 60);
    feed(pacer, at(30, 1, 10 * SEC));
    expect(pacer.push(1 * SEC).kind).toBe("resync");
  });

  it("uses the SDK timestamp when present and arrival time otherwise", () => {
    expect(frameTimestampUs(123n, 999)).toBe(123);
    expect(frameTimestampUs(0n, 999)).toBe(999);
    expect(frameTimestampUs(undefined, 999)).toBe(999);
  });
});
