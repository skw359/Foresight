/**
 * REC-02 end-to-end (real ffmpeg, real-time): the review reproduced 20 fps of
 * input producing 6 s of media in segments whose names were 9 s apart. Feed
 * 20 fps for ~14 s through the recorder's real sink + FfmpegProcess +
 * buildHlsArgs, then check every segment's media duration (ffprobe) against
 * the gap between its wall-clock name and the next segment's name.
 *
 * Skipped when ffmpeg/ffprobe are not on PATH. Takes ~15 s.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { parseSegmentName } from "@foresight/contract";

const hasFfmpeg =
  spawnSync("ffmpeg", ["-hide_banner", "-version"]).status === 0 &&
  spawnSync("ffprobe", ["-hide_banner", "-version"]).status === 0;

const recDir = fs.mkdtempSync(path.join(os.tmpdir(), "foresight-timing-"));

vi.mock("../src/config.js", () => ({
  config: {
    recordingsDir: recDir,
    recordMaxHeight: 0,
    fps: 30,
    encoder: "libx264",
    segmentSeconds: 6,
    frameStallSeconds: 15,
    ffmpegPath: "ffmpeg",
  },
}));

function probeDuration(file: string): number {
  const r = spawnSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  return Number(String(r.stdout).trim());
}

describe.skipIf(!hasFfmpeg)("recording timing with real ffmpeg (REC-02)", () => {
  it("keeps media duration equal to wall-clock time at 20 fps input", async () => {
    const { CameraRecorder } = await import("../src/livekit/cameraRecorder.js");
    const rec = new CameraRecorder("home", "cam");
    rec.arm();
    rec.state = "recording";
    const sink = (rec as unknown as { sink: (d: Uint8Array, w: number, h: number, t: number) => void }).sink.bind(rec);

    const W = 64;
    const H = 64;
    const frameBytes = (W * H * 3) / 2;
    let n = 0;
    const started = performance.now();
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const frame = new Uint8Array(frameBytes).fill(n++ % 255);
        sink(frame, W, H, Math.round(performance.now() * 1000));
        if (performance.now() - started > 14_500) {
          clearInterval(timer);
          resolve();
        }
      }, 50); // 20 fps
    });
    await rec.stop();

    const files: Array<{ epoch: number; file: string }> = [];
    for (const e of fs.readdirSync(path.join(recDir, "home", "cam"), { recursive: true, withFileTypes: true })) {
      const epoch = e.isFile() ? parseSegmentName(e.name) : null;
      if (epoch !== null) {
        const parent = (e as unknown as { parentPath?: string; path?: string }).parentPath ?? (e as unknown as { path: string }).path;
        files.push({ epoch, file: path.join(parent, e.name) });
      }
    }
    files.sort((a, b) => a.epoch - b.epoch);
    expect(files.length).toBeGreaterThanOrEqual(2);

    // Every complete segment: media duration ≈ gap to the next segment's name
    // (names have 1 s resolution). The bug produced 6 s of media per 9 s gap.
    for (let i = 0; i < files.length - 1; i++) {
      const gap = files[i + 1]!.epoch - files[i]!.epoch;
      const media = probeDuration(files[i]!.file);
      expect(Math.abs(media - gap)).toBeLessThanOrEqual(1.05);
    }
    // And in total, media covers the wall-clock span (no 1.5x compression).
    const total = files.reduce((s, f) => s + probeDuration(f.file), 0);
    expect(total).toBeGreaterThan(12.5);
    fs.rmSync(recDir, { recursive: true, force: true });
  }, 40_000);
});
