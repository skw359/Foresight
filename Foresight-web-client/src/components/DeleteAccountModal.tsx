/**
 * Confirm + perform permanent deletion of the signed-in user's own account.
 *
 * This is irreversible. To arm the button the user must type their account
 * identifier exactly (mirrors the type-to-confirm pattern in DeleteHomeModal).
 *
 * What gets deleted is decided server-side (DELETE /me): Homes the user solely
 * owns (cameras + footage) go with the account; Homes they merely belong to (or
 * co-own) survive. The one case the server refuses is when the user is the SOLE
 * owner of a Home that still has other members — wiping it would take data other
 * people rely on. When that happens the backend returns 409 with the blocking
 * Homes in `details`, and this modal switches to a resolve view that lets the
 * user, per Home, transfer ownership to another member or delete the Home. Once
 * all blockers are cleared they can retry the deletion.
 *
 * On success we clear the session (the API client already dropped the token) and
 * bounce to /login.
 */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { AccountDeletionBlocked, HomeMemberDTO } from "@foresight/contract";

import {
  ApiRequestError,
  deleteAccount,
  deleteHome,
  listHomeMembers,
  transferHomeOwnership,
} from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Modal } from "./Modal";
import { Icon } from "./Icon";

type BlockingHome = AccountDeletionBlocked["blockingHomes"][number];

function isBlockedDetails(d: unknown): d is AccountDeletionBlocked {
  return (
    typeof d === "object" &&
    d !== null &&
    Array.isArray((d as AccountDeletionBlocked).blockingHomes)
  );
}

export function DeleteAccountModal({ onClose }: { onClose: () => void }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const identifier = user?.identifier ?? "";
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When set, deletion is blocked until these Homes are resolved.
  const [blocking, setBlocking] = useState<BlockingHome[] | null>(null);

  const canDelete = confirmText.trim() === identifier && identifier !== "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !canDelete) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAccount();
      // Session token already cleared by the client; sync React auth + redirect.
      signOut();
      navigate("/login", { replace: true });
    } catch (err) {
      if (
        err instanceof ApiRequestError &&
        err.status === 409 &&
        isBlockedDetails(err.details)
      ) {
        setBlocking(err.details.blockingHomes);
      } else {
        setError(
          err instanceof ApiRequestError
            ? err.message
            : "Failed to delete account.",
        );
      }
      setBusy(false);
    }
  }

  // One Home cleared (ownership transferred or Home deleted) — drop it from the
  // blocking list. When the list empties, return to the confirm view.
  function clearHome(homeId: string) {
    setBlocking((prev) => {
      const next = (prev ?? []).filter((h) => h.id !== homeId);
      return next.length > 0 ? next : null;
    });
  }

  return (
    <Modal
      title={blocking ? "Resolve shared Homes" : "Delete account"}
      onClose={onClose}
    >
      {(close) => (
        <>
          {error && <div className="error-box">{error}</div>}

          {blocking ? (
            <BlockedView
              homes={blocking}
              onResolved={clearHome}
              onCancel={close}
              onError={setError}
            />
          ) : (
            <>
              <div className="notice-box danger">
                <Icon name="trash" size={16} />
                <span>
                  This permanently deletes your account. Homes you alone own —
                  along with their cameras and recorded footage — are deleted
                  too. This cannot be undone.
                </span>
              </div>
              <form onSubmit={submit}>
                <div className="field">
                  <label htmlFor="confirm-identifier">
                    Type <strong>{identifier}</strong> to confirm
                  </label>
                  <input
                    id="confirm-identifier"
                    type="text"
                    placeholder={identifier}
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    autoFocus
                    autoComplete="off"
                    disabled={busy}
                  />
                </div>
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
                    {busy ? <span className="spinner" /> : "Delete account"}
                  </button>
                </div>
              </form>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

/**
 * Shown when the backend refuses deletion because the user is the sole owner of
 * one or more Homes that still have other members. Lists each blocker with a way
 * to resolve it (transfer ownership to a member, or delete the Home outright).
 */
function BlockedView({
  homes,
  onResolved,
  onCancel,
  onError,
}: {
  homes: BlockingHome[];
  onResolved: (homeId: string) => void;
  onCancel: () => void;
  onError: (msg: string) => void;
}) {
  return (
    <>
      <div className="notice-box danger">
        <Icon name="trash" size={16} />
        <span>
          You are the only owner of {homes.length} Home
          {homes.length === 1 ? "" : "s"} that still {homes.length === 1 ? "has" : "have"}{" "}
          other members. Transfer ownership or delete{" "}
          {homes.length === 1 ? "it" : "them"} to continue, then delete your
          account again.
        </span>
      </div>
      <div className="blocking-homes">
        {homes.map((h) => (
          <BlockingHomeRow
            key={h.id}
            home={h}
            onResolved={() => onResolved(h.id)}
            onError={onError}
          />
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Close
        </button>
      </div>
    </>
  );
}

function BlockingHomeRow({
  home,
  onResolved,
  onError,
}: {
  home: BlockingHome;
  onResolved: () => void;
  onError: (msg: string) => void;
}) {
  const { user } = useAuth();
  const [mode, setMode] = useState<"idle" | "transfer">("idle");
  const [members, setMembers] = useState<HomeMemberDTO[] | null>(null);
  const [targetId, setTargetId] = useState("");
  const [busy, setBusy] = useState(false);

  async function beginTransfer() {
    setBusy(true);
    onError("");
    try {
      const all = await listHomeMembers(home.id);
      // Only other members are valid recipients.
      const others = all.filter((m) => m.userId !== user?.id);
      setMembers(others);
      setTargetId(others[0]?.userId ?? "");
      setMode("transfer");
    } catch (err) {
      onError(
        err instanceof ApiRequestError
          ? err.message
          : "Failed to load Home members.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirmTransfer() {
    if (!targetId) return;
    setBusy(true);
    onError("");
    try {
      await transferHomeOwnership(home.id, { userId: targetId });
      onResolved();
    } catch (err) {
      onError(
        err instanceof ApiRequestError
          ? err.message
          : "Failed to transfer ownership.",
      );
      setBusy(false);
    }
  }

  async function removeHome() {
    setBusy(true);
    onError("");
    try {
      await deleteHome(home.id);
      onResolved();
    } catch (err) {
      onError(
        err instanceof ApiRequestError ? err.message : "Failed to delete Home.",
      );
      setBusy(false);
    }
  }

  return (
    <div className="blocking-home">
      <div className="blocking-home-head">
        <span className="blocking-home-name">{home.name}</span>
      </div>

      {mode === "transfer" ? (
        <div className="field">
          <label htmlFor={`transfer-${home.id}`}>Transfer ownership to</label>
          {members && members.length > 0 ? (
            <>
              <select
                id={`transfer-${home.id}`}
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                disabled={busy}
              >
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.identifier}
                  </option>
                ))}
              </select>
              <div className="blocking-home-actions">
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setMode("idle")}
                  disabled={busy}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={confirmTransfer}
                  disabled={busy || !targetId}
                >
                  {busy ? <span className="spinner" /> : "Transfer"}
                </button>
              </div>
            </>
          ) : (
            <p className="muted" style={{ fontSize: 12.5 }}>
              This Home has no other members to transfer to. Delete it instead.
            </p>
          )}
        </div>
      ) : (
        <div className="blocking-home-actions">
          <button
            type="button"
            className="btn ghost sm"
            onClick={beginTransfer}
            disabled={busy}
          >
            {busy ? <span className="spinner" /> : "Transfer ownership"}
          </button>
          <button
            type="button"
            className="btn danger sm"
            onClick={removeHome}
            disabled={busy}
          >
            Delete Home
          </button>
        </div>
      )}
    </div>
  );
}
