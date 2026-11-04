/**
 * LiveKit integration: mint room access tokens, verify webhooks, and broadcast
 * server-originated data messages into a Home's room.
 *
 * Rooms are one-per-Home (`home:<homeId>`). Viewers get subscribe + data +
 * (push-to-talk) publish; cameras get publish + data + subscribe. Each token
 * carries ParticipantMetadata so peers can authorize one another.
 */
import {
  AccessToken,
  DataPacket_Kind,
  RoomServiceClient,
  WebhookReceiver,
  type VideoGrant,
} from "livekit-server-sdk";
import {
  cameraIdentity,
  encodeDataMessage,
  homeRoom,
  viewerIdentity,
  type DataMessage,
  type ParticipantMetadata,
} from "@foresight/contract";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

const receiver = new WebhookReceiver(config.livekitApiKey, config.livekitApiSecret);
const roomService = new RoomServiceClient(config.livekitUrl, config.livekitApiKey, config.livekitApiSecret);

async function mint(
  identity: string,
  metadata: ParticipantMetadata,
  grant: VideoGrant,
  displayName?: string,
): Promise<string> {
  const at = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
    identity,
    name: displayName,
    metadata: JSON.stringify(metadata),
    ttl: "12h",
  });
  at.addGrant(grant);
  return at.toJwt();
}

/** Viewer token: subscribe + data, plus publish (so push-to-talk audio works). */
export function viewerToken(homeId: string, userId: string, displayName?: string) {
  const room = homeRoom(homeId);
  const identity = viewerIdentity(userId, randomUUID().slice(0, 8));
  const metadata: ParticipantMetadata = { role: "viewer", userId, displayName };
  const grant: VideoGrant = {
    roomJoin: true,
    room,
    canSubscribe: true,
    canPublish: true,
    canPublishData: true,
  };
  return { room, identity, token: mint(identity, metadata, grant, displayName) };
}

/** Camera token: publish A/V + data, and subscribe (to hear push-to-talk). */
export function cameraToken(homeId: string, cameraId: string, name?: string) {
  const room = homeRoom(homeId);
  const identity = cameraIdentity(cameraId);
  const metadata: ParticipantMetadata = { role: "camera", cameraId, displayName: name };
  const grant: VideoGrant = {
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  };
  return { room, identity, token: mint(identity, metadata, grant, name) };
}

export async function receiveWebhook(body: string, authHeader: string | undefined) {
  return receiver.receive(body, authHeader);
}

/**
 * Send a reliable data message to every participant in a Home's room, from the
 * server itself. Fire-and-forget and NEVER throws: an empty room (no room to
 * send to) or an unreachable SFU is logged, and clients still converge on their
 * next reconnect.
 */
export async function broadcastToHome(
  homeId: string,
  msg: DataMessage,
  log?: { warn: (obj: unknown, msg?: string) => void },
): Promise<void> {
  try {
    await roomService.sendData(homeRoom(homeId), encodeDataMessage(msg), DataPacket_Kind.RELIABLE, {});
  } catch (err) {
    log?.warn({ homeId, type: msg.type, err: String(err) }, "room broadcast failed");
  }
}
