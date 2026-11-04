/**
 * Connects the dashboard to a Home's LiveKit room as a VIEWER and exposes the
 * live camera state. This is the realtime backbone of the grid + full-screen
 * views.
 *
 * Responsibilities:
 *  - Mint a viewer token (POST /rt/token) and connect to `home:<homeId>`.
 *  - Enable adaptiveStream + dynacast so unviewed tiles pause and the grid
 *    naturally uses the LOW simulcast layer.
 *  - Track camera participants, their video/audio tracks, and merge in the
 *    `state` / `telemetry` data messages per the protocol contract.
 *  - Send `command` data messages addressed to a target camera identity, and
 *    correlate `ack`s.
 *
 * Commands ride the reliable DATA channel — never the media stream.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ConnectionState,
  DataPacket_Kind,
  ExternalE2EEKeyProvider,
  isE2EESupported,
  Participant,
  RemoteAudioTrack,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  Track,
} from "livekit-client";
import {
  cameraIdentity,
  decodeDataMessage,
  encodeDataMessage,
  makeCommand,
  makeRekey,
  parseIdentity,
  type CameraDTO,
  type CommandAction,
  type CommandArgs,
  type DataMessage,
} from "@foresight/contract";

import { getHomeKey, rtToken } from "../api/client";
import { useE2EE } from "../e2ee/E2EEContext";
import { reconcileBackfill } from "../e2ee/operations";
import { initialLiveCamera, type LiveCamera } from "./types";

export type RoomStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

/**
 * E2EE state for the room's UI (§7.2, §10.3):
 *  - "off"         → Home not activated (keyEpoch 0); plaintext exactly as before.
 *  - "unsupported" → activated Home but this browser/context can't do frame E2EE.
 *  - "locked"      → activated, but the user cancelled the unlock prompt.
 *  - "awaiting-key"→ activated, connected, but no sealed key for us yet.
 *  - "active"      → activated + keyed; decrypting normally.
 */
export type E2EEStatus = "off" | "unsupported" | "locked" | "awaiting-key" | "active";

export interface RoomE2EEState {
  status: E2EEStatus;
  /** Home.keyEpoch reflected from the last token (server bookkeeping, never a LiveKit index). */
  epoch: number;
}

export interface SendCommandResult {
  ok: boolean;
  error?: string;
}

export interface HomeRoomApi {
  status: RoomStatus;
  error: string | null;
  room: Room | null;
  /** E2EE state for this Home's room (badge + awaiting/unsupported UI). */
  e2ee: RoomE2EEState;
  /** Live cameras keyed by camera id, kept in sync with realtime messages. */
  cameras: Map<string, LiveCamera>;
  /** Ordered list for rendering (stable by id). */
  cameraList: LiveCamera[];
  /**
   * Send a command to a camera over the data channel and await its ack.
   * Resolves immediately (ok:true) if no ack arrives within the timeout — the
   * camera may not implement acks, and commands are best-effort/advisory.
   */
  sendCommand: (
    cameraId: string,
    action: CommandAction,
    args?: CommandArgs,
  ) => Promise<SendCommandResult>;
  /** Local viewer's mic, used for push-to-talk. */
  setMicrophoneEnabled: (enabled: boolean) => Promise<void>;
  /** Force a full reconnect (e.g. right after E2EE is turned on or off). */
  reconnect: () => void;
  /** Re-apply the HMK in place after a rotation (still LiveKit index 0; §3.2). */
  applyHomeKey: (hmkBase64: string, epoch: number) => Promise<void>;
  /** Broadcast a `rekey` to the room so cameras + other viewers re-fetch + re-setKey. */
  broadcastRekey: (epoch: number) => Promise<void>;
}

const ACK_TIMEOUT_MS = 4000;

/**
 * @param homeId    the Home to join (room = home:<homeId>)
 * @param cameraDtos REST camera records, merged into live state as they arrive
 * @param enabled   gate connection (e.g. wait until DTOs are loaded)
 */
export function useHomeRoom(
  homeId: string | null,
  cameraDtos: CameraDTO[],
  enabled = true,
): HomeRoomApi {
  const [status, setStatus] = useState<RoomStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [cameras, setCameras] = useState<Map<string, LiveCamera>>(new Map());
  const [e2ee, setE2EE] = useState<RoomE2EEState>({ status: "off", epoch: 0 });
  const [reconnectNonce, setReconnectNonce] = useState(0);

  const roomRef = useRef<Room | null>(null);
  const [room, setRoom] = useState<Room | null>(null);

  // The E2EE key provider for the current room (kept so a `rekey` message can
  // re-apply setKey live). Always used at LiveKit key index 0 (§3.2).
  const keyProviderRef = useRef<ExternalE2EEKeyProvider | null>(null);
  const e2eeApi = useE2EE();
  // Latest E2EE context methods for use inside the connect effect without
  // making it a dependency (they're stable, but keep the effect keyed on homeId).
  const e2eeRef = useRef(e2eeApi);
  e2eeRef.current = e2eeApi;

  // Pending ack resolvers keyed by command id.
  const pendingAcks = useRef<Map<string, (r: SendCommandResult) => void>>(
    new Map(),
  );

  // Keep the latest DTOs in a ref so the connect effect doesn't reconnect when
  // they refresh; we merge them into live state separately.
  const dtoRef = useRef<CameraDTO[]>(cameraDtos);
  dtoRef.current = cameraDtos;

  /** Apply a functional update to one camera (creating it if needed). */
  const patchCamera = useCallback(
    (id: string, fn: (c: LiveCamera) => LiveCamera) => {
      setCameras((prev) => {
        const next = new Map(prev);
        const existing =
          next.get(id) ??
          initialLiveCamera(
            id,
            dtoRef.current.find((d) => d.id === id) ?? null,
          );
        next.set(id, fn(existing));
        return next;
      });
    },
    [],
  );

  /* ---- merge REST DTOs into live state whenever they change ---- */
  useEffect(() => {
    setCameras((prev) => {
      const next = new Map(prev);
      for (const dto of cameraDtos) {
        const existing = next.get(dto.id);
        if (existing) {
          next.set(dto.id, {
            ...existing,
            dto,
            name: dto.name,
            // Prefer live telemetry but fall back to DTO status when absent.
            battery: existing.battery ?? dto.status.battery,
            charging: existing.charging ?? dto.status.charging,
            wifi: existing.wifi ?? dto.status.wifi,
            thermal: existing.thermal ?? dto.status.thermal,
          });
        } else {
          next.set(dto.id, initialLiveCamera(dto.id, dto));
        }
      }
      return next;
    });
  }, [cameraDtos]);

  /* ---- connect to the room (E2EE-aware) ---- */
  useEffect(() => {
    if (!homeId || !enabled) return;

    let cancelled = false;
    let lkRoom: Room | null = null;
    let e2eeWorker: Worker | null = null;

    function cameraIdOf(p: Participant): string | null {
      const parsed = parseIdentity(p.identity);
      return parsed && parsed.role === "camera" ? parsed.id : null;
    }

    function handleData(payload: Uint8Array, participant?: RemoteParticipant): void {
      const msg = decodeDataMessage(payload);
      if (!msg) return;
      applyMessage(msg, participant);
    }

    function applyMessage(msg: DataMessage, participant?: RemoteParticipant) {
      switch (msg.type) {
        case "state":
          patchCamera(msg.cameraId, (c) => ({
            ...c,
            torchOn: msg.torchOn,
            lens: msg.lens,
            zoom: msg.zoom,
            quality: msg.quality,
            recording: msg.recording,
            talking: msg.talking,
          }));
          break;
        case "telemetry":
          patchCamera(msg.cameraId, (c) => ({
            ...c,
            battery: msg.battery,
            charging: msg.charging,
            wifi: msg.wifi,
            thermal: msg.thermal,
            viewerCount: msg.viewerCount,
          }));
          break;
        case "ack": {
          const resolve = pendingAcks.current.get(msg.commandId);
          if (resolve) {
            pendingAcks.current.delete(msg.commandId);
            resolve({ ok: msg.ok, error: msg.error });
          }
          break;
        }
        case "rekey":
          // The HMK rotated (or E2EE was turned off) — re-fetch our sealed copy +
          // re-apply setKey (index 0 stays fixed; msg.epoch is bookkeeping). The
          // sub-second blip is v1 UX.
          void handleRekey();
          break;
        case "command":
          // Viewers don't act on commands; ignore. (Sender is `participant`.)
          void participant;
          break;
      }
    }

    async function handleRekey() {
      const provider = keyProviderRef.current;
      if (!provider || !homeId) return;
      try {
        const resp = await getHomeKey(homeId);
        if (cancelled) return;
        if (resp.epoch === 0) {
          // E2EE was turned off. Frame encryption is fixed per connection, so
          // rebuild the room plaintext instead of re-keying it.
          setReconnectNonce((n) => n + 1);
          return;
        }
        if (!resp.sealedKey) return;
        const hmkBase64 = await e2eeRef.current.unsealInto(homeId, {
          ciphertext: resp.sealedKey,
          epoch: resp.epoch,
        });
        await provider.setKey(hmkBase64);
        if (!cancelled) setE2EE({ status: "active", epoch: resp.epoch });
      } catch {
        /* transient — recovers on the next reconnect/reconcile */
      }
    }

    function attachParticipant(p: RemoteParticipant) {
      const parsed = parseIdentity(p.identity);
      if (!parsed || parsed.role !== "camera") return;
      patchCamera(parsed.id, (c) => ({
        ...c,
        participant: p,
        online: true,
        // p.name is the display name the server embeds in the LiveKit token
        // (camera.name from the DB). Use it as a fallback while the REST DTO
        // is still loading, or if it never arrives.
        name: c.dto?.name ?? p.name ?? c.name,
      }));
    }

    function detachParticipant(p: RemoteParticipant) {
      const parsed = parseIdentity(p.identity);
      if (!parsed || parsed.role !== "camera") return;
      patchCamera(parsed.id, (c) => ({
        ...c,
        participant: null,
        videoTrack: null,
        audioTrack: null,
        online: false,
        talking: false,
        decrypting: false,
      }));
    }

    function handleSubscribed(track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) {
      const parsed = parseIdentity(p.identity);
      if (!parsed || parsed.role !== "camera") return;
      patchCamera(parsed.id, (c) => ({
        ...c,
        participant: p,
        online: true,
        name: c.dto?.name ?? p.name ?? c.name,
        videoTrack: track.kind === Track.Kind.Video ? track : c.videoTrack,
        audioTrack: track.kind === Track.Kind.Audio ? track : c.audioTrack,
      }));
    }

    function handleUnsubscribed(track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) {
      const parsed = parseIdentity(p.identity);
      if (!parsed || parsed.role !== "camera") return;
      patchCamera(parsed.id, (c) => ({
        ...c,
        videoTrack: track.kind === Track.Kind.Video ? null : c.videoTrack,
        audioTrack: track.kind === Track.Kind.Audio ? null : c.audioTrack,
      }));
    }

    // E2EE observability (§10.3): render "Decrypting…" tiles, not frozen black video.
    function handleEncryptionError(_err: Error, participant?: Participant) {
      if (!participant) return;
      const id = cameraIdOf(participant);
      if (id) patchCamera(id, (c) => ({ ...c, decrypting: true }));
    }
    function handleEncryptionStatus(encrypted: boolean, participant?: Participant) {
      if (!participant) return;
      const id = cameraIdOf(participant);
      if (id) patchCamera(id, (c) => ({ ...c, decrypting: !encrypted }));
    }

    /** Post-connect (off the join path): resolve an awaiting key + backfill sweep. */
    async function afterConnect(epoch: number, hmk: string | null) {
      let hmkBase64 = hmk;
      if (!hmkBase64) {
        try {
          const st = await e2eeRef.current.ensureHomeKey(homeId!, epoch);
          if (!cancelled && st.hmkBase64 && keyProviderRef.current) {
            await keyProviderRef.current.setKey(st.hmkBase64);
            hmkBase64 = st.hmkBase64;
            setE2EE({ status: "active", epoch: st.epoch });
          }
        } catch {
          /* stay awaiting-key */
        }
      }
      if (hmkBase64 && !cancelled) {
        try {
          await reconcileBackfill(homeId!, hmkBase64, epoch);
        } catch {
          /* best effort — races are idempotent server-side */
        }
      }
    }

    (async () => {
      setStatus("connecting");
      setError(null);
      try {
        const rt = await rtToken({ homeId, role: "viewer" });
        if (cancelled) return;
        const epoch = rt.keyEpoch;

        const roomOptions: ConstructorParameters<typeof Room>[0] = {
          adaptiveStream: true,
          dynacast: true,
        };
        let hmkBase64: string | null = null;
        let e2eeStatus: E2EEStatus = "off";

        if (epoch >= 1) {
          // Activated Home: gate on frame-E2EE support + secure context (§7.2).
          if (!isE2EESupported() || !window.isSecureContext) {
            if (!cancelled) {
              setE2EE({ status: "unsupported", epoch });
              setStatus("error");
              setError(
                "This browser can't decrypt end-to-end encrypted video. Use a recent Chromium-based browser over HTTPS.",
              );
            }
            return;
          }

          // The HMK rides rt.sealedHomeKey — ZERO extra round-trips (§9.2).
          try {
            if (rt.sealedHomeKey) {
              hmkBase64 = await e2eeRef.current.unsealInto(homeId, rt.sealedHomeKey);
            } else {
              // Only a cache entry at the token's epoch counts — a stale HMK
              // would report "active" while every frame fails to decrypt.
              hmkBase64 = e2eeRef.current.getCachedHomeKey(homeId, epoch);
            }
          } catch (keyErr) {
            if (cancelled) return;
            if (keyErr instanceof Error && keyErr.message === "Unlock cancelled") {
              setE2EE({ status: "locked", epoch });
              setStatus("error");
              setError("Locked. Enter your password to view this Home's encrypted cameras.");
              return;
            }
            hmkBase64 = null; // treat as awaiting-key
          }

          const provider = new ExternalE2EEKeyProvider();
          e2eeWorker = new Worker(new URL("livekit-client/e2ee-worker", import.meta.url), {
            type: "module",
          });
          keyProviderRef.current = provider;
          if (hmkBase64) await provider.setKey(hmkBase64); // BEFORE connect (§7.2)
          e2eeStatus = hmkBase64 ? "active" : "awaiting-key";
          roomOptions.e2ee = { keyProvider: provider, worker: e2eeWorker };
        }

        lkRoom = new Room(roomOptions);
        lkRoom
          .on(RoomEvent.DataReceived, handleData)
          .on(RoomEvent.ParticipantConnected, attachParticipant)
          .on(RoomEvent.ParticipantDisconnected, detachParticipant)
          .on(RoomEvent.TrackSubscribed, handleSubscribed)
          .on(RoomEvent.TrackUnsubscribed, handleUnsubscribed)
          .on(RoomEvent.EncryptionError, handleEncryptionError)
          .on(RoomEvent.ParticipantEncryptionStatusChanged, handleEncryptionStatus)
          .on(RoomEvent.Reconnecting, () => !cancelled && setStatus("reconnecting"))
          .on(RoomEvent.Reconnected, () => !cancelled && setStatus("connected"))
          .on(RoomEvent.Disconnected, () => {
            if (!cancelled) setStatus("disconnected");
          })
          .on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
            if (cancelled) return;
            if (state === ConnectionState.Connected) setStatus("connected");
          });

        await lkRoom.connect(rt.livekitUrl, rt.token);
        if (cancelled) {
          await lkRoom.disconnect();
          return;
        }
        if (epoch >= 1) {
          await lkRoom.setE2EEEnabled(true); // then enable (§7.2)
        }
        roomRef.current = lkRoom;
        setRoom(lkRoom);
        setStatus("connected");
        setE2EE({ status: epoch >= 1 ? e2eeStatus : "off", epoch });

        // Seed from participants already in the room.
        for (const p of lkRoom.remoteParticipants.values()) {
          attachParticipant(p);
          for (const pub of p.trackPublications.values()) {
            if (pub.track) {
              handleSubscribed(pub.track, pub as RemoteTrackPublication, p);
            }
          }
        }

        if (epoch >= 1) void afterConnect(epoch, hmkBase64);
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : "Failed to connect to the room.");
      }
    })();
    void reconnectNonce; // re-run this effect when a reconnect is requested

    return () => {
      cancelled = true;
      const room = lkRoom;
      if (room) {
        room.removeAllListeners();
        room.disconnect().catch(() => undefined);
        if (roomRef.current === room) {
          roomRef.current = null;
          setRoom(null);
        }
      } else if (e2eeWorker) {
        // Cancelled before the Room took ownership of the worker.
        e2eeWorker.terminate();
      }
      keyProviderRef.current = null;
      // Fail any in-flight commands.
      for (const [, resolve] of pendingAcks.current) {
        resolve({ ok: false, error: "Disconnected" });
      }
      pendingAcks.current.clear();
    };
  }, [homeId, enabled, patchCamera, reconnectNonce]);

  /* ---- send a command over the data channel ---- */
  const sendCommand = useCallback(
    async (
      cameraId: string,
      action: CommandAction,
      args?: CommandArgs,
    ): Promise<SendCommandResult> => {
      const lkRoom = roomRef.current;
      if (!lkRoom || lkRoom.state !== ConnectionState.Connected) {
        return { ok: false, error: "Not connected" };
      }
      const cmd = makeCommand(cameraId, action, args);
      const targetIdentity = cameraIdentity(cameraId);

      const ackPromise = new Promise<SendCommandResult>((resolve) => {
        pendingAcks.current.set(cmd.id, resolve);
        setTimeout(() => {
          if (pendingAcks.current.delete(cmd.id)) {
            // No ack — treat as best-effort success (advisory commands).
            resolve({ ok: true });
          }
        }, ACK_TIMEOUT_MS);
      });

      try {
        await lkRoom.localParticipant.publishData(encodeDataMessage(cmd), {
          reliable: true,
          destinationIdentities: [targetIdentity],
        });
      } catch (err) {
        pendingAcks.current.delete(cmd.id);
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Failed to send command",
        };
      }
      return ackPromise;
    },
    [],
  );

  const setMicrophoneEnabled = useCallback(async (en: boolean) => {
    const lkRoom = roomRef.current;
    if (!lkRoom) return;
    await lkRoom.localParticipant.setMicrophoneEnabled(en);
  }, []);

  const reconnect = useCallback(() => setReconnectNonce((n) => n + 1), []);

  const applyHomeKey = useCallback(
    async (hmkBase64: string, epoch: number) => {
      const provider = keyProviderRef.current;
      if (!homeId || !provider) return;
      await provider.setKey(hmkBase64); // index 0 (§3.2)
      e2eeRef.current.cacheHomeKey(homeId, epoch, hmkBase64);
      setE2EE({ status: "active", epoch });
    },
    [homeId],
  );

  const broadcastRekey = useCallback(async (epoch: number) => {
    const lkRoom = roomRef.current;
    if (!lkRoom || lkRoom.state !== ConnectionState.Connected) return;
    await lkRoom.localParticipant.publishData(encodeDataMessage(makeRekey(epoch)), {
      reliable: true,
    });
  }, []);

  const cameraList = useMemo(
    () =>
      [...cameras.values()].sort((a, b) =>
        a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      ),
    [cameras],
  );

  return {
    status,
    error,
    room,
    e2ee,
    cameras,
    cameraList,
    sendCommand,
    setMicrophoneEnabled,
    reconnect,
    applyHomeKey,
    broadcastRekey,
  };
}

/* ----------------------------------------------------------------- helpers */

/** Narrow a RemoteTrack to a video track (for attaching to a <video>). */
export function asVideoTrack(t: RemoteTrack | null): RemoteVideoTrack | null {
  return t && t.kind === Track.Kind.Video ? (t as RemoteVideoTrack) : null;
}

/** Narrow a RemoteTrack to an audio track. */
export function asAudioTrack(t: RemoteTrack | null): RemoteAudioTrack | null {
  return t && t.kind === Track.Kind.Audio ? (t as RemoteAudioTrack) : null;
}

export { DataPacket_Kind };
