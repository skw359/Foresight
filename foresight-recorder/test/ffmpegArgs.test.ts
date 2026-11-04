import { describe, expect, it } from "vitest";
import { buildHlsArgs, type HlsArgsOptions } from "../src/media/ffmpeg.js";

const base: HlsArgsOptions = {
  width: 1920,
  height: 1080,
  targetWidth: 1920,
  targetHeight: 1080,
  fps: 30,
  encoder: "libx264",
  segmentSeconds: 6,
  segmentTemplate: "/rec/h/c/%Y/%m/%d/seg_%Y%m%d%H%M%S.ts",
  playlistPath: "/rec/h/c/live.m3u8",
};

/** Find the value that follows a flag in the arg vector. */
function after(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe("buildHlsArgs", () => {
  it("sets a fixed rawvideo input geometry and frame rate", () => {
    const args = buildHlsArgs(base);
    expect(after(args, "-f")).toBe("rawvideo");
    expect(after(args, "-s")).toBe("1920x1080");
    expect(after(args, "-r")).toBe("30");
    expect(after(args, "-i")).toBe("pipe:0");
    expect(after(args, "-pix_fmt")).toBe("yuv420p");
  });

  it("uses libx264 zerolatency tuning by default", () => {
    const args = buildHlsArgs(base);
    expect(after(args, "-c:v")).toBe("libx264");
    expect(args).toEqual(expect.arrayContaining(["-preset", "veryfast", "-tune", "zerolatency"]));
  });

  it("switches to nvenc preset (and drops x264 tune) for h264_nvenc", () => {
    const args = buildHlsArgs({ ...base, encoder: "h264_nvenc" });
    expect(after(args, "-c:v")).toBe("h264_nvenc");
    expect(args).toEqual(expect.arrayContaining(["-preset", "p4"]));
    expect(args).not.toContain("zerolatency");
  });

  it("keyframe-aligns to segment boundaries with GOP = 2*fps", () => {
    expect(after(buildHlsArgs(base), "-g")).toBe("60");
    expect(buildHlsArgs(base)).toContain("expr:gte(t,n_forced*6)");
    // fps changes flow through to GOP and the keyframe expression length.
    expect(after(buildHlsArgs({ ...base, fps: 24, segmentSeconds: 4 }), "-g")).toBe("48");
    expect(buildHlsArgs({ ...base, segmentSeconds: 4 })).toContain("expr:gte(t,n_forced*4)");
  });

  it("emits HLS with strftime + mkdir and the segment template/playlist last", () => {
    const args = buildHlsArgs(base);
    expect(after(args, "-f")).toBe("rawvideo"); // first -f is the input
    expect(args).toEqual(
      expect.arrayContaining(["-f", "hls", "-hls_time", "6", "-strftime", "1", "-strftime_mkdir", "1"]),
    );
    expect(after(args, "-hls_segment_filename")).toBe(base.segmentTemplate);
    expect(args[args.length - 1]).toBe(base.playlistPath);
  });

  it("scales every input geometry onto the target, letterboxed and SAR-normalized", () => {
    // The whole point: input follows whatever layer the SFU forwards, output
    // does not, so a range of segments remuxes as one resolution.
    const vf = after(buildHlsArgs({ ...base, width: 320, height: 180 }), "-vf") ?? "";
    expect(vf).toContain("scale=1920:1080");
    expect(vf).toContain("force_original_aspect_ratio=decrease");
    // Odd scaled dimensions are fatal for yuv420p.
    expect(vf).toContain("force_divisible_by=2");
    // Letterbox rather than distort when a layer switch changes the ratio.
    expect(vf).toContain("pad=1920:1080");
    expect(vf).toContain("setsar=1");
    // The rawvideo input still describes the ACTUAL frames on stdin.
    expect(after(buildHlsArgs({ ...base, width: 320, height: 180 }), "-s")).toBe("320x180");
  });

  it("targets the same geometry no matter which layer arrives", () => {
    const targets = [
      { width: 240, height: 135 },
      { width: 960, height: 540 },
      { width: 1920, height: 1080 },
    ].map((input) => after(buildHlsArgs({ ...base, ...input }), "-vf"));
    expect(new Set(targets).size).toBe(1);
  });

  it("follows the target geometry when it is not 1080p (4K publisher, capped host)", () => {
    const vf =
      after(buildHlsArgs({ ...base, targetWidth: 3840, targetHeight: 2160 }), "-vf") ?? "";
    expect(vf).toContain("scale=3840:2160");
    expect(vf).toContain("pad=3840:2160");
  });

  it("never deletes segments and includes program-date-time for wall-clock seek", () => {
    const flags = after(buildHlsArgs(base), "-hls_flags") ?? "";
    expect(flags).toContain("program_date_time");
    expect(flags).toContain("independent_segments");
    expect(flags).not.toContain("delete_segments");
  });
});
