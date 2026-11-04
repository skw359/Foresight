/**
 * VideoStream (decoded frames) → I420 → sink. The sink (CameraRecorder) owns the
 * ffmpeg process, geometry handling, and backpressure; this module just decodes
 * and normalizes frames to I420 (yuv420p) and hands them over.
 */
import { VideoBufferType, VideoStream, type RemoteTrack } from "@livekit/rtc-node";
import type { Logger } from "../log.js";

/** Receives one normalized I420 frame. width/height let the sink detect changes. */
export type VideoSink = (data: Uint8Array, width: number, height: number) => void;

/**
 * Pump a remote video track into `sink` until `signal` aborts or the track ends.
 * Each frame is converted to I420 (tightly packed yuv420p) for the rawvideo pipe.
 */
export async function pumpVideo(
  track: RemoteTrack,
  sink: VideoSink,
  signal: AbortSignal,
  log: Logger,
): Promise<void> {
  const stream = new VideoStream(track);
  const reader = stream.getReader();
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const { frame } = value;
      // Convert whatever pixel format the SFU delivered to I420 for ffmpeg.
      const i420 = frame.type === VideoBufferType.I420 ? frame : frame.convert(VideoBufferType.I420);
      sink(i420.data, i420.width, i420.height);
    }
  } catch (err) {
    if (!signal.aborted) log.warn("video pump error", { err: String(err) });
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}
