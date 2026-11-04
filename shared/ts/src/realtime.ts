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

/** Decode bytes from a LiveKit data message; returns null if malformed. */
export function decodeDataMessage(bytes: Uint8Array): DataMessage | null {
  try {
    const obj = JSON.parse(decoder.decode(bytes));
    if (obj && typeof obj.type === "string") return obj as DataMessage;
    return null;
  } catch {
    return null;
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
