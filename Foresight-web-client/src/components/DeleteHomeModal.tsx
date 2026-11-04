/**
 * Confirm + perform permanent deletion of a Home. This is an owner-only,
 * irreversible action (it also removes every camera and recording in the Home),
 * so the trigger is gated on role in HomePage and the user must type the Home's
 * name to enable the delete button. Mirrors the AddMemberModal pattern: busy/
 * error handling around the shared <Modal>, dismissing via the render-prop
 * `close` so the fade-out animates.
 */
import { useState, type FormEvent } from "react";

import { deleteHome, ApiRequestError } from "../api/client";
import { Modal } from "./Modal";
import { Icon } from "./Icon";

export function DeleteHomeModal({
  homeId,
  homeName,
  onClose,
  onDeleted,
}: {
  homeId: string;
  homeName?: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If we know the Home's name, require an exact match to arm the button;
  // otherwise (name unresolved) fall back to allowing the delete directly.
  const requireMatch = Boolean(homeName);
  const canDelete = !requireMatch || confirmText.trim() === homeName;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !canDelete) return;
    setBusy(true);
    setError(null);
    try {
      await deleteHome(homeId);
      onDeleted();
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : "Failed to delete Home.",
      );
      setBusy(false);
    }
  }

  return (
    <Modal title={homeName ? `Delete ${homeName}` : "Delete Home"} onClose={onClose}>
      {(close) => (
        <>
          {error && <div className="error-box">{error}</div>}
          <div className="notice-box danger">
            <Icon name="trash" size={16} />
            <span>
              This permanently deletes this Home along with all of its cameras
              and recorded footage. This cannot be undone.
            </span>
          </div>
          <form onSubmit={submit}>
            {requireMatch && (
              <div className="field">
                <label htmlFor="confirm-home-name">
                  Type <strong>{homeName}</strong> to confirm
                </label>
                <input
                  id="confirm-home-name"
                  type="text"
                  placeholder={homeName}
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  autoFocus
                  disabled={busy}
                />
              </div>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="btn ghost"
                onClick={close}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn danger"
                disabled={busy || !canDelete}
              >
                {busy ? <span className="spinner" /> : "Delete Home"}
              </button>
            </div>
          </form>
        </>
      )}
    </Modal>
  );
}
