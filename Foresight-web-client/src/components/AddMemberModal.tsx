/**
 * Add an existing user to a Home by their account identifier. This is an
 * owner-only action, so the trigger is only rendered for owners (HomePage gates
 * on the viewer's role). Mirrors the CreateHomeModal pattern: a single field,
 * busy/error handling, and the shared <Modal>.
 */
import { useState, type FormEvent } from "react";
import type { HomeDTO, MemberRole } from "@foresight/contract";

import { addMember, ApiRequestError, listHomeMembers } from "../api/client";
import { useE2EE } from "../e2ee/E2EEContext";
import { grantHolders } from "../e2ee/operations";
import { Modal } from "./Modal";
import { Icon } from "./Icon";

export function AddMemberModal({
  homeId,
  homeName,
  keyEpoch = 0,
  onClose,
  onAdded,
}: {
  homeId: string;
  homeName?: string;
  /** The Home's current key epoch — ≥1 means seal the HMK to the new member. */
  keyEpoch?: number;
  onClose: () => void;
  onAdded?: (home: HomeDTO) => void;
}) {
  const e2ee = useE2EE();
  const [identifier, setIdentifier] = useState("");
  const [role, setRole] = useState<MemberRole>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [keyNote, setKeyNote] = useState<string | null>(null);

  /**
   * When the Home is E2EE-activated, immediately seal its key to the new member
   * (owner-only, explicit action per §6/§10.5). If they have no vault yet, the
   * backfill/grant path covers them once they first sign in.
   */
  async function sealToNewMember(who: string) {
    if (keyEpoch < 1) return;
    setKeyNote("Granting encrypted access…");
    try {
      const members = await listHomeMembers(homeId);
      const member = members.find((m) => m.identifier === who);
      if (!member?.publicKey) {
        setKeyNote("They'll get encrypted access when they first sign in.");
        return;
      }
      const { hmkBase64, epoch } = await e2ee.ensureHomeKey(homeId);
      if (!hmkBase64) {
        setKeyNote("Added — but you don't hold this Home's key on this device to grant them yet.");
        return;
      }
      const res = await grantHolders(homeId, hmkBase64, epoch, [
        { holderType: "user", holderId: member.userId, publicKey: member.publicKey, label: member.identifier, firstContact: true },
      ]);
      if (res.conflicts.length > 0) {
        setKeyNote("Security alert: this member's key changed — grant refused. Re-grant from Security if you trust it.");
      } else if (res.newPins.length > 0) {
        setKeyNote("Encrypted access granted — their key is now pinned (trusted) on this device.");
      } else {
        setKeyNote("Encrypted access granted.");
      }
    } catch {
      setKeyNote("Added — encrypted access will be granted on the next reconcile.");
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !identifier.trim()) return;
    setBusy(true);
    setError(null);
    setKeyNote(null);
    try {
      const who = identifier.trim();
      // Only send a role when the owner explicitly chose to make someone an
      // owner. "member" is the server's default for NEW members, and omitting
      // it means re-adding an existing owner can never silently demote them.
      const home = await addMember(homeId, role === "owner" ? { identifier: who, role } : { identifier: who });
      setAdded(who);
      setIdentifier("");
      onAdded?.(home);
      await sealToNewMember(who);
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : "Failed to add member.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={homeName ? `Add member to ${homeName}` : "Add member"}
      onClose={onClose}
    >
      {(close) => (
        <>
          {error && <div className="error-box">{error}</div>}
          {added && (
            <div className="notice-box">
              <Icon name="check" size={16} />
              <span>
                <strong>{added}</strong> can now access this Home.
                {keyNote && (
                  <>
                    {" "}
                    <span className="faint">{keyNote}</span>
                  </>
                )}
              </span>
            </div>
          )}
          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="member-identifier">Username or email</label>
              <input
                id="member-identifier"
                type="text"
                placeholder="Their account username or email"
                value={identifier}
                onChange={(e) => {
                  setIdentifier(e.target.value);
                  if (added) setAdded(null);
                }}
                autoFocus
                disabled={busy}
              />
            </div>
            <div className="field">
              <label htmlFor="member-role">Role</label>
              <select
                id="member-role"
                value={role}
                onChange={(e) => setRole(e.target.value as MemberRole)}
                disabled={busy}
              >
                <option value="member">
                  Member — can view and control cameras
                </option>
                <option value="owner">Owner — can also manage the Home</option>
              </select>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="btn ghost"
                onClick={close}
                disabled={busy}
              >
                {added ? "Done" : "Cancel"}
              </button>
              <button
                type="submit"
                className="btn primary"
                disabled={busy || !identifier.trim()}
              >
                {busy ? <span className="spinner" /> : "Add Member"}
              </button>
            </div>
          </form>
        </>
      )}
    </Modal>
  );
}
