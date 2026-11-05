/**
 * LiveKit integration: mint room access tokens, verify webhooks, and broadcast
 * server-originated data messages into a Home's room.
 *
 * Rooms are one-per-Home (`home:<homeId>`). Viewers get subscribe + data +
 * microphone-only publish (push-to-talk); cameras get camera + microphone
 * publish + data + subscribe (to hear push-to-talk). Each token carries
 * ParticipantMetadata so peers can authorize one another.
 *
 * LiveKit only checks a token when a participant JOINS, so revoking access in
 * Foresight's database does nothing to a session that is already connected.
 * Every revocation path (member removal, camera/Home/account deletion) must
 * therefore also evict the affected participants — see evict*() below.
 */
import {
  AccessToken,
  DataPacket_Kind,
  RoomServiceClient,
  TrackSource,
  WebhookReceiver,
  type VideoGrant,
} from "livekit-server-sdk";
import {
  cameraIdentity,
  encodeDataMessage,
  homeRoom,
  parseIdentity,
  viewerIdentity,
  type DataMessage,
  type ParticipantMetadata,
} from "@foresight/contract";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

const receiver = new WebhookReceiver(config.livekitApiKey, config.livekitApiSecret);
const roomService = new RoomServiceClient(config.livekitUrl, config.livekitApiKey, config.livekitApiSecret);

/** LiveKit access-token lifetime for viewers and cameras. */
export const TOKEN_TTL = "2h";

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
    // Short-lived: a connected session receives refreshed tokens from the SFU,
    // and a FULL reconnect mints a new one through /rt/token (which re-checks
    // membership). A long TTL would let a removed member rejoin with a cached
    // token for hours after eviction.
    ttl: TOKEN_TTL,
  });
  at.addGrant(grant);
  return at.toJwt();
}

/** Viewer token: subscribe + data, plus MICROPHONE-only publish (push-to-talk). */
export function viewerToken(homeId: string, userId: string, displayName?: string) {
  const room = homeRoom(homeId);
  const identity = viewerIdentity(userId, randomUUID().slice(0, 8));
  const metadata: ParticipantMetadata = { role: "viewer", userId, displayName };
  const grant: VideoGrant = {
    roomJoin: true,
    room,
    canSubscribe: true,
    canPublish: true,
    // A viewer only ever publishes push-to-talk audio; it must not be able to
    // inject video or a screen share into the Home room.
    canPublishSources: [TrackSource.MICROPHONE],
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
    canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE],
    // Needed to hear push-to-talk. LiveKit grants cannot restrict WHICH tracks
    // a subscriber may take, so the camera app subscribes to viewer audio only
    // (autoSubscribe off); see the residual-risk note in shared/E2EE.md.
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

type WarnLog = { warn: (obj: unknown, msg?: string) => void };

/** True for "room/participant does not exist" — expected when nobody is connected. */
function isNotFound(err: unknown): boolean {
  const e = err as { status?: number; code?: string | number; message?: string };
  return e?.status === 404 || e?.code === "not_found" || /not.?found|does not exist/i.test(String(e?.message ?? err));
}

/**
 * Remove every participant of `home:<homeId>` whose identity matches `predicate`.
 * Never throws: an unreachable SFU or an empty room is logged (or ignored) —
 * the database change already took effect, and LiveKit tokens are short-lived.
 */
async function evictWhere(
  homeId: string,
  predicate: (identity: string) => boolean,
  log?: WarnLog,
): Promise<number> {
  const room = homeRoom(homeId);
  let evicted = 0;
  try {
    const participants = await roomService.listParticipants(room);
    for (const p of participants) {
      if (!predicate(p.identity)) continue;
      try {
        await roomService.removeParticipant(room, p.identity);
        evicted++;
      } catch (err) {
        if (!isNotFound(err)) log?.warn({ homeId, identity: p.identity, err: String(err) }, "participant eviction failed");
      }
    }
  } catch (err) {
    if (!isNotFound(err)) log?.warn({ homeId, err: String(err) }, "listing room participants failed");
  }
  return evicted;
}

/** Disconnect every live session of `userId` (all devices) from one Home's room. */
export function evictUser(homeId: string, userId: string, log?: WarnLog): Promise<number> {
  return evictWhere(
    homeId,
    (identity) => {
      const parsed = parseIdentity(identity);
      return parsed?.role === "viewer" && parsed.id === userId;
    },
    log,
  );
}

/** Disconnect a deleted camera's live session from its Home's room. */
export async function evictCamera(homeId: string, cameraId: string, log?: WarnLog): Promise<void> {
  try {
    await roomService.removeParticipant(homeRoom(homeId), cameraIdentity(cameraId));
  } catch (err) {
    if (!isNotFound(err)) log?.warn({ homeId, cameraId, err: String(err) }, "camera eviction failed");
  }
}

/** Close a deleted Home's room, disconnecting everyone in it. */
export async function closeHomeRoom(homeId: string, log?: WarnLog): Promise<void> {
  try {
    await roomService.deleteRoom(homeRoom(homeId));
  } catch (err) {
    if (!isNotFound(err)) log?.warn({ homeId, err: String(err) }, "room deletion failed");
  }
}
