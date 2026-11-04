/**
 * A single camera tile in the Home grid. Renders the LOW-quality live video
 * (adaptiveStream + dynacast keep the layer low and pause off-screen tiles),
 * the name, health badges, and viewer count. Clicking opens full-screen.
 */
import { useEffect } from "react";
import { Track } from "livekit-client";
import type { RemoteVideoTrack } from "livekit-client";

import { VideoView } from "./VideoView";
import { Icon } from "./Icon";
import { asVideoTrack } from "../realtime/useHomeRoom";
import { pinLowLayer } from "../realtime/quality";
import type { LiveCamera } from "../realtime/types";

interface CameraTileProps {
  camera: LiveCamera;
  onOpen: () => void;
}

export function CameraTile({ camera, onOpen }: CameraTileProps) {
  const videoTrack = asVideoTrack(camera.videoTrack);

  // Pin the LOW simulcast layer for grid tiles per PROTOCOL.md §5.
  useEffect(() => {
    if (!camera.participant || !videoTrack) return;
    const pub = camera.participant.getTrackPublication(Track.Source.Camera);
    pinLowLayer(pub);
  }, [camera.participant, videoTrack]);

  const hasFeed = Boolean(videoTrack);

  return (
    <div className="tile" onClick={onOpen}>
      <div className="video-wrap">
        {camera.decrypting ? (
          // E2EE room, frames arriving but not decryptable yet (§10.3): show a
          // clear state instead of a frozen black tile.
          <div className="nofeed-overlay">
            <Icon name="lock" size={26} />
            <span>Decrypting…</span>
          </div>
        ) : hasFeed ? (
          <VideoView track={videoTrack as RemoteVideoTrack} muted />
        ) : camera.online ? (
          <div className="nofeed-overlay">
            <span className="spinner" />
            <span>Connecting feed…</span>
          </div>
        ) : (
          <div className="offline-overlay">
            <Icon name="camera" size={30} />
            <span>Camera offline</span>
          </div>
        )}

        {camera.viewerCount !== null && (
          <div className="viewer-pill" title="Viewers watching">
            <Icon name="eye" size={14} /> {camera.viewerCount}
          </div>
        )}

        <div className="tile-scrim">
          <span
            className={`live-dot ${camera.online ? "" : "offline"}`}
            title={camera.online ? "Live" : "Offline"}
          />
          <span className="tile-name" title={camera.name}>
            {camera.name}
          </span>
        </div>
      </div>
    </div>
  );
}
