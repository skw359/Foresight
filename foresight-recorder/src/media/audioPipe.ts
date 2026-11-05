/**
 * AudioStream (decoded PCM) → s16le → sink. Not on the v1 recording path
 * (RECORD_AUDIO=false by default).
 */
import { AudioStream, type RemoteTrack } from "@livekit/rtc-node";
import type { Logger } from "../log.js";

/** Receives one chunk of interleaved little-endian Int16 PCM. */
export type AudioSink = (pcm: Int16Array, sampleRate: number, channels: number) => void;

export interface AudioPumpOptions {
  sampleRate: number;
  channels: number;
}

/**
 * Pump a remote audio track into `sink` as s16le PCM until `signal` aborts or the
 * track ends. Not on the v1 recording path; see plan §10 / milestone M4.
 */
export async function pumpAudio(
  track: RemoteTrack,
  sink: AudioSink,
  opts: AudioPumpOptions,
  signal: AbortSignal,
  log: Logger,
): Promise<void> {
  const stream = new AudioStream(track, {
    sampleRate: opts.sampleRate,
    numChannels: opts.channels,
  });
  const reader = stream.getReader();
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      sink(value.data, value.sampleRate, value.channels);
    }
  } catch (err) {
    if (!signal.aborted) log.warn("audio pump error", { err: String(err) });
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}
