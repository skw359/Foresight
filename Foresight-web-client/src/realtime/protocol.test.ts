/**
 * PROTO-01: receivers validate every data message (shape + protocol version)
 * and who sent it, so one participant can't spoof another camera's state.
 */
import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  decodeDataMessage,
  encodeDataMessage,
  isAuthorizedSender,
  makeCommand,
  makeRekey,
  type DataMessage,
} from "@foresight/contract";

const telemetry = (cameraId: string): DataMessage => ({
  v: PROTOCOL_VERSION,
  type: "telemetry",
  cameraId,
  battery: 0.5,
  charging: true,
  wifi: { level: 3 },
  thermal: "nominal",
  viewerCount: 1,
});

const enc = (x: unknown) => new TextEncoder().encode(JSON.stringify(x));

describe("decodeDataMessage", () => {
  it("round-trips valid messages", () => {
    const msg = telemetry("A");
    expect(decodeDataMessage(encodeDataMessage(msg))).toEqual(msg);
    expect(decodeDataMessage(encodeDataMessage(makeRekey(3)))).toEqual(makeRekey(3));
  });

  it("rejects other protocol versions, unknown types and malformed payloads", () => {
    expect(decodeDataMessage(enc({ ...telemetry("A"), v: 2 }))).toBeNull();
    expect(decodeDataMessage(enc({ v: 1, type: "selfDestruct" }))).toBeNull();
    expect(decodeDataMessage(enc({ v: 1, type: "telemetry", cameraId: "A" }))).toBeNull();
    expect(decodeDataMessage(enc({ v: 1, type: "command", id: "x", target: "A", action: "rm -rf" }))).toBeNull();
    expect(decodeDataMessage(new TextEncoder().encode("{not json"))).toBeNull();
  });
});

describe("isAuthorizedSender", () => {
  it("accepts camera A's telemetry only from camera A", () => {
    expect(isAuthorizedSender(telemetry("A"), "camera:A")).toBe(true);
    expect(isAuthorizedSender(telemetry("A"), "camera:B")).toBe(false);
    expect(isAuthorizedSender(telemetry("A"), "user:u1:abc")).toBe(false);
    expect(isAuthorizedSender(telemetry("A"), undefined)).toBe(false);
  });

  it("accepts commands only from viewers — never sender-less (server API) data", () => {
    const cmd = makeCommand("A", "torch", { on: true });
    expect(isAuthorizedSender(cmd, "user:u1:abc")).toBe(true);
    expect(isAuthorizedSender(cmd, "camera:B")).toBe(false);
    expect(isAuthorizedSender(cmd, null)).toBe(false);
  });

  it("accepts rekey from the server or a viewer, not from a camera", () => {
    expect(isAuthorizedSender(makeRekey(2), null)).toBe(true);
    expect(isAuthorizedSender(makeRekey(2), "user:u1:abc")).toBe(true);
    expect(isAuthorizedSender(makeRekey(2), "camera:A")).toBe(false);
  });
});
