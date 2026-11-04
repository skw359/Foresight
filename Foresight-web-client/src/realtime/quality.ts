/**
 * Maps the protocol's QualityPreset to a LiveKit subscription quality. This is
 * the viewer-side simulcast layer pin (per PROTOCOL.md §5):
 *   auto   → adaptive (let LiveKit/dynacast decide)
 *   480p   → LOW
 *   1080p  → HIGH (top of the high-bitrate 1080p simulcast ladder)
 *   max    → HIGH (the camera publishes true 4K as a SINGLE non-simulcast
 *            layer, so this just pins the one/only layer)
 *   pure4k → HIGH (legacy wire value for the same single-layer 4K as `max`)
 *
 * The same `setQuality` command is also sent to the camera over the data
 * channel so it can pin its publish layer; this function governs the local
 * subscription.
 */
import { VideoQuality } from "livekit-client";
import type { QualityPreset } from "@foresight/contract";
import type { RemoteTrackPublication } from "livekit-client";

export const QUALITY_LABELS: Record<QualityPreset, string> = {
  auto: "Auto",
  "480p": "480p",
  "1080p": "1080p",
  max: "Max",
  // Legacy: cameras/viewers on the old protocol still speak `pure4k`, which is
  // the same single-layer 4K that `max` now selects.
  pure4k: "Max",
};

// The four presets the viewer UI offers. `pure4k` isn't one of them — it's the
// legacy wire alias for `max`.
export const QUALITY_ORDER: QualityPreset[] = ["auto", "480p", "1080p", "max"];

/**
 * The preset the picker should show as selected for a camera's reported
 * quality: a legacy `pure4k` camera state maps onto the `max` segment.
 */
export function selectedPreset(quality: QualityPreset): QualityPreset {
  return quality === "pure4k" ? "max" : quality;
}

/** Whether a preset asks the camera for the single-layer 4K publish. */
export function isSingleLayer4K(quality: QualityPreset): boolean {
  return quality === "max" || quality === "pure4k";
}

/** Returns the LiveKit VideoQuality for a preset, or null for adaptive. */
export function presetToVideoQuality(
  preset: QualityPreset,
): VideoQuality | null {
  switch (preset) {
    case "480p":
      return VideoQuality.LOW;
    case "1080p":
      return VideoQuality.HIGH;
    case "max":
    case "pure4k":
      // Max is true 4K published as a single non-simulcast layer; HIGH pins the
      // only layer there is (harmless on a non-simulcast track). On a camera
      // with no 4K sensor it pins the top of the 1080p ladder instead.
      return VideoQuality.HIGH;
    case "auto":
    default:
      return null;
  }
}

/**
 * Apply a quality preset to a video publication subscription. In `auto` we let
 * adaptiveStream manage it; otherwise we pin an explicit simulcast layer.
 */
export function applySubscriptionQuality(
  pub: RemoteTrackPublication | undefined,
  preset: QualityPreset,
): void {
  if (!pub) return;
  const q = presetToVideoQuality(preset);
  if (q === null) {
    // Auto: re-enable adaptive behaviour by clearing any manual FPS/quality pin.
    pub.setVideoQuality(VideoQuality.HIGH);
    return;
  }
  pub.setVideoQuality(q);
}

/** Force a publication to the LOW layer — used for grid tiles. */
export function pinLowLayer(pub: RemoteTrackPublication | undefined): void {
  if (!pub) return;
  pub.setVideoQuality(VideoQuality.LOW);
}
