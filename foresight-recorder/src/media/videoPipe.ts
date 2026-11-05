/**
 * VideoStream (decoded frames) → I420 → sink. The sink (CameraRecorder) owns the
 * ffmpeg process, geometry handling, and backpressure; this module just decodes
 * and normalizes frames to I420 (yuv420p) and hands them over.
 */
import { performance } from "node:perf_hooks";
import { VideoBufferType, VideoStream, type RemoteTrack } from "@livekit/rtc-node";
import type { Logger } from "../log.js";
import { frameTimestampUs } from "./pacer.js";

/**
 * Receives one normalized I420 frame. width/height let the sink detect
 * changes; tsUs is the frame's timestamp (µs) the sink paces the encoder by.
 */
export type VideoSink = (data: Uint8Array, width: number, height: number, tsUs: number) => void;

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
      const { frame, timestampUs } = value;
      const tsUs = frameTimestampUs(timestampUs, Math.round(performance.now() * 1000));
      // Convert whatever pixel format the SFU delivered to I420 for ffmpeg.
      const i420 = frame.type === VideoBufferType.I420 ? frame : frame.convert(VideoBufferType.I420);
      sink(i420.data, i420.width, i420.height, tsUs);
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
