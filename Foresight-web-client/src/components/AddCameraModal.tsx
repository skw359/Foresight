/**
 * Add Camera flow: POST /homes/:id/cameras/pair → render the returned
 * PairingTicket as a QR code (encoding the ticket JSON, which is exactly what a
 * camera client scans). Shows a live expiry countdown and allows regenerate.
 *
 * The same ticket JSON can be copied and pasted into the /dev/camera harness to
 * pair an in-browser test camera.
 */
import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { PairingTicket } from "@foresight/contract";

import { ApiRequestError, pairCamera } from "../api/client";
import { Modal } from "./Modal";

export function AddCameraModal({
  homeId,
  keyEpoch = 0,
  onClose,
}: {
  homeId: string;
  /** The Home's key epoch — ≥1 shows the "grant encrypted access after pairing" note. */
  keyEpoch?: number;
  onClose: () => void;
}) {
  const [ticket, setTicket] = useState<PairingTicket | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const generate = useCallback(async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const t = await pairCamera(homeId);
      setTicket(t);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.message
          : "Failed to create a pairing code.",
      );
    } finally {
      setBusy(false);
    }
  }, [homeId]);

  useEffect(() => {
    generate();
  }, [generate]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const ticketJson = ticket ? JSON.stringify(ticket) : "";
  const expiresMs = ticket ? new Date(ticket.expiresAt).getTime() - now : 0;
  const expired = ticket !== null && expiresMs <= 0;

  async function copyToken() {
    if (!ticketJson) return;
    try {
      await navigator.clipboard.writeText(ticketJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Copy failed — select and copy the code manually.");
    }
  }

  return (
    <Modal title="Add a Camera" onClose={onClose} wide>
      {(close) => (
        <>
          {error && <div className="error-box">{error}</div>}

          <p className="muted" style={{ marginTop: 0, fontSize: 13.5 }}>
            Scan this QR code with the Foresight camera app on the iPhone you
            want to use. The code expires shortly for security.
          </p>

          <div className="qr-box">
            {busy && !ticket ? (
              <div className="center-load">
                <span className="spinner" /> Generating code…
              </div>
            ) : ticket ? (
              <>
                <div className="qr-frame" style={{ opacity: expired ? 0.4 : 1 }}>
                  <QRCodeSVG value={ticketJson} size={232} level="M" />
                </div>
                <div className="qr-meta">
                  <div>
                    Home <code>{ticket.homeId}</code>
                  </div>
                  <div title="The camera will trust this server permanently — check it is yours.">
                    Server <code>{ticket.serverUrl}</code>
                  </div>
                  <div className={`qr-expiry ${expired ? "expired" : ""}`}>
                    {expired
                      ? "Expired"
                      : `Expires in ${formatCountdown(expiresMs)}`}
                  </div>
                </div>
              </>
            ) : null}
          </div>

          <div className="notice-box" style={{ marginTop: 18 }}>
            No iPhone handy? Copy this code and paste it into the{" "}
            <strong>Dev Camera</strong> harness (open <code>/dev/camera</code> in
            a second tab) to pair a webcam-based test camera.
          </div>

          {keyEpoch >= 1 && (
            <div className="notice-box" style={{ marginTop: 12 }}>
              This Home is encrypted. After the camera finishes pairing, an owner grants it access from{" "}
              <strong>Security</strong> so it can publish encrypted video.
            </div>
          )}

          <div className="btn-row" style={{ justifyContent: "space-between" }}>
            <button
              className="btn"
              onClick={copyToken}
              disabled={!ticketJson}
              title="Copy the pairing ticket JSON"
            >
              {copied ? "Copied!" : "Copy pairing code"}
            </button>
            <div className="btn-row">
              <button className="btn" onClick={generate} disabled={busy}>
                {busy ? <span className="spinner" /> : "Regenerate"}
              </button>
              <button className="btn primary" onClick={close}>
                Done
              </button>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
