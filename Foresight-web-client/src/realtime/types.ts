/**
 * Runtime view-model types for the dashboard's live camera state. These layer
 * the realtime `state` + `telemetry` data messages (and LiveKit track info) on
 * top of the static CameraDTO from REST.
 */
import type {
  CameraDTO,
  QualityPreset,
  ThermalState,
  WifiInfo,
} from "@foresight/contract";
import type { RemoteParticipant, RemoteTrack } from "livekit-client";

/** Live, per-camera state derived from realtime messages + LiveKit. */
export interface LiveCamera {
  /** Camera id (the `:cameraId` part of the participant identity). */
  id: string;
  /** Static registry record from REST, if known. */
  dto: CameraDTO | null;
  /** Display name (DTO name, falls back to id). */
  name: string;

  /** LiveKit participant publishing this camera, if connected. */
  participant: RemoteParticipant | null;
  /** Subscribed video track, if any. */
  videoTrack: RemoteTrack | null;
  /** Subscribed audio track, if any. */
  audioTrack: RemoteTrack | null;

  /** True when a LiveKit participant for this camera is present. */
  online: boolean;
  /**
   * True when the room is E2EE but this camera's frames can't be decrypted yet
   * (awaiting key / key mismatch / mid-rotation blip). Drives the "Decrypting…"
   * tile instead of a frozen black video (§10.3).
   */
  decrypting: boolean;

  /* --- from `state` messages --- */
  torchOn: boolean;
  lens: number;
  zoom: number;
  quality: QualityPreset;
  recording: boolean;
  talking: boolean;

  /* --- from `telemetry` messages --- */
  battery: number | null;
  charging: boolean | null;
  wifi: WifiInfo | null;
  thermal: ThermalState | null;
  viewerCount: number | null;
}

export function initialLiveCamera(id: string, dto: CameraDTO | null): LiveCamera {
  return {
    id,
    dto,
    name: dto?.name ?? id,
    participant: null,
    videoTrack: null,
    audioTrack: null,
    online: dto?.online ?? false,
    decrypting: false,
    torchOn: false,
    lens: dto?.capabilities?.lenses[0] ?? 1,
    zoom: 1,
    quality: "auto",
    recording: false,
    talking: false,
    battery: dto?.status.battery ?? null,
    charging: dto?.status.charging ?? null,
    wifi: dto?.status.wifi ?? null,
    thermal: dto?.status.thermal ?? null,
    viewerCount: null,
  };
}
