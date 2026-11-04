/**
 * Pin a subscription to one simulcast layer.
 *
 * A subscriber that never states a preference gets whatever the SFU decides to
 * forward, and LiveKit demotes that choice freely: recording a phone that
 * publishes 480x270 / 960x540 / 1920x1080 was observed landing on all three
 * within minutes, plus the publisher's own bandwidth downscales of each
 * (240x135, 320x180, 640x360, 1280x720). For 24/7 footage that is never what we
 * want — we want the top layer, always.
 *
 * @livekit/rtc-node 0.13.29 (Developer Preview) wraps only SetSubscribedRequest
 * on a RemoteTrackPublication, so there is no `setVideoQuality` to call. The FFI
 * underneath it does have one: @livekit/rtc-ffi-bindings (the version rtc-node
 * itself pins) ships `SetRemoteTrackPublicationQualityRequest`, and rtc-node's
 * own `setSubscribed` shows the shape — encode an FfiRequest naming the
 * publication's handle, hand it to livekitFfiRequest. That is what this module
 * does, through the very same native client rtc-node initialized (the bindings
 * hoist to a single instance), so no second FFI initialization happens.
 *
 * Two internals are load-bearing and deliberately isolated here:
 *   - `RemoteTrackPublication.ffiHandle` is marked @internal in the .d.ts but is
 *     a normal runtime property — the same situation as E2EEManager.keyProvider
 *     in roomManager.ts, handled the same way. HANDLE_CONTRACT below makes an
 *     rtc-node upgrade that moves it a typecheck failure rather than a silent
 *     regression back to unpinned recording.
 *   - the FfiRequest oneof case name `setRemoteTrackPublicationQuality`.
 * A runtime failure is logged and tolerated: an unpinned recorder still records,
 * just at the SFU's whim.
 */
import type { RemoteTrackPublication } from "@livekit/rtc-node";
import {
  FfiRequest,
  FfiResponse,
  VideoQuality,
  livekitFfiRequest,
} from "@livekit/rtc-ffi-bindings";
import type { Logger } from "../log.js";

/** config.recordLayer → the FFI enum. */
const QUALITY_BY_LAYER = {
  low: VideoQuality.LOW,
  medium: VideoQuality.MEDIUM,
  high: VideoQuality.HIGH,
} as const;

export type LayerName = keyof typeof QUALITY_BY_LAYER;

/** The FFI oneof case for SetRemoteTrackPublicationQualityRequest (ffi.proto field 68). */
const SET_QUALITY_CASE = "setRemoteTrackPublicationQuality";

/**
 * Compile-time guard on the one rtc-node internal we reach into: if a future
 * version drops or renames `ffiHandle`, this stops typechecking here instead of
 * degrading silently at runtime.
 */
const HANDLE_CONTRACT: (pub: RemoteTrackPublication) => bigint = (pub) => pub.ffiHandle.handle;

/**
 * Read the publication's FFI handle, or null when the property is absent —
 * belt to HANDLE_CONTRACT's braces, since the recorder must degrade rather than
 * throw inside a room event handler.
 */
export function ffiHandleOf(pub: unknown): bigint | null {
  const handle = (pub as { ffiHandle?: { handle?: bigint } }).ffiHandle?.handle;
  return typeof handle === "bigint" ? handle : null;
}

/** Encode the "forward this layer to me" FFI request. Pure, so it is unit-tested. */
export function buildSetQualityRequest(handle: bigint, layer: LayerName): Uint8Array {
  return new FfiRequest({
    message: {
      case: SET_QUALITY_CASE,
      // Both fields are `required` in the proto2 FFI schema — omitting either
      // throws at encode time rather than being silently defaulted.
      value: { trackPublicationHandle: handle, quality: QUALITY_BY_LAYER[layer] },
    },
  }).toBinary();
}

/**
 * Ask the SFU to forward `layer` for this publication. Idempotent and cheap, so
 * callers may re-pin freely. Returns whether the request was sent.
 */
export function pinVideoQuality(pub: unknown, layer: LayerName, log: Logger): boolean {
  const handle = ffiHandleOf(pub);
  if (handle === null) {
    log.warn("cannot pin layer: no ffiHandle on publication (rtc-node internals moved?)");
    return false;
  }
  try {
    FfiResponse.fromBinary(livekitFfiRequest(buildSetQualityRequest(handle, layer)));
    return true;
  } catch (err) {
    // An unpinned subscription still records — just at whatever layer the SFU picks.
    log.warn("layer pin failed", { layer, err: String(err) });
    return false;
  }
}

// Referenced so the contract above is not elided as unused.
void HANDLE_CONTRACT;
