/**
 * Full-screen view of a single camera + the control panel. Pins the HIGH/Max
 * simulcast layer for the selected camera (per PROTOCOL.md §5), shows the
 * "Viewer is speaking" indicator during PTT, and live health badges.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavStage } from "../context/navStage";
import { useNavProgressWhileLoading } from "../context/navProgress";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Track } from "livekit-client";
import type { RemoteVideoTrack } from "livekit-client";
import type { HomeDTO, QualityPreset } from "@foresight/contract";

import { listHomes } from "../api/client";
import { VideoView, type VideoViewHandle } from "../components/VideoView";
import { HealthBadges } from "../components/HealthBadges";
import { ControlPanel } from "../components/ControlPanel";
import { RecordingsPanel } from "../components/RecordingsPanel";
import { Icon } from "../components/Icon";
import { useCameras } from "../realtime/useCameras";
import { asAudioTrack, asVideoTrack, useHomeRoom } from "../realtime/useHomeRoom";
import { applySubscriptionQuality, isSingleLayer4K } from "../realtime/quality";
import type { LiveCamera } from "../realtime/types";

interface Toast {
  msg: string;
  error: boolean;
}

export function CameraPage() {
  const { homeId, cameraId } = useParams<{
    homeId: string;
    cameraId: string;
  }>();
  const navigate = useNavigate();

  const { cameras: dtos, loading } = useCameras(homeId ?? null);
  const room = useHomeRoom(homeId ?? null, dtos, true);
  const [home, setHome] = useState<HomeDTO | null>(null);

  useNavProgressWhileLoading(loading);

  // Resolve the Home for the recording gate (keyEpoch + recorderConsented).
  useEffect(() => {
    if (!homeId) return;
    const ctrl = new AbortController();
    listHomes(ctrl.signal)
      .then((homes) => setHome(homes.find((h) => h.id === homeId) ?? null))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [homeId]);

  const videoRef = useRef<VideoViewHandle>(null);
  const videoWrapRef = useRef<HTMLDivElement>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [showRename, setShowRename] = useState(false);
  const [showRemove, setShowRemove] = useState(false);

  const camera: LiveCamera | undefined = cameraId
    ? room.cameras.get(cameraId)
    : undefined;

  const videoTrack = asVideoTrack(camera?.videoTrack ?? null);
  const audioTrack = asAudioTrack(camera?.audioTrack ?? null);

  // Pin the camera's current quality preset (defaults to its layer) on the
  // full-screen subscription. In auto this is adaptive; otherwise HIGH/Max.
  useEffect(() => {
    if (!camera?.participant || !videoTrack) return;
    const pub = camera.participant.getTrackPublication(Track.Source.Camera);
    applySubscriptionQuality(pub, camera.quality);
  }, [camera?.participant, camera?.quality, videoTrack]);

  // Leaving this page: if the camera is still on Max (true 4K), drop it back to
  // 1080p. Single-layer 4K has no low layer for the grid to fall back to, so
  // every tile would decode the full 3840×2160 stream into a thumbnail. Mirrors
  // the mobile viewers' behaviour on exiting full-screen.
  const restoreRef = useRef<{ id: string; quality: QualityPreset } | null>(null);
  useEffect(() => {
    restoreRef.current = camera
      ? { id: camera.id, quality: camera.quality }
      : null;
  }, [camera?.id, camera?.quality]);
  const sendCommand = room.sendCommand;
  useEffect(() => {
    return () => {
      const last = restoreRef.current;
      if (last && isSingleLayer4K(last.quality)) {
        void sendCommand(last.id, "setQuality", { quality: "1080p" });
      }
    };
  }, [sendCommand]);

  // Unlock audio playback. Browsers gate autoplay-with-sound behind a user
  // gesture; navigating to this page counts as one, so we call startAudio()
  // here. This is a no-op if audio is already unlocked.
  useEffect(() => {
    room.room?.startAudio().catch(() => undefined);
  }, [room.room]);

  const showToast = useCallback((msg: string, error = false) => {
    setToast({ msg, error });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  const getVideoEl = useCallback(() => videoRef.current?.el ?? null, []);
  const getVideoWrap = useCallback(() => videoWrapRef.current, []);

  const backToHome = useCallback(() => {
    navigate(`/homes/${homeId}`);
  }, [navigate, homeId]);

  const renamedHandler = useCallback(
    (_name: string) => {
      // Live state updates via REST refresh + room merge; nothing extra needed.
    },
    [],
  );

  const headerName = useMemo(
    () => camera?.name ?? cameraId ?? "Camera",
    [camera?.name, cameraId],
  );

  const stage = useNavStage();

  if (!homeId || !cameraId) return null;

  return (
    <>
      <div className="breadcrumb-rail">
        <div className="breadcrumb">
          <Link to="/">Homes</Link>
          <span className="sep"><Icon name="chevronRight" size={13} /></span>
          <Link to={`/homes/${homeId}`}>Cameras</Link>
          <span className="sep"><Icon name="chevronRight" size={13} /></span>
          <span>{headerName}</span>
        </div>
      </div>

      <div className={`page wide no-top nav-fade ${stage}`}>
        <div className="section-head">
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <button className="btn ghost sm" onClick={backToHome}>
              <Icon name="arrowLeft" size={16} />
              Back
            </button>
            {camera && (
              <span
                title={camera.online ? "Online" : "Offline"}
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: "50%",
                  background: camera.online ? "var(--success)" : "var(--danger)",
                  flexShrink: 0,
                }}
              />
            )}
            <h1>{headerName}</h1>
            {camera && (
              <>
                <button
                  className="btn ghost sm"
                  onClick={() => setShowRename(true)}
                  title="Rename camera"
                  style={{ padding: "6px 8px" }}
                >
                  <Icon name="edit" size={15} />
                </button>
                {home?.role === "owner" && (
                  <button
                    className="btn ghost sm"
                    onClick={() => setShowRemove(true)}
                    title="Remove camera"
                    style={{ padding: "6px 8px", color: "var(--danger)" }}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {room.error && (
          <div className="notice-box">
            Live connection unavailable: {room.error}. Video + controls will work
            once the backend + LiveKit are reachable.
          </div>
        )}

        {!camera ? (
          <div className="empty">
            <p>This camera isn't in this Home.</p>
            <button className="btn" onClick={backToHome}>
              Back to cameras
            </button>
          </div>
        ) : (
          <div className="fs-layout">
            <div className="fs-video-wrap" ref={videoWrapRef}>
              {videoTrack ? (
                <VideoView
                  ref={videoRef}
                  track={videoTrack as RemoteVideoTrack}
                  audioTrack={audioTrack}
                  muted
                />
              ) : camera.online ? (
                <div className="nofeed-overlay">
                  <span className="spinner" />
                  <span>Connecting feed…</span>
                </div>
              ) : (
                <div className="offline-overlay">
                  <Icon name="camera" size={36} />
                  <span>Camera offline</span>
                </div>
              )}

              <div className="overlay-top">
                <HealthBadges
                  battery={camera.battery}
                  charging={camera.charging}
                  wifi={camera.wifi}
                  thermal={camera.thermal}
                />
                {camera.viewerCount !== null && (
                  <div className="viewer-pill viewer-pill-inline">
                    <Icon name="eye" size={14} /> {camera.viewerCount} watching
                  </div>
                )}
              </div>

              {camera.talking && (
                <div className="talk-indicator">
                  <Icon name="mic" size={15} /> You are speaking
                </div>
              )}

              <ControlPanel
                camera={camera}
                room={room}
                getVideoEl={getVideoEl}
                getVideoWrap={getVideoWrap}
                showRename={showRename}
                onShowRenameChange={setShowRename}
                showRemove={showRemove}
                onShowRemoveChange={setShowRemove}
                onRenamed={renamedHandler}
                onRemoved={backToHome}
                onToast={showToast}
              />
            </div>

            <RecordingsPanel
              cameraId={cameraId}
              // Deliberately no `?? false`: an unresolved DTO means "unknown",
              // and the panel must not claim recording is off while unknown.
              recordingEnabled={camera.dto?.recordingEnabled}
              recordingGated={!!home && home.keyEpoch >= 1 && !home.recorderConsented}
              // Deleting footage and turning recording OFF are owner-only.
              canManage={home?.role === "owner"}
              homeId={home?.id}
              onToast={showToast}
            />
          </div>
        )}
      </div>

      {toast && (
        <div className={`cmd-toast ${toast.error ? "err" : ""}`}>
          {toast.msg}
        </div>
      )}
    </>
  );
}
