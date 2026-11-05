/**
 * CameraRecorder behaviour with a fake encoder and a fake clock:
 *   REC-02 — writes are paced (20 fps in → 30 fps of media out),
 *   REC-05 — a respawn waits for the previous encoder to exit AND for the next
 *            wall-clock second, so segment names can't collide,
 *   REC-04 — repeated quick encoder exits surface as `encoder_failing`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  config: {
    recordingsDir: "/nonexistent-foresight-test",
    recordMaxHeight: 0,
    fps: 30,
    encoder: "libx264",
    segmentSeconds: 6,
    frameStallSeconds: 15,
    ffmpegPath: "ffmpeg",
  },
}));

const { CameraRecorder } = await import("../src/livekit/cameraRecorder.js");
type FfmpegExit = import("../src/media/ffmpeg.js").FfmpegExit;

class FakeEncoder {
  writes = 0;
  isClosed = false;
  exitedAt: number | null = null;
  private resolveExited!: () => void;
  readonly exited = new Promise<void>((r) => (this.resolveExited = r));
  constructor(
    private readonly clock: { now: number },
    private readonly onExit: (e: FfmpegExit) => void,
    readonly spawnedAt: number,
  ) {}
  start(): void {}
  get writable(): boolean {
    return !this.isClosed;
  }
  write(): boolean {
    this.writes++;
    return true;
  }
  exit(code: number | null, requested: boolean): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.exitedAt = this.clock.now;
    this.resolveExited();
    this.onExit({ code, signal: null, requested, ranMs: this.clock.now - this.spawnedAt, stderrTail: ["boom"] });
  }
  async finalize(): Promise<void> {
    this.exit(0, true);
  }
}

function harness() {
  const clock = { now: 1_000_000_000_500 }; // .5 s into a second
  const encoders: FakeEncoder[] = [];
  const sleeps: number[] = [];
  const rec = new CameraRecorder("h", "c", {
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
    playlistMtime: () => null,
    createEncoder: (_args, _log, onExit) => {
      const e = new FakeEncoder(clock, onExit, clock.now);
      encoders.push(e);
      return e;
    },
  });
  rec.state = "recording";
  const sink = (w: number, h: number, tsUs: number) =>
    (rec as unknown as { sink: (d: Uint8Array, w: number, h: number, t: number) => void }).sink(
      new Uint8Array(4),
      w,
      h,
      tsUs,
    );
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { rec, clock, encoders, sleeps, sink, flush };
}

describe("CameraRecorder", () => {
  it("paces 20 fps input into a full 30 fps timeline (REC-02)", async () => {
    const { encoders, sink, clock, flush } = harness();
    sink(640, 360, 0); // first frame requests the encoder
    await flush();
    expect(encoders).toHaveLength(1);
    for (let i = 0; i < 20 * 12; i++) {
      clock.now += 50;
      sink(640, 360, 1_000_000 + i * 50_000);
    }
    // 12 s of wall clock ≈ 360 frames at 30 fps (not 240).
    expect(encoders[0]!.writes).toBeGreaterThanOrEqual(355);
    expect(encoders[0]!.writes).toBeLessThanOrEqual(361);
  });

  it("waits for the old encoder to exit and the next second before respawning (REC-05)", async () => {
    const { encoders, sink, clock, flush, sleeps } = harness();
    sink(640, 360, 0);
    await flush();
    sink(640, 360, 33_000);
    const first = encoders[0]!;
    // Geometry change in the same second → respawn.
    sink(1280, 720, 66_000);
    await flush();
    await flush();
    expect(first.isClosed).toBe(true);
    expect(encoders).toHaveLength(2);
    const second = encoders[1]!;
    // The new encoder started in a LATER wall-clock second than the old one exited.
    expect(Math.floor(second.spawnedAt / 1000)).toBeGreaterThan(Math.floor(first.exitedAt! / 1000));
    expect(sleeps.length).toBeGreaterThan(0);
    void clock;
  });

  it("reports encoder_failing after repeated quick exits (REC-04)", async () => {
    const { rec, encoders, sink, clock, flush } = harness();
    for (let i = 0; i < 3; i++) {
      sink(640, 360, i * 1_000_000);
      await flush();
      await flush();
      clock.now += 200;
      encoders[encoders.length - 1]!.exit(1, false);
    }
    expect(rec.state).toBe("encoder_failing");
    expect(rec.status().lastEncoderError).toContain("boom");
  });
});
