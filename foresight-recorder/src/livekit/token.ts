/**
 * Mint a LiveKit token for the recorder to join a Home room as a HIDDEN,
 * subscribe-only participant. Mirrors foresight-server/src/livekit.ts mint().
 *
 *  - `hidden: true`     keeps the recorder out of the participant roster, so it
 *                       never inflates a camera's telemetry.viewerCount.
 *  - `recorder: true`   marks intent (informational).
 *  - subscribe-only     being a permanent subscriber is what keeps the phone
 *                       publishing 24/7 (dynacast pauses unsubscribed layers).
 *
 * The recorder identity uses a `rec:` prefix, which the server's parseIdentity()
 * does NOT recognize — so the server webhook ignores the recorder's own
 * join/leave automatically (no camera-state pollution).
 */
import { randomUUID } from "node:crypto";
import { AccessToken, type VideoGrant } from "livekit-server-sdk";
import { homeRoom } from "@foresight/contract";
import { config } from "../config.js";

export interface RecorderToken {
  url: string;
  room: string;
  identity: string;
  token: string;
}

export async function recorderToken(homeId: string): Promise<RecorderToken> {
  const room = homeRoom(homeId);
  const identity = `rec:${homeId}:${randomUUID().slice(0, 8)}`;

  const grant: VideoGrant = {
    roomJoin: true,
    room,
    canSubscribe: true,
    canPublish: false,
    canPublishData: false,
    hidden: true,
    recorder: true,
  };

  const at = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
    identity,
    // Long TTL: the recorder holds a room connection for as long as the camera
    // is live (potentially days).
    ttl: "168h",
  });
  at.addGrant(grant);

  return { url: config.livekitUrl, room, identity, token: await at.toJwt() };
}
