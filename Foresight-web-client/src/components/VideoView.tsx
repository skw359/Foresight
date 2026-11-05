/**
 * Attaches a LiveKit RemoteTrack (or a raw MediaStreamTrack) to a <video>, and
 * optionally a RemoteAudioTrack to a hidden <audio> element. The element is
 * exposed via ref so callers can grab frames (snapshot) or build a
 * MediaStream (record).
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { RemoteAudioTrack, RemoteTrack } from "livekit-client";

export interface VideoViewHandle {
  /** The underlying <video> element, or null before mount. */
  readonly el: HTMLVideoElement | null;
}

interface VideoViewProps {
  /** LiveKit remote track to render (preferred). */
  track?: RemoteTrack | null;
  /**
   * LiveKit audio track to play. When provided, a hidden <audio> element is
   * rendered and the track is attached to it. This keeps the subscription alive
   * under adaptiveStream and satisfies browser autoplay after room.startAudio().
   */
  audioTrack?: RemoteAudioTrack | null;
  /** Raw media track to render (used by the dev camera preview). */
  mediaTrack?: MediaStreamTrack | null;
  muted?: boolean;
  mirror?: boolean;
  className?: string;
}

export const VideoView = forwardRef<VideoViewHandle, VideoViewProps>(
  function VideoView(
    { track, audioTrack, mediaTrack, muted = true, mirror = false, className },
    ref,
  ) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const audioRef = useRef<HTMLAudioElement>(null);

    useImperativeHandle(ref, () => ({ get el() {
      return videoRef.current;
    } }), []);

    useEffect(() => {
      const el = videoRef.current;
      if (!el || !track) return;
      track.attach(el);
      return () => {
        track.detach(el);
      };
    }, [track]);

    useEffect(() => {
      const el = audioRef.current;
      if (!el || !audioTrack) return;
      audioTrack.attach(el);
      return () => {
        audioTrack.detach(el);
      };
    }, [audioTrack]);

    useEffect(() => {
      const el = videoRef.current;
      if (!el || track) return; // LiveKit track takes precedence
      if (!mediaTrack) {
        el.srcObject = null;
        return;
      }
      const stream = new MediaStream([mediaTrack]);
      el.srcObject = stream;
      el.play().catch(() => undefined);
      return () => {
        if (el.srcObject === stream) el.srcObject = null;
      };
    }, [mediaTrack, track]);

    return (
      <>
        <video
          ref={videoRef}
          className={className}
          muted={muted}
          autoPlay
          playsInline
          style={mirror ? { transform: "scaleX(-1)" } : undefined}
        />
        {/* Hidden audio element — only rendered when an audioTrack is provided.
            LiveKit's attach() wires the MediaStream; autoPlay satisfies the
            browser after room.startAudio() has been called on user interaction. */}
        {audioTrack && <audio ref={audioRef} autoPlay />}
      </>
    );
  },
);
