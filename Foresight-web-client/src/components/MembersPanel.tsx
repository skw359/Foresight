/**
 * Owner-only membership management for a Home: change roles and REMOVE
 * members (revocation). Removing someone drops their access on the server and
 * disconnects their live sessions immediately; for an end-to-end encrypted
 * Home this panel then rotates the Home key right away, because the removed
 * member still knows the current one.
 *
 * The server refuses to demote or remove the last owner (409 last_owner); that
 * message is shown as-is.
 */
import { useCallback, useEffect, useState } from "react";
import type { HomeDTO, HomeMemberDTO, MemberRole } from "@foresight/contract";

import { ApiRequestError, listHomeMembers, removeMember, updateMemberRole } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useE2EE } from "../e2ee/E2EEContext";
import { rotateHome } from "../e2ee/operations";
import type { HomeKeyControls } from "./HomeSecurityPanel";
import { Icon } from "./Icon";

export function MembersPanel({
  home,
  controls,
  onUpdated,
}: {
  home: HomeDTO;
  controls: HomeKeyControls;
  onUpdated: () => void;
}) {
  const { user } = useAuth();
  const e2ee = useE2EE();
  const [members, setMembers] = useState<HomeMemberDTO[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMembers(await listHomeMembers(home.id));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not load members.");
    }
  }, [home.id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** After a removal from an E2EE Home: rotate so the removed key stops working. */
  async function rotateAfterRemoval(): Promise<string> {
    if (home.keyEpoch < 1) return "";
    try {
      await e2ee.ensureIdentity();
      const res = await rotateHome(home.id, home.keyEpoch);
      e2ee.cacheHomeKey(home.id, res.epoch, res.hmkBase64);
      await controls.applyHomeKey(res.hmkBase64, res.epoch);
      return " The encryption key was rotated.";
    } catch {
      return " Rotate the encryption key from the Security tab to finish revoking their access.";
    }
  }

  async function changeRole(m: HomeMemberDTO, role: MemberRole) {
    setBusy(m.userId);
    setError(null);
    setNotice(null);
    try {
      await updateMemberRole(home.id, m.userId, role);
      setNotice(`${m.identifier} is now ${role === "owner" ? "an owner" : "a member"}.`);
      await load();
      onUpdated();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not change the role.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(m: HomeMemberDTO) {
    setBusy(m.userId);
    setError(null);
    setNotice(null);
    try {
      await removeMember(home.id, m.userId);
      const rotated = await rotateAfterRemoval();
      setNotice(`Removed ${m.identifier} and disconnected their devices.${rotated}`);
      setConfirming(null);
      await load();
      onUpdated();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not remove the member.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="field" style={{ marginTop: 22 }}>
      <span>Members</span>
      {error && (
        <p className="error-box" style={{ marginTop: 8 }}>
          {error}
        </p>
      )}
      {notice && (
        <div className="notice-box" style={{ marginTop: 8 }}>
          <Icon name="check" size={16} /> <span>{notice}</span>
        </div>
      )}
      {members === null ? (
        <p className="muted" style={{ fontSize: 13 }}>
          <span className="spinner" /> Loading members…
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
          {members.map((m) => {
            const isSelf = m.userId === user?.id;
            return (
              <li
                key={m.userId}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", flexWrap: "wrap" }}
              >
                <span style={{ flex: "1 1 180px", fontWeight: 560, overflowWrap: "anywhere" }}>
                  {m.identifier}
                  {isSelf && <span className="muted"> (you)</span>}
                </span>
                <select
                  aria-label={`Role for ${m.identifier}`}
                  style={{ width: "auto", flex: "0 0 auto", minWidth: 120 }}
                  value={m.role}
                  disabled={busy !== null}
                  onChange={(e) => void changeRole(m, e.target.value as MemberRole)}
                >
                  <option value="member">Member</option>
                  <option value="owner">Owner</option>
                </select>
                {!isSelf &&
                  (confirming === m.userId ? (
                    <>
                      <button
                        type="button"
                        className="btn danger sm"
                        disabled={busy !== null}
                        onClick={() => void remove(m)}
                      >
                        {busy === m.userId ? <span className="spinner" /> : "Confirm remove"}
                      </button>
                      <button type="button" className="btn sm" onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy !== null}
                      onClick={() => setConfirming(m.userId)}
                    >
                      Remove
                    </button>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
        Members can watch and control cameras and turn recording on. Only owners can remove
        cameras, turn recording off, delete footage, and manage members.
      </p>
    </div>
  );
}
