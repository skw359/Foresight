/**
 * Recordings panel for the full-screen camera page: the "Record 24/7" toggle, a
 * compact coverage summary, and a compiled, ordered list of stored recordings
 * (newest first). Each row opens the footage in a player popup (View) or saves
 * it straight to disk as MP4 (Download).
 */
import { useCallback, useEffect, useState } from "react";
import type { RecorderCameraState, RecordingCoverage, RecordingSpan } from "@foresight/contract";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { RecordingPlayerModal } from "./RecordingPlayerModal";
import { epoch, fmtBytes, fmtDay, fmtDuration, fmtRange } from "./recordings";
import {
  getRecordingHealth,
  deleteRecordingSpan,
  downloadClip,
  getRecordingCoverage,
  setRecording,
} from "../api/client";

/**
 * Client-side cap on the coverage fetch. Large recording trees can take the
 * backend minutes to walk; past this we abort and surface the error state
 * (with Retry) instead of sitting on "Loading recordings…" forever.
 */
const COVERAGE_TIMEOUT_MS = 45_000;

/**
 * Load lifecycle of the coverage fetch. The "no footage" / "recording off"
 * copy is only truthful after a request actually succeeded ("ready"); a slow
 * or failed request must never masquerade as an empty library.
 */
type CoverageStatus = "loading" | "error" | "ready";

interface Props {
  cameraId: string;
  /**
   * The camera's persisted 24/7-recording flag, or undefined while the parent
   * hasn't resolved the camera DTO yet. While unknown the toggle is disabled
   * and the panel never claims recording is off; a successful coverage load
   * supplies the authoritative value.
   */
  recordingEnabled: boolean | undefined;
  /**
   * True when the Home is E2EE-activated but the recorder isn't consented — the
   * server 409s the toggle, so gate it here and point at the consent control
   * (§6, §8.3). The owner enables recorder consent in the Security modal.
   */
  recordingGated?: boolean;
  /** Owner: may delete footage and turn recording off (members may only turn it on). */
  canManage?: boolean;
  /** The camera's Home — used to poll the recorder's health for this camera. */
  homeId?: string;
  onToast?: (msg: string, error?: boolean) => void;
}

/** Human text for recorder states that mean "recording is NOT healthy". */
const UNHEALTHY: Partial<Record<RecorderCameraState, string>> = {
  encoder_failing: "The recorder's encoder is failing — footage is not being saved. Check the recorder logs.",
  stalled: "No video is reaching the recorder right now.",
  reacquiring: "Waiting for the camera's video to come back…",
  awaiting_consent: "The recorder can't decrypt this Home yet (recorder consent).",
};

export function RecordingsPanel({
  cameraId,
  recordingEnabled,
  recordingGated = false,
  canManage = false,
  homeId,
  onToast,
}: Props) {
  const [recorderState, setRecorderState] = useState<RecorderCameraState | null | "unreachable">(null);
  // undefined = not yet known (parent DTO and coverage both still pending).
  const [enabled, setEnabled] = useState<boolean | undefined>(recordingEnabled);
  const [toggling, setToggling] = useState(false);
  const [coverage, setCoverage] = useState<RecordingCoverage | null>(null);
  const [status, setStatus] = useState<CoverageStatus>("loading");
  const [selected, setSelected] = useState<RecordingSpan | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmSpan, setConfirmSpan] = useState<RecordingSpan | null>(null);

  // Sync from the parent DTO when it knows; never let "not loaded yet"
  // overwrite a value we already learned.
  useEffect(() => {
    if (recordingEnabled !== undefined) setEnabled(recordingEnabled);
  }, [recordingEnabled]);

  const refreshCoverage = useCallback(
    async (signal?: AbortSignal) => {
      setStatus("loading");
      // Cap the fetch so a hung backend becomes a retryable error, composed
      // with the caller's unmount signal when one is passed.
      const timeout = AbortSignal.timeout(COVERAGE_TIMEOUT_MS);
      try {
        const c = await getRecordingCoverage(
          cameraId,
          undefined,
          signal ? AbortSignal.any([signal, timeout]) : timeout,
        );
        setCoverage(c);
        // The coverage response carries the authoritative persisted flag —
        // self-heals a stale or still-loading parent DTO.
        setEnabled(c.recordingEnabled);
        setStatus("ready");
      } catch {
        if (signal?.aborted) return; // unmounted — nothing to show
        // Timeout or backend failure — drop any stale coverage and let the
        // error state (with Retry) render instead of a false "no footage".
        setCoverage(null);
        setStatus("error");
      }
    },
    [cameraId],
  );

  useEffect(() => {
    const ac = new AbortController();
    void refreshCoverage(ac.signal);
    return () => ac.abort();
  }, [refreshCoverage]);

  // Recorder health (is 24/7 recording actually writing segments?), polled
  // while recording is on.
  useEffect(() => {
    if (!homeId || !enabled) {
      setRecorderState(null);
      return;
    }
    let stop = false;
    const poll = async () => {
      try {
        const h = await getRecordingHealth(homeId);
        if (stop) return;
        setRecorderState(
          h.recorderReachable ? (h.cameras.find((c) => c.cameraId === cameraId)?.state ?? null) : "unreachable",
        );
      } catch {
        /* transient — keep the last state */
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 30_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [homeId, cameraId, enabled]);

  const toggleRecording = useCallback(async () => {
    if (enabled === undefined) return; // state unknown — button is disabled
    setToggling(true);
    try {
      const r = await setRecording(cameraId, !enabled);
      setEnabled(r.recordingEnabled);
      onToast?.(
        r.recordingEnabled
          ? `Recording enabled${r.armed ? " — capturing now" : ""}`
          : "Recording disabled",
      );
      void refreshCoverage();
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : "Failed to toggle recording", true);
    } finally {
      setToggling(false);
    }
  }, [cameraId, enabled, onToast, refreshCoverage]);

  const download = useCallback(
    async (span: RecordingSpan) => {
      const key = span.start;
      setDownloading(key);
      try {
        onToast?.("Preparing clip…");
        await downloadClip(cameraId, epoch(span.start), epoch(span.end));
      } catch (e) {
        onToast?.(e instanceof Error ? e.message : "Download failed", true);
      } finally {
        setDownloading((k) => (k === key ? null : k));
      }
    },
    [cameraId, onToast],
  );

  const remove = useCallback(
    async (span: RecordingSpan) => {
      const key = span.start;
      setDeleting(key);
      try {
        await deleteRecordingSpan(cameraId, epoch(span.start), epoch(span.end));
        onToast?.("Recording deleted");
        await refreshCoverage();
      } catch (e) {
        onToast?.(e instanceof Error ? e.message : "Delete failed", true);
      } finally {
        setDeleting((k) => (k === key ? null : k));
      }
    },
    [cameraId, onToast, refreshCoverage],
  );

  // Newest first — the most recent footage sits at the top of the list.
  const spans = coverage ? [...coverage.spans].reverse() : [];
  const hasFootage = spans.length > 0;

  return (
    <div className="rec-panel">
      <div className="rec-head">
        <div className="rec-title">
          <Icon name="camera" size={16} />
          <span>Recordings</span>
        </div>
        <button
          className={`btn sm ${enabled ? "danger" : ""}`}
          onClick={toggleRecording}
          disabled={
            toggling ||
            enabled === undefined ||
            (recordingGated && enabled === false) ||
            (enabled === true && !canManage)
          }
          title={
            enabled === undefined
              ? "Checking recording status…"
              : recordingGated && !enabled
                ? "Enable recorder consent in Security to record encrypted cameras"
                : enabled
                  ? canManage
                    ? "Stop 24/7 recording"
                    : "Only a Home owner can turn recording off"
                  : "Record this camera 24/7"
          }
        >
          <span className={`rec-dot ${enabled ? "on" : ""}`} />
          {enabled === undefined ? "Checking…" : enabled ? "Recording 24/7" : "Record 24/7"}
        </button>
      </div>
      {enabled && recorderState && recorderState !== "recording" && (recorderState === "unreachable" || UNHEALTHY[recorderState]) && (
        <div className="rec-coverage">
          <span className={recorderState === "encoder_failing" || recorderState === "unreachable" ? "rec-health-bad" : "muted"}>
            <Icon name="shieldAlert" size={13} />{" "}
            {recorderState === "unreachable"
              ? "The recorder isn't reachable — 24/7 recording may not be running."
              : UNHEALTHY[recorderState]}
          </span>
        </div>
      )}
      {recordingGated && enabled === false && (
        <div className="rec-coverage">
          <span className="muted">
            <Icon name="lock" size={13} /> This Home is encrypted. Turn on recorder consent in Security to record.
          </span>
        </div>
      )}

      <div className="rec-coverage">
        {hasFootage ? (
          <>
            <span>
              {spans.length} recording{spans.length === 1 ? "" : "s"}
            </span>
            <span className="sep">·</span>
            <span>{fmtBytes(coverage!.totalBytes)}</span>
          </>
        ) : status === "loading" ? (
          <span className="muted">Loading recordings…</span>
        ) : status === "error" ? (
          <>
            <span className="muted">Couldn't load recordings.</span>
            <button
              className="btn ghost sm"
              onClick={() => void refreshCoverage()}
              title="Try loading recordings again"
            >
              Retry
            </button>
          </>
        ) : (
          <span className="muted">
            {enabled === false
              ? "Recording is off for this camera."
              : enabled
                ? "No footage stored yet. Recording starts when the camera is online."
                : "No footage stored yet."}
          </span>
        )}
      </div>

      {hasFootage && (
        <ul className="rec-list">
          {spans.map((span) => (
            <li key={span.start} className="rec-list-item">
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
              <div className="rec-item-actions">
                <button
                  className="btn ghost sm"
                  onClick={() => setSelected(span)}
                  title="Watch this recording"
                >
                  <Icon name="play" size={15} /> View
                </button>
                <button
                  className="btn ghost sm"
                  onClick={() => download(span)}
                  disabled={downloading === span.start}
                  title="Download this recording as MP4"
                >
                  {downloading === span.start ? (
                    <span className="spinner" />
                  ) : (
                    <Icon name="download" size={15} />
                  )}
                  Download
                </button>
                {canManage && (
                  <button
                    className="btn ghost sm rec-delete-btn"
                    onClick={() => setConfirmSpan(span)}
                    disabled={deleting === span.start}
                    title="Delete this recording"
                    aria-label="Delete this recording"
                  >
                    {deleting === span.start ? (
                      <span className="spinner" />
                    ) : (
                      <Icon name="trash" size={15} />
                    )}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <RecordingPlayerModal
          cameraId={cameraId}
          span={selected}
          onClose={() => setSelected(null)}
          onToast={onToast}
        />
      )}

      {confirmSpan && (
        <Modal title="Delete recording" onClose={() => setConfirmSpan(null)}>
          {(close) => (
            <>
              <p className="muted">
                Permanently delete the recording from{" "}
                <strong>{fmtDay(confirmSpan.start)}</strong>,{" "}
                {fmtRange(confirmSpan.start, confirmSpan.end)} (
                {fmtBytes(confirmSpan.bytes)})? This cannot be undone.
              </p>
              <div className="modal-actions">
                <button className="btn ghost" onClick={close}>
                  Cancel
                </button>
                <button
                  className="btn danger"
                  onClick={() => {
                    const span = confirmSpan;
                    close();
                    void remove(span);
                  }}
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
