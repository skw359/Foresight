/**
 * The clip export must never mislabel a range's resolution. An MP4 track
 * declares one resolution, so a `-c copy` remux of segments that disagree
 * inherits the FIRST piece's size — which is how a camera publishing 1080p
 * produced 320x180 downloads. These cover the two halves of the check:
 * reading a segment's coded size out of its SPS (src/lib/h264.ts) and turning a
 * list of pieces into a copy-or-re-encode decision (src/lib/clipGeometry.ts).
 *
 * The SPS fixtures are the real NALs the recorder wrote for each geometry, so
 * these assert against actual recorded footage rather than a synthetic stream.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSpsInTs, spsDimensions, tsDimensions } from "../src/lib/h264.js";
import { clipMuxArgs, MAX_PROBED_PIECES, planClipEncode } from "../src/lib/clipGeometry.js";

/** Real SPS NALs (header byte included) taken from recorded segments. */
const SPS = {
  "320x180": "Z2QADay0Cgz88IAAAAMAgAAAHkeKFVA=",
  "480x270": "Z2QAFay0DwR/UIAAAAMAgAAAHkeLF1A=",
  "960x540": "Z2QAH6y0B4CL9wgAAAMACAAAAwHkeMGV",
  "1280x720": "Z2QAH6y0AoAt0IAAAAMAgAAAHkeMGVA=",
  "1920x1080": "Z2QAKKy0A8ARPywgAAADACAAAAeR4wZU",
} as const;

const nal = (key: keyof typeof SPS): Uint8Array => Buffer.from(SPS[key], "base64");

const TS_PACKET_SIZE = 188;
const VIDEO_PID = 0x100;

/**
 * Wrap payload bytes into 188-byte TS packets on the video PID. `offset` pads the
 * first packet so the SPS can be made to straddle a packet boundary — the case a
 * naive scan of the raw file gets wrong.
 */
function tsPackets(payload: Uint8Array, offset = 0): Uint8Array {
  const body = new Uint8Array(offset + payload.length);
  body.set(payload, offset);
  const packets: number[] = [];
  for (let i = 0; i < body.length; i += TS_PACKET_SIZE - 4) {
    const chunk = body.subarray(i, i + TS_PACKET_SIZE - 4);
    const packet = new Uint8Array(TS_PACKET_SIZE).fill(0xff);
    packet[0] = 0x47;
    packet[1] = (VIDEO_PID >> 8) & 0x1f;
    packet[2] = VIDEO_PID & 0xff;
    packet[3] = 0x10; // payload only, no adaptation field
    packet.set(chunk, 4);
    packets.push(...packet);
  }
  return new Uint8Array(packets);
}

/** A minimal segment: PES-ish start code, then the SPS as an Annex-B NAL. */
function segmentBytes(key: keyof typeof SPS, offset = 0): Uint8Array {
  const sps = nal(key);
  const stream = new Uint8Array(4 + 3 + sps.length);
  stream.set([0x00, 0x00, 0x01, 0xe0], 0); // PES header — stream_id, NOT an SPS
  stream.set([0x00, 0x00, 0x01], 4); // start code
  stream.set(sps, 7);
  return tsPackets(stream, offset);
}

describe("spsDimensions", () => {
  it("decodes every geometry the recorder has written", () => {
    expect(spsDimensions(nal("320x180"))).toEqual({ w: 320, h: 180 });
    expect(spsDimensions(nal("480x270"))).toEqual({ w: 480, h: 270 });
    expect(spsDimensions(nal("960x540"))).toEqual({ w: 960, h: 540 });
    expect(spsDimensions(nal("1280x720"))).toEqual({ w: 1280, h: 720 });
    // 1080 is 68 macroblocks (1088) minus an 8px crop — the case a
    // crop-unaware parser gets wrong.
    expect(spsDimensions(nal("1920x1080"))).toEqual({ w: 1920, h: 1080 });
  });

  it("returns null rather than throwing on garbage", () => {
    expect(spsDimensions(new Uint8Array([0x67]))).toBeNull();
    expect(spsDimensions(new Uint8Array(0))).toBeNull();
    expect(spsDimensions(new Uint8Array([0x67, 0xff, 0xff, 0xff]))).toBeNull();
  });
});

describe("findSpsInTs", () => {
  it("finds the SPS and ignores the PES header's own start code", () => {
    expect(tsDimensions(segmentBytes("960x540"))).toEqual({ w: 960, h: 540 });
  });

  it("reassembles an SPS split across a TS packet boundary", () => {
    // Push the NAL so far into the first packet that it must continue into the
    // next one; scanning the raw bytes would read the 4-byte TS header as SPS.
    const straddling = segmentBytes("1920x1080", TS_PACKET_SIZE - 4 - 12);
    expect(straddling.length).toBeGreaterThan(TS_PACKET_SIZE);
    expect(tsDimensions(straddling)).toEqual({ w: 1920, h: 1080 });
  });

  it("returns null for bytes that are not packet-aligned TS", () => {
    expect(findSpsInTs(new Uint8Array(400))).toBeNull();
  });
});

describe("planClipEncode", () => {
  let dir: string;
  const piece = (name: string) => ({ path: join(dir, name) });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "foresight-clipgeom-"));
    for (const key of Object.keys(SPS) as (keyof typeof SPS)[]) {
      writeFileSync(join(dir, `${key}.ts`), segmentBytes(key));
    }
    // A day file holding 960x540 then 320x180 back to back, to exercise the
    // byte-window form of a piece.
    writeFileSync(
      join(dir, "day.ts"),
      Buffer.concat([
        Buffer.from(segmentBytes("960x540")),
        Buffer.from(segmentBytes("320x180")),
      ]),
    );
    writeFileSync(join(dir, "empty.ts"), "");
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("takes the copy fast path when every piece agrees", async () => {
    const plan = await planClipEncode([piece("960x540.ts"), piece("960x540.ts")]);
    expect(plan.uniform).toBe(true);
    expect(plan.distinct).toBe(1);
    expect(plan.target).toEqual({ w: 960, h: 540 });
  });

  it("flags a mixed range and targets its LARGEST geometry", async () => {
    // Deliberately ordered small-first: the old bug was inheriting the first
    // piece's size, so the target must not be 320x180.
    const plan = await planClipEncode([
      piece("320x180.ts"),
      piece("480x270.ts"),
      piece("1920x1080.ts"),
      piece("960x540.ts"),
    ]);
    expect(plan.uniform).toBe(false);
    expect(plan.distinct).toBe(4);
    expect(plan.target).toEqual({ w: 1920, h: 1080 });
  });

  it("reads a piece that is a byte window of a day file", async () => {
    const one = segmentBytes("960x540").length;
    const whole = await planClipEncode([{ path: join(dir, "day.ts") }]);
    expect(whole.target).toEqual({ w: 960, h: 540 }); // first SPS in the file

    const second = await planClipEncode([
      { path: join(dir, "day.ts"), start: one, end: one * 2 - 1 },
    ]);
    expect(second.target).toEqual({ w: 320, h: 180 });

    const both = await planClipEncode([
      { path: join(dir, "day.ts"), start: 0, end: one - 1 },
      { path: join(dir, "day.ts"), start: one, end: one * 2 - 1 },
    ]);
    expect(both.uniform).toBe(false);
    expect(both.target).toEqual({ w: 960, h: 540 });
  });

  it("degrades to the copy path when nothing can be read", async () => {
    const plan = await planClipEncode([piece("empty.ts"), piece("gone.ts")]);
    expect(plan.uniform).toBe(true); // no evidence of a mix → do not re-encode
    expect(plan.target).toBeNull();
    expect(plan.unreadable).toBe(2);
  });

  it("ignores unreadable pieces without losing a real mix", async () => {
    const plan = await planClipEncode([
      piece("gone.ts"),
      piece("320x180.ts"),
      piece("960x540.ts"),
    ]);
    expect(plan.uniform).toBe(false);
    expect(plan.target).toEqual({ w: 960, h: 540 });
    expect(plan.unreadable).toBe(1);
  });

  it("bounds how many pieces it inspects on a huge range", async () => {
    const many = Array.from({ length: MAX_PROBED_PIECES + 500 }, () => piece("960x540.ts"));
    const plan = await planClipEncode(many);
    expect(plan.probed).toBe(MAX_PROBED_PIECES);
    expect(plan.uniform).toBe(true);
  });
});

describe("clipMuxArgs", () => {
  it("copies a uniform range — no transcode on the common path", () => {
    expect(clipMuxArgs({ uniform: true, target: { w: 960, h: 540 }, distinct: 1, unreadable: 0, probed: 3 })).toEqual([
      "-c",
      "copy",
    ]);
  });

  it("copies when nothing could be read (no evidence of a mix)", () => {
    expect(clipMuxArgs({ uniform: true, target: null, distinct: 0, unreadable: 3, probed: 3 })).toEqual([
      "-c",
      "copy",
    ]);
  });

  it("scales a mixed range onto the target, letterboxed", () => {
    const args = clipMuxArgs({
      uniform: false,
      target: { w: 1920, h: 1080 },
      distinct: 3,
      unreadable: 0,
      probed: 9,
    });
    const vf = args[args.indexOf("-vf") + 1]!;
    expect(vf).toContain("scale=1920:1080");
    expect(vf).toContain("force_divisible_by=2");
    expect(vf).toContain("pad=1920:1080");
    expect(vf).toContain("setsar=1");
    expect(args).not.toContain("copy");
    expect(args).toContain("-an");
  });
});
