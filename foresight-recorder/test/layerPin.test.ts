import { describe, expect, it, vi } from "vitest";
import { FfiRequest, VideoQuality } from "@livekit/rtc-ffi-bindings";
import { buildSetQualityRequest, ffiHandleOf, pinVideoQuality } from "../src/livekit/layerPin.js";

/**
 * These lock the undocumented FFI surface the layer pin rides on. rtc-node 0.13
 * exposes no setVideoQuality, so if an upgrade changes the oneof case name or
 * the required fields, the recorder would quietly fall back to unpinned
 * recording (240x135 footage from a 1080p camera) — these fail instead.
 */
describe("buildSetQualityRequest", () => {
  it("encodes the setRemoteTrackPublicationQuality case with both required fields", () => {
    const decoded = FfiRequest.fromBinary(buildSetQualityRequest(42n, "high"));
    expect(decoded.message.case).toBe("setRemoteTrackPublicationQuality");
    const value = decoded.message.value as { trackPublicationHandle?: bigint; quality?: number };
    expect(value.trackPublicationHandle).toBe(42n);
    expect(value.quality).toBe(VideoQuality.HIGH);
  });

  it("maps every layer name onto the FFI quality enum", () => {
    const qualityOf = (layer: "low" | "medium" | "high") =>
      (FfiRequest.fromBinary(buildSetQualityRequest(1n, layer)).message.value as { quality: number })
        .quality;
    expect(qualityOf("low")).toBe(VideoQuality.LOW);
    expect(qualityOf("medium")).toBe(VideoQuality.MEDIUM);
    expect(qualityOf("high")).toBe(VideoQuality.HIGH);
  });
});

describe("ffiHandleOf", () => {
  it("reads the publication's handle", () => {
    expect(ffiHandleOf({ ffiHandle: { handle: 7n } })).toBe(7n);
  });

  it("returns null when the internal moved instead of throwing", () => {
    expect(ffiHandleOf({})).toBeNull();
    expect(ffiHandleOf({ ffiHandle: {} })).toBeNull();
    expect(ffiHandleOf({ ffiHandle: { handle: 7 } })).toBeNull(); // number, not bigint
  });
});

describe("pinVideoQuality", () => {
  it("degrades (logged, no throw) when there is no handle to pin", () => {
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    expect(pinVideoQuality({}, "high", log as never)).toBe(false);
    expect(log.warn).toHaveBeenCalledOnce();
  });
});
