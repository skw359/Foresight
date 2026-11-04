/**
 * Full control panel for a camera. EVERY command rides the LiveKit DATA
 * channel (via `sendCommand`), never the media stream:
 *
 *   - quality selector (Auto / 480p / 1080p / Max)  → setQuality
 *   - audio on/off + listen                          → local subscribe volume
 *   - push-to-talk (hold)                            → publish mic + talkStart/Stop
 *   - flashlight (only if capabilities.torch)        → torch
 *   - lens switcher (only capabilities.lenses)       → switchLens
 *   - digital zoom (1..capabilities.maxDigitalZoom)  → setZoom
 *   - snapshot (canvas → PNG)                        → snapshotHint + local grab
 *   - record (MediaRecorder → .webm)                 → startRecord/stopRecord + local
 *   - rename camera                                  → PATCH /cameras/:id
 *   - remove camera                                  → DELETE /cameras/:id
 *
 * Controls are capability-gated: torch and lens options only render when the
 * camera reports them. Quality also pins the local subscription layer.
 */
import { useEffect, useRef, useState } from "react";
import { Track } from "livekit-client";
import type { QualityPreset } from "@foresight/contract";

import type { LiveCamera } from "../realtime/types";
import type { HomeRoomApi } from "../realtime/useHomeRoom";
import {
  QUALITY_LABELS,
  QUALITY_ORDER,
  applySubscriptionQuality,
  selectedPreset,
} from "../realtime/quality";
import { VideoRecorder, snapshotToPng } from "../realtime/capture";
import { ApiRequestError, deleteCamera, renameCamera } from "../api/client";
import { rotateHome } from "../e2ee/operations";
import { Modal } from "./Modal";
import { Icon } from "./Icon";

interface ControlPanelProps {
  camera: LiveCamera;
  room: HomeRoomApi;
  /** Provides the live <video> element for snapshot/record. */
  getVideoEl: () => HTMLVideoElement | null;
  /** Provides the video wrapper element for fullscreen. */
  getVideoWrap: () => HTMLDivElement | null;
  /** Controlled by CameraPage — pencil icon next to the camera name triggers this. */
  showRename: boolean;
  onShowRenameChange: (v: boolean) => void;
  /** Controlled by CameraPage — trash icon next to the camera name triggers this. */
  showRemove: boolean;
  onShowRemoveChange: (v: boolean) => void;
  onRenamed: (name: string) => void;
  onRemoved: () => void;
  onToast: (msg: string, error?: boolean) => void;
}

export function ControlPanel({
  camera,
  room,
  getVideoEl,
  getVideoWrap,
  showRename,
  onShowRenameChange,
  showRemove,
  onShowRemoveChange,
  onRenamed,
  onRemoved,
  onToast,
}: ControlPanelProps) {
  const caps = camera.dto?.capabilities ?? null;
  const { sendCommand, setMicrophoneEnabled } = room;

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [talking, setTalking] = useState(false);
  const [recording, setRecording] = useState(false);
  const [zoomLocal, setZoomLocal] = useState(camera.zoom);

  const recorderRef = useRef<VideoRecorder | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Keep the zoom slider in sync with authoritative state from the camera.
  useEffect(() => {
    setZoomLocal(camera.zoom);
  }, [camera.zoom]);

  // Subscribe/unsubscribe to the camera's audio (listen). Subscription state
  // alone drives listening: setSubscribed(true) delivers + plays the track,
  // setSubscribed(false) stops it. We must NOT call setEnabled before the track
  // is actually subscribed — livekit-client throws "cannot update track settings
  // when not subscribed" (the publication isn't subscribed yet on mount, and
  // setSubscribed resolves asynchronously).
  useEffect(() => {
    const p = camera.participant;
    if (!p) return;
    const pub = p.getTrackPublication(Track.Source.Microphone);
    pub?.setSubscribed(listening);
  }, [listening, camera.participant, camera.audioTrack]);

  // Stop recording / PTT cleanly on unmount or camera change.
  useEffect(() => {
    return () => {
      recorderRef.current?.stop();
      recorderRef.current = null;
      void setMicrophoneEnabled(false);
    };
  }, [camera.id, setMicrophoneEnabled]);

  // Close settings popup on click outside.
  useEffect(() => {
    if (!settingsOpen) return;
    function handleClick(e: MouseEvent) {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [settingsOpen]);

  // Sync fullscreen state with the browser.
  useEffect(() => {
    function onChange() {
      setIsFullscreen(document.fullscreenElement !== null);
    }
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  async function run(action: string, fn: () => Promise<void>) {
    setBusyAction(action);
    try {
      await fn();
    } finally {
      setBusyAction(null);
    }
  }

  async function dispatch(
    label: string,
    sender: () => ReturnType<typeof sendCommand>,
  ) {
    const res = await sender();
    if (!res.ok) onToast(`${label} failed: ${res.error ?? "no ack"}`, true);
  }

  /* --------------------------------------------------------- quality */
  async function setQuality(q: QualityPreset) {
    // Pin the local subscription layer immediately.
    const pub = camera.participant?.getTrackPublication(Track.Source.Camera);
    applySubscriptionQuality(pub, q);
    // Tell the camera to switch its publish mode. We surface the ack's error
    // verbatim (don't route through `dispatch`, which prefixes "Set quality
    // failed: ") — when Max (true 4K) can't start, the camera acks ok:false with
    // "An error occurred while starting 4K streaming." and broadcasts
    // state.quality="1080p", so the segment moves back on its own.
    const res = await sendCommand(camera.id, "setQuality", { quality: q });
    if (!res.ok) onToast(res.error ?? "Set quality failed", true);
  }

  /* --------------------------------------------------------- torch */
  function toggleTorch() {
    void dispatch("Flashlight", () =>
      sendCommand(camera.id, "torch", { on: !camera.torchOn }),
    );
  }

  /* --------------------------------------------------------- lens */
  function switchLens(lens: number) {
    void dispatch("Switch lens", () =>
      sendCommand(camera.id, "switchLens", { lens }),
    );
  }

  /* --------------------------------------------------------- zoom */
  function commitZoom(zoom: number) {
    void dispatch("Zoom", () => sendCommand(camera.id, "setZoom", { zoom }));
  }

  /* --------------------------------------------------------- talk (PTT) */
  async function talkDown() {
    if (talking) return;
    setTalking(true);
    try {
      await setMicrophoneEnabled(true);
      await sendCommand(camera.id, "talkStart");
    } catch {
      setTalking(false);
      onToast("Could not start microphone.", true);
    }
  }

  async function talkUp() {
    if (!talking) return;
    setTalking(false);
    await sendCommand(camera.id, "talkStop");
    await setMicrophoneEnabled(false).catch(() => undefined);
  }

  /* --------------------------------------------------------- fullscreen */
  function toggleFullscreen() {
    if (!isFullscreen) {
      getVideoWrap()?.requestFullscreen().catch(() => undefined);
    } else {
      document.exitFullscreen().catch(() => undefined);
    }
  }

  /* --------------------------------------------------------- snapshot */
  function doSnapshot() {
    const el = getVideoEl();
    if (!el) {
      onToast("No video to capture yet.", true);
      return;
    }
    try {
      snapshotToPng(el, sanitize(camera.name));
      void sendCommand(camera.id, "snapshotHint");
      onToast("Snapshot saved.");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Snapshot failed.", true);
    }
  }

  /* --------------------------------------------------------- record */
  function toggleRecord() {
    const el = getVideoEl();
    if (!recording) {
      if (!el) {
        onToast("No video to record yet.", true);
        return;
      }
      try {
        const rec = new VideoRecorder(sanitize(camera.name));
        rec.start(el);
        recorderRef.current = rec;
        setRecording(true);
        void dispatch("Record", () => sendCommand(camera.id, "startRecord"));
        onToast("Recording started.");
      } catch (err) {
        onToast(err instanceof Error ? err.message : "Record failed.", true);
      }
    } else {
      recorderRef.current?.stop();
      recorderRef.current = null;
      setRecording(false);
      void dispatch("Record", () => sendCommand(camera.id, "stopRecord"));
      onToast("Recording saved (.webm).");
    }
  }

  // On a camera whose sensor can do true 4K, "Max" streams single-layer 4K;
  // elsewhere it serves the same 1080p ladder as the "1080p" preset, so we only
  // advertise 4K where it can actually be produced.
  const supports4K =
    !!caps?.maxResolution &&
    (caps.maxResolution.width >= 3840 || caps.maxResolution.height >= 2160);
  const hasTorch = caps?.torch !== false;
  // Default to 0.5×/1×/2× when the camera hasn't reported lens options yet.
  const lenses = caps?.lenses && caps.lenses.length > 0 ? caps.lenses : [0.5, 1, 2];
  // Default to 10× max zoom so the slider is always usable.
  const maxZoom = Math.max(1, caps?.maxDigitalZoom ?? 10);
  const supportsAudio = caps?.supportsAudio !== false;

  return (
    <>
      {/* YouTube-style bottom overlay — hidden until the video is hovered */}
      <div className="video-controls-overlay">
        <div className="controls-bar">
          {/* LEFT: audio + lens */}
          <div className="controls-group">
            {supportsAudio && (
              <>
                <button
                  className={`ctrl-icon-btn${listening ? " active" : ""}`}
                  onClick={() => setListening((v) => !v)}
                  title={listening ? "Stop listening" : "Listen"}
                >
                  <Icon name={listening ? "volume" : "volumeOff"} size={20} />
                </button>
                <button
                  className={`ctrl-icon-btn${talking ? " active" : ""}`}
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    void talkDown();
                  }}
                  onPointerUp={() => void talkUp()}
                  onPointerCancel={() => void talkUp()}
                  onPointerLeave={() => void talkUp()}
                  title="Hold to talk"
                >
                  <Icon name="mic" size={20} />
                </button>
              </>
            )}

            {lenses.length > 0 && (
              <div className="ctrl-lens-group">
                {lenses.map((lens) => (
                  <button
                    key={lens}
                    className={`ctrl-icon-btn ctrl-lens-chip${camera.lens === lens ? " active" : ""}`}
                    onClick={() => switchLens(lens)}
                    title={`${lens}× lens`}
                  >
                    {lens}×
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* CENTER: digital zoom slider */}
          <div className="ctrl-zoom-inline">
            <span className="ctrl-zoom-val">{zoomLocal.toFixed(1)}×</span>
            <input
              type="range"
              min={1}
              max={maxZoom}
              step={0.1}
              value={zoomLocal}
              onChange={(e) => setZoomLocal(parseFloat(e.target.value))}
              onMouseUp={() => commitZoom(zoomLocal)}
              onTouchEnd={() => commitZoom(zoomLocal)}
              onKeyUp={() => commitZoom(zoomLocal)}
            />
          </div>

          {/* RIGHT: flashlight, snapshot, record, settings */}
          <div className="controls-group">
            {hasTorch && (
              <button
                className={`ctrl-icon-btn${camera.torchOn ? " active" : ""}`}
                onClick={toggleTorch}
                title={camera.torchOn ? "Flashlight on" : "Flashlight off"}
              >
                <Icon name="flashlight" size={20} />
              </button>
            )}

            <button
              className="ctrl-icon-btn"
              onClick={doSnapshot}
              title="Snapshot"
            >
              <Icon name="camera" size={20} />
            </button>

            <button
              className={`ctrl-icon-btn${recording ? " recording" : ""}`}
              onClick={toggleRecord}
              title={recording ? "Stop recording" : "Record"}
            >
              <Icon name={recording ? "stop" : "record"} size={18} />
            </button>

            <button
              className="ctrl-icon-btn"
              onClick={toggleFullscreen}
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              <Icon name={isFullscreen ? "compress" : "expand"} size={18} />
            </button>

            {/* Settings gear — quality + zoom */}
            <div className="ctrl-settings-wrap" ref={settingsRef}>
              <button
                className={`ctrl-icon-btn${settingsOpen ? " active" : ""}`}
                onClick={() => setSettingsOpen((v) => !v)}
                title="Settings"
              >
                <Icon name="settings" size={20} />
              </button>
              {settingsOpen && (
                <div className="ctrl-settings-popup">
                  <div className="ctrl-settings-label">Quality</div>
                  <div className="segmented ctrl-quality-seg">
                    {QUALITY_ORDER.map((q) => (
                      <button
                        key={q}
                        className={
                          selectedPreset(camera.quality) === q ? "active" : ""
                        }
                        onClick={() => void setQuality(q)}
                      >
                        {QUALITY_LABELS[q]}
                      </button>
                    ))}
                  </div>
                  {supports4K && (
                    <div className="ctrl-settings-caption">
                      Max streams true 4K on this camera.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {showRename && (
        <RenameModal
          current={camera.name}
          busy={busyAction === "rename"}
          onClose={() => onShowRenameChange(false)}
          onSubmit={async (name) => {
            await run("rename", async () => {
              try {
                const updated = await renameCamera(camera.id, { name });
                onRenamed(updated.name);
                onShowRenameChange(false);
                onToast("Camera renamed.");
              } catch (err) {
                onToast(
                  err instanceof ApiRequestError
                    ? err.message
                    : "Rename failed.",
                  true,
                );
              }
            });
          }}
        />
      )}

      {showRemove && (
        <Modal title="Remove camera" onClose={() => onShowRemoveChange(false)}>
          {(close) => (
            <>
              <p className="muted">
                Remove <strong>{camera.name}</strong> from this Home? The camera
                will stop appearing here and must be paired again to return.
              </p>
              <div className="modal-actions">
                <button
                  className="btn ghost"
                  onClick={close}
                  disabled={busyAction === "remove"}
                >
                  Cancel
                </button>
                <button
                  className="btn danger"
                  disabled={busyAction === "remove"}
                  onClick={() =>
                    run("remove", async () => {
                      try {
                        await deleteCamera(camera.id);
                        // The departing camera held the HMK — rotate + rekey the
                        // room so it can't decrypt future frames (§6). Best-effort
                        // from the client; an owner can rotate later if this 403s.
                        const homeId = camera.dto?.homeId;
                        if (homeId && room.e2ee.status === "active") {
                          try {
                            const res = await rotateHome(homeId, room.e2ee.epoch);
                            await room.applyHomeKey(res.hmkBase64, res.epoch);
                            await room.broadcastRekey(res.epoch);
                          } catch {
                            onToast(
                              "Camera removed — ask an owner to rotate the encryption key.",
                              true,
                            );
                          }
                        }
                        onRemoved();
                      } catch (err) {
                        onToast(
                          err instanceof ApiRequestError
                            ? err.message
                            : "Remove failed.",
                          true,
                        );
                      }
                    })
                  }
                >
                  {busyAction === "remove" ? (
                    <span className="spinner" />
                  ) : (
                    "Remove"
                  )}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
}

function RenameModal({
  current,
  busy,
  onClose,
  onSubmit,
}: {
  current: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(current);
  return (
    <Modal title="Rename camera" onClose={onClose}>
      {(close) => (
        <>
          <div className="field">
            <label htmlFor="cam-name">Camera name</label>
            <input
              id="cam-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              disabled={busy}
            />
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={busy || !name.trim() || name.trim() === current}
              onClick={() => onSubmit(name.trim())}
            >
              {busy ? <span className="spinner" /> : "Save"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "camera";
}
