/**
 * Popup player for a single stored recording: an hls.js VOD player over the
 * span's [start, end] range, plus a Download (MP4) action.
 *
 * Auth: hls.js attaches the bearer per request via `xhrSetup`, so the same
 * session guard protects the generated playlist AND every segment it lists.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import type { RecordingSpan } from "@foresight/contract";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { epoch, fmtBytes, fmtDay, fmtDuration, fmtRange } from "./recordings";
import { getToken } from "../api/auth";
import { downloadClip, recordingPlaylistUrl } from "../api/client";

interface Props {
  cameraId: string;
  span: RecordingSpan;
  onClose: () => void;
  onToast?: (msg: string, error?: boolean) => void;
}

function SpanPlayer({ cameraId, span }: { cameraId: string; span: RecordingSpan }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setError(null);
    const url = recordingPlaylistUrl(cameraId, {
      mode: "range",
      from: epoch(span.start),
      to: epoch(span.end),
    });
    let hls: Hls | null = null;
    if (Hls.isSupported()) {
      hls = new Hls({
        xhrSetup: (xhr) => {
          const t = getToken();
          if (t) xhr.setRequestHeader("Authorization", `Bearer ${t}`);
        },
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (data.fatal) setError(`Playback error: ${data.details}`);
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => void video.play().catch(() => undefined));
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Native HLS (Safari): the bearer can't ride native requests, so this
      // path relies on a cookie/token scheme to authorize.
      video.src = url;
      void video.play().catch(() => undefined);
    } else {
      setError("HLS playback is not supported in this browser.");
    }
    return () => hls?.destroy();
  }, [cameraId, span.start, span.end]);

  return (
    <div className="rec-video-wrap">
      <video ref={videoRef} className="rec-video" controls playsInline />
      {error && <div className="rec-error">{error}</div>}
    </div>
  );
}

export function RecordingPlayerModal({ cameraId, span, onClose, onToast }: Props) {
  const [downloading, setDownloading] = useState(false);

  const download = useCallback(async () => {
    setDownloading(true);
    try {
      onToast?.("Preparing clip…");
      await downloadClip(cameraId, epoch(span.start), epoch(span.end));
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : "Download failed", true);
    } finally {
      setDownloading(false);
    }
  }, [cameraId, span, onToast]);

  return (
    <Modal title="Recording" onClose={onClose} wide>
      {(close) => (
        <div className="rec-player-pane">
          <div className="rec-item-main">
            <div className="rec-item-time">{fmtDay(span.start)}</div>
            <div className="rec-item-meta">
              {fmtRange(span.start, span.end)}
              <span className="sep">·</span>
              {fmtDuration(span.start, span.end)}
              <span className="sep">·</span>
              {fmtBytes(span.bytes)}
            </div>
          </div>
          <SpanPlayer cameraId={cameraId} span={span} />
          <div className="rec-player-actions">
            <button className="btn ghost sm" onClick={close}>
              Close
            </button>
            <button className="btn sm" onClick={download} disabled={downloading}>
              {downloading ? (
                <span className="spinner" />
              ) : (
                <Icon name="download" size={15} />
              )}
              Download MP4
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
