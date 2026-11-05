/**
 * Foresight Security — realtime control protocol.
 *
 * Control commands, acks, state, and telemetry travel over LiveKit's reliable
 * DATA channel — deliberately decoupled from the media (video/audio) stream.
 * This is the "separate control system" from the product spec: a viewer's
 * button press never rides the video pipe.
 *
 * Mirrored in shared/swift/ForesightProtocol.swift — keep in sync.
 */

import type { ParticipantRole, QualityPreset, ThermalState, WifiInfo } from "./rest.js";

/*
 * Receivers MUST validate every packet with decodeDataMessage (shape + `v`)
 * and isAuthorizedSender (who may send it) before acting on it.
 */

/** Bump when the wire format changes incompatibly. */
export const PROTOCOL_VERSION = 1;

export type DataMessageType = "command" | "ack" | "state" | "telemetry" | "rekey";

/** Actions a viewer can request of a camera. */
export type CommandAction =
  | "torch" // args.on: boolean
  | "switchLens" // args.lens: number (optical factor)
  | "setZoom" // args.zoom: number (digital, >= 1)
  | "setQuality" // args.quality: QualityPreset
  | "snapshotHint" // viewer is grabbing a frame (advisory; capture is viewer-side in v1)
  | "startRecord" // advisory; recording is viewer-side in v1
  | "stopRecord"
  | "talkStart" // push-to-talk begin: viewer is about to speak
  | "talkStop" // push-to-talk end
  | "alarm"; // emergency sound (stubbed; UI deferred)

export interface CommandArgs {
  on?: boolean;
  lens?: number;
  zoom?: number;
  quality?: QualityPreset;
}

interface BaseMessage {
  /** Protocol version (PROTOCOL_VERSION). */
  v: number;
  type: DataMessageType;
}

/** viewer → camera (addressed to the camera's identity via destinationIdentities). */
export interface CommandMessage extends BaseMessage {
  type: "command";
  /** Unique command id (for ack correlation). */
  id: string;
  /** Target camera id. */
  target: string;
  action: CommandAction;
  args?: CommandArgs;
}

/** camera → viewer (in response to a command). */
export interface AckMessage extends BaseMessage {
  type: "ack";
  commandId: string;
  ok: boolean;
  error?: string;
}

/** camera → room (broadcast on change) so every viewer stays in sync. */
export interface StateMessage extends BaseMessage {
  type: "state";
  cameraId: string;
  torchOn: boolean;
  /** Current optical lens factor. */
  lens: number;
  /** Current digital zoom factor (>= 1). */
  zoom: number;
  quality: QualityPreset;
  recording: boolean;
  /** True while a viewer is speaking via push-to-talk. */
  talking: boolean;
}

/** camera → room (periodic heartbeat with health). */
export interface TelemetryMessage extends BaseMessage {
  type: "telemetry";
  cameraId: string;
  battery: number | null;
  charging: boolean | null;
  wifi: WifiInfo | null;
  thermal: ThermalState | null;
  /** Number of viewers currently subscribed. */
  viewerCount: number;
}

/**
 * rotating-client → room (reliable, broadcast). The Home Media Key was rotated
 * to `epoch`: every participant must re-fetch its sealed copy and re-apply
 * `setKey(base64(HMK′))` — still at LiveKit key index 0 (`epoch` is server
 * bookkeeping, never a key index). Older clients that don't know this type
 * ignore it and recover on their next reconnect.
 *
 * `epoch: 0` (sent by the server after POST /homes/:homeId/key/disable) means
 * E2EE was turned off. Frame encryption is fixed when a room connects, so a
 * keyed participant that re-fetches and sees epoch 0 must reconnect plaintext.
 * Like any rekey, it is only a hint: act on what the server returns.
 */
export interface RekeyMessage extends BaseMessage {
  type: "rekey";
  /** The new Home.keyEpoch. */
  epoch: number;
}

export type DataMessage =
  | CommandMessage
  | AckMessage
  | StateMessage
  | TelemetryMessage
  | RekeyMessage;

/* ---------------------------------------------------- Participant identity */

/** Metadata the backend embeds in each LiveKit token; readable by peers. */
export interface ParticipantMetadata {
  role: ParticipantRole;
  userId?: string;
  cameraId?: string;
  displayName?: string;
}

export function homeRoom(homeId: string): string {
  return `home:${homeId}`;
}

export function cameraIdentity(cameraId: string): string {
  return `camera:${cameraId}`;
}

export function viewerIdentity(userId: string, session: string): string {
  return `user:${userId}:${session}`;
}

export interface ParsedIdentity {
  role: ParticipantRole;
  id: string;
}

/** Inverse of the *Identity helpers. Returns null for unknown formats. */
export function parseIdentity(identity: string): ParsedIdentity | null {
  const [prefix, id] = identity.split(":");
  if (prefix === "camera" && id) return { role: "camera", id };
  if (prefix === "user" && id) return { role: "viewer", id };
  return null;
}

/* ------------------------------------------------------ (de)serialization */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encode a data message to bytes for LiveKit publishData. */
export function encodeDataMessage(msg: DataMessage): Uint8Array {
  return encoder.encode(JSON.stringify(msg));
}

const COMMAND_ACTIONS: ReadonlySet<string> = new Set<CommandAction>([
  "torch",
  "switchLens",
  "setZoom",
  "setQuality",
  "snapshotHint",
  "startRecord",
  "stopRecord",
  "talkStart",
  "talkStop",
  "alarm",
]);
const QUALITY_PRESETS: ReadonlySet<string> = new Set<QualityPreset>([
  "auto",
  "480p",
  "1080p",
  "max",
  "pure4k",
]);
const THERMAL_STATES: ReadonlySet<string> = new Set<ThermalState>([
  "nominal",
  "fair",
  "serious",
  "critical",
]);

const isStr = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 256;
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isBool = (x: unknown): x is boolean => typeof x === "boolean";
const isNullable = <T>(x: unknown, check: (v: unknown) => v is T): boolean =>
  x === null || x === undefined || check(x);

function isWifi(x: unknown): x is WifiInfo {
  if (typeof x !== "object" || x === null) return false;
  const w = x as Record<string, unknown>;
  return isNum(w.level) && (w.rssi === undefined || isNum(w.rssi)) && (w.ssid === undefined || typeof w.ssid === "string");
}

/**
 * Structural validation of a decoded data message. Unknown types, missing or
 * wrongly typed fields, and a protocol version other than PROTOCOL_VERSION are
 * all rejected, so receivers never act on (or render) a half-formed payload.
 */
export function isDataMessage(x: unknown): x is DataMessage {
  if (typeof x !== "object" || x === null) return false;
  const m = x as Record<string, unknown>;
  if (m.v !== PROTOCOL_VERSION) return false;
  switch (m.type) {
    case "command": {
      if (!isStr(m.id) || !isStr(m.target) || !isStr(m.action) || !COMMAND_ACTIONS.has(m.action)) return false;
      if (m.args === undefined || m.args === null) return true;
      if (typeof m.args !== "object") return false;
      const a = m.args as Record<string, unknown>;
      return (
        (a.on === undefined || isBool(a.on)) &&
        (a.lens === undefined || isNum(a.lens)) &&
        (a.zoom === undefined || isNum(a.zoom)) &&
        (a.quality === undefined || (typeof a.quality === "string" && QUALITY_PRESETS.has(a.quality)))
      );
    }
    case "ack":
      return isStr(m.commandId) && isBool(m.ok) && (m.error === undefined || typeof m.error === "string");
    case "state":
      return (
        isStr(m.cameraId) &&
        isBool(m.torchOn) &&
        isNum(m.lens) &&
        isNum(m.zoom) &&
        typeof m.quality === "string" &&
        QUALITY_PRESETS.has(m.quality) &&
        isBool(m.recording) &&
        isBool(m.talking)
      );
    case "telemetry":
      return (
        isStr(m.cameraId) &&
        isNullable(m.battery, isNum) &&
        isNullable(m.charging, isBool) &&
        isNullable(m.wifi, isWifi) &&
        (m.thermal === null || m.thermal === undefined || (typeof m.thermal === "string" && THERMAL_STATES.has(m.thermal))) &&
        isNum(m.viewerCount)
      );
    case "rekey":
      return isNum(m.epoch) && Number.isInteger(m.epoch) && m.epoch >= 0;
    default:
      return false;
  }
}

/** Decode bytes from a LiveKit data message; returns null if malformed, unknown, or another protocol version. */
export function decodeDataMessage(bytes: Uint8Array): DataMessage | null {
  try {
    const obj: unknown = JSON.parse(decoder.decode(bytes));
    return isDataMessage(obj) ? obj : null;
  } catch {
    return null;
  }
}

/**
 * Whether `senderIdentity` (the LiveKit participant identity that published
 * the packet, or null/undefined for server-originated data) may send `msg`.
 * Every receiver applies this before acting on a message:
 *   - state / telemetry: only the camera the payload is ABOUT
 *     (`camera:<msg.cameraId>`), so one participant cannot spoof another
 *     camera's battery, torch or talk state;
 *   - ack: only a camera (receivers additionally match it to the camera the
 *     command was sent to);
 *   - command: only a viewer (`user:…`) — never another camera and never
 *     sender-less data, which LiveKit only produces for the server API;
 *   - rekey: a viewer (the rotating owner's client) or the server itself.
 */
export function isAuthorizedSender(msg: DataMessage, senderIdentity: string | null | undefined): boolean {
  const sender = senderIdentity ? parseIdentity(senderIdentity) : null;
  switch (msg.type) {
    case "state":
    case "telemetry":
      return sender?.role === "camera" && sender.id === msg.cameraId;
    case "ack":
      return sender?.role === "camera";
    case "command":
      return sender?.role === "viewer";
    case "rekey":
      return !senderIdentity || sender?.role === "viewer";
    default:
      return false;
  }
}

/** Build a rekey broadcast with the current protocol version. */
export function makeRekey(epoch: number): RekeyMessage {
  return { v: PROTOCOL_VERSION, type: "rekey", epoch };
}

/** Build a command message with the current protocol version. */
export function makeCommand(
  target: string,
  action: CommandAction,
  args?: CommandArgs,
  id: string = crypto.randomUUID(),
): CommandMessage {
  return { v: PROTOCOL_VERSION, type: "command", id, target, action, args };
}
