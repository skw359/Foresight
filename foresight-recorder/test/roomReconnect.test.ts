/**
 * REC-01: a room that drops for good must come back on its own — a terminal
 * Disconnected schedules a backoff reconnect, a failed connect is retried, and
 * the reconcile health check re-syncs any armed Home whose room is down.
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  config: {
    recordingsDir: "/nonexistent-foresight-test",
    recordLayer: "high",
    recordAudio: false,
    recordMaxHeight: 0,
    fps: 30,
    encoder: "libx264",
    segmentSeconds: 6,
    frameStallSeconds: 15,
    ffmpegPath: "ffmpeg",
    livekitUrl: "ws://lk",
    livekitApiKey: "k",
    livekitApiSecret: "s",
  },
}));

const { RoomManager, reconnectDelayMs } = await import("../src/livekit/roomManager.js");
const { RoomEvent } = await import("@livekit/rtc-node");

class FakeRoom extends EventEmitter {
  isConnected = false;
  remoteParticipants = new Map();
  e2eeManager = undefined;
  constructor(private readonly failConnect: boolean) {
    super();
  }
  async connect(): Promise<void> {
    if (this.failConnect) throw new Error("connection refused");
    this.isConnected = true;
  }
  async disconnect(): Promise<void> {
    this.isConnected = false;
  }
  /** What rtc-node does when the SFU goes away for good. */
  dropForGood(): void {
    this.isConnected = false;
    this.emit(RoomEvent.Disconnected, 0);
  }
}

function fakeRecorder() {
  return {
    arm: vi.fn(),
    onTrackGone: vi.fn(),
    enterGate: vi.fn(),
    stop: vi.fn(async () => undefined),
    status: () => ({}),
  };
}

function setup(failFirst = 0) {
  const rooms: FakeRoom[] = [];
  const recorders: ReturnType<typeof fakeRecorder>[] = [];
  const rm = new RoomManager({ getHomeKey: () => undefined, summary: () => ({}) } as never, {
    createRoom: () => {
      const r = new FakeRoom(rooms.length < failFirst);
      rooms.push(r);
      return r as never;
    },
    mintToken: async (homeId) => ({ url: "ws://lk", room: `home:${homeId}`, identity: "rec:x", token: "t" }),
    createRecorder: () => {
      const r = fakeRecorder();
      recorders.push(r);
      return r as never;
    },
  });
  return { rm, rooms, recorders };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe("room reconnect (REC-01)", () => {
  it("backs off exponentially with jitter, capped at 30 s", () => {
    expect(reconnectDelayMs(0, () => 0.5)).toBe(1000);
    expect(reconnectDelayMs(3, () => 0.5)).toBe(8000);
    expect(reconnectDelayMs(20, () => 0.5)).toBe(30_000);
    expect(reconnectDelayMs(0, () => 0)).toBe(800);
  });

  it("reconnects within one backoff interval after a terminal disconnect", async () => {
    vi.useFakeTimers();
    const { rm, rooms, recorders } = setup();
    await rm.arm("h1", "c1");
    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.isConnected).toBe(true);

    rooms[0]!.dropForGood();
    expect(recorders[0]!.onTrackGone).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1300); // first backoff ≤ 1.2 s
    await flush();
    expect(rooms).toHaveLength(2);
    expect(rooms[1]!.isConnected).toBe(true);
    expect(recorders[0]!.arm).toHaveBeenCalledTimes(2);
  });

  it("retries a failed connect instead of giving up", async () => {
    vi.useFakeTimers();
    const { rm, rooms } = setup(2);
    await expect(rm.arm("h1", "c1")).rejects.toThrow(/refused/);
    await vi.advanceTimersByTimeAsync(1300);
    await flush();
    await vi.advanceTimersByTimeAsync(2500);
    await flush();
    expect(rooms.length).toBe(3);
    expect(rooms[2]!.isConnected).toBe(true);
  });

  it("does not reconnect after the last camera is disarmed", async () => {
    vi.useFakeTimers();
    const { rm, rooms } = setup();
    await rm.arm("h1", "c1");
    await rm.disarm("h1", "c1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rooms).toHaveLength(1);
  });

  it("health check reconnects an armed Home whose room is down", async () => {
    const { rm, rooms } = setup();
    await rm.arm("h1", "c1");
    // Simulate a silent drop (no event), e.g. a missed Disconnected.
    rooms[0]!.isConnected = false;
    await rm.healthCheck();
    expect(rooms).toHaveLength(2);
    expect(rooms[1]!.isConnected).toBe(true);
  });
});
