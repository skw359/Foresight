/**
 * Confirm + perform turning a Home's end-to-end encryption off (owner-only,
 * from Settings → Security). The server drops every sealed key copy and tells
 * the room, so cameras and viewers reconnect plaintext on their own; the caller
 * reconnects this session in `onDisabled`. Mirrors DeleteHomeModal: busy/error
 * handling around the shared <Modal>, dismissing via the render-prop `close`.
 */
import { useState } from "react";

import { disableHomeKey, ApiRequestError } from "../api/client";
import { Modal } from "./Modal";
import { Icon } from "./Icon";

export function DisableEncryptionModal({
  homeId,
  recorderConsented,
  onClose,
  onDisabled,
}: {
  homeId: string;
  recorderConsented: boolean;
  onClose: () => void;
  onDisabled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disable() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await disableHomeKey(homeId);
      onDisabled();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to turn off encryption.");
      setBusy(false);
    }
  }

  return (
    <Modal title="Turn off encryption?" onClose={onClose}>
      {(close) => (
        <>
          {error && <div className="error-box">{error}</div>}
          <div className="notice-box danger">
            <Icon name="shieldAlert" size={16} />
            <span>
              The server and network will be able to see this Home's camera video again. Cameras and viewers
              switch over by themselves after a brief interruption.
            </span>
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            Cameras running an older app version keep sending encrypted video until they're restarted.
            {recorderConsented && " Recording consent is cleared too: if you turn encryption back on, allow the recorder again."}
          </p>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn danger" onClick={() => void disable()} disabled={busy}>
              {busy ? <span className="spinner" /> : "Turn off encryption"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
