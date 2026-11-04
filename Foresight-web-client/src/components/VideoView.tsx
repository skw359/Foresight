/**
 * Attaches a LiveKit RemoteTrack (or a raw MediaStreamTrack) to a <video>.
 * Optionally attaches a RemoteAudioTrack to a hidden <audio> element for
 * full-screen playback (browsers require the audio element to exist in the DOM
 * and room.startAudio() to have been called to satisfy autoplay policy).
 * Exposes the element via ref so callers can grab frames (snapshot) or build a
 * MediaStream (record). Detaches cleanly on unmount / track change.
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

    // LiveKit RemoteTrack attach/detach.
    useEffect(() => {
      const el = videoRef.current;
      if (!el || !track) return;
      track.attach(el);
      return () => {
        track.detach(el);
      };
    }, [track]);

    // LiveKit RemoteAudioTrack attach/detach.
    useEffect(() => {
      const el = audioRef.current;
      if (!el || !audioTrack) return;
      audioTrack.attach(el);
      return () => {
        audioTrack.detach(el);
      };
    }, [audioTrack]);

    // Raw MediaStreamTrack (dev camera preview).
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
