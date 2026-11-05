/**
 * App-level "General" settings: everything that follows the signed-in user or
 * this device rather than any single Home. Rendered as the "General" tab of
 * the Settings page.
 *
 * Server settings (pairing URL, registration policy) are SERVER-WIDE, so only
 * the server administrator can change them; everyone else sees them read-only.
 * The pairing URL is embedded into QR tickets and must be reachable by the
 * phones being paired, so on a LAN it has to be this machine's IP, not
 * "localhost"; blank clears the override and lets the server auto-detect.
 */
import { useEffect, useState, type FormEvent } from "react";

import {
  ApiRequestError,
  changePassword,
  getMyKeys,
  getServerSettings,
  logoutEverywhere,
  updateProfile,
  updateServerSettings,
} from "../api/client";
import { rewrapVault } from "../crypto/identity";
import { useTheme } from "../theme/ThemeContext";
import { useAuth } from "../auth/AuthContext";
import { useE2EE } from "../e2ee/E2EEContext";
import { DeleteAccountModal } from "./DeleteAccountModal";

export function GeneralSettings() {
  const { isDark, setTheme } = useTheme();
  const { user, updateUser } = useAuth();
  const { keepUnlocked, setKeepUnlocked } = useE2EE();

  const [firstName, setFirstName] = useState(user?.firstName ?? "");
  const [nameBusy, setNameBusy] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const [url, setUrl] = useState("");
  const [detected, setDetected] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Server-wide policy (admin only).
  const [editable, setEditable] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [registrationLocked, setRegistrationLocked] = useState(false);

  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [signOutDone, setSignOutDone] = useState(false);

  const [showDeleteAccount, setShowDeleteAccount] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const s = await getServerSettings(ctrl.signal);
        setUrl(s.pairingServerUrl ?? "");
        setDetected(s.detectedServerUrl);
        setEditable(s.editable === true);
        setRegistrationOpen(s.registrationOpen === true);
        setRegistrationLocked(s.registrationLocked === true);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setError(
          err instanceof ApiRequestError ? err.message : "Failed to load settings.",
        );
      } finally {
        if (!ctrl.signal.aborted) setLoaded(true);
      }
    })();
    return () => ctrl.abort();
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const trimmed = url.trim();
      const s = await updateServerSettings({
        pairingServerUrl: trimmed === "" ? null : trimmed,
        ...(registrationLocked ? {} : { registrationOpen }),
      });
      setUrl(s.pairingServerUrl ?? "");
      setDetected(s.detectedServerUrl);
      setRegistrationOpen(s.registrationOpen === true);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : "Failed to save settings.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    if (pwBusy) return;
    setPwError(null);
    setPwDone(false);
    if (!pwNew) {
      setPwError("Enter a new password.");
      return;
    }
    if (pwNew !== pwConfirm) {
      setPwError("The new passwords don't match.");
      return;
    }
    setPwBusy(true);
    try {
      // The E2EE vault is wrapped under the login password: re-wrap the SAME
      // key under the new password so encrypted Homes keep working.
      const { keyVault } = await getMyKeys();
      let rewrapped = undefined;
      if (keyVault) {
        try {
          rewrapped = await rewrapVault(pwCurrent, pwNew, keyVault);
        } catch {
          setPwError("Current password is incorrect.");
          return;
        }
      }
      await changePassword({ currentPassword: pwCurrent, newPassword: pwNew, keyVault: rewrapped });
      setPwCurrent("");
      setPwNew("");
      setPwConfirm("");
      setPwDone(true);
    } catch (err) {
      setPwError(err instanceof ApiRequestError ? err.message : "Could not change your password.");
    } finally {
      setPwBusy(false);
    }
  }

  async function signOutEverywhere() {
    if (signOutBusy) return;
    setSignOutBusy(true);
    setSignOutDone(false);
    try {
      await logoutEverywhere();
      setSignOutDone(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not sign out other devices.");
    } finally {
      setSignOutBusy(false);
    }
  }

  async function saveName(e: FormEvent) {
    e.preventDefault();
    if (nameBusy) return;
    setNameBusy(true);
    setNameError(null);
    setNameSaved(false);
    try {
      const trimmed = firstName.trim();
      const updated = await updateProfile({ firstName: trimmed === "" ? null : trimmed });
      updateUser(updated);
      setFirstName(updated.firstName ?? "");
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 1800);
    } catch (err) {
      setNameError(
        err instanceof ApiRequestError ? err.message : "Failed to save your name.",
      );
    } finally {
      setNameBusy(false);
    }
  }

  const effective = url.trim() || detected;

  return (
    <>
      {error && <div className="error-box">{error}</div>}

      <div className="field">
        <span>Appearance</span>
        <div className="segmented block" role="group" aria-label="Appearance">
          <button
            type="button"
            className={!isDark ? "active" : ""}
            aria-pressed={!isDark}
            onClick={() => setTheme("light")}
          >
            Light
          </button>
          <button
            type="button"
            className={isDark ? "active" : ""}
            aria-pressed={isDark}
            onClick={() => setTheme("dark")}
          >
            Dark
          </button>
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
          Switch the dashboard between light and dark. Saved on this device.
        </p>
      </div>

      {!loaded ? (
        <div className="center-load">
          <span className="spinner" /> Loading settings…
        </div>
      ) : (
        <form onSubmit={save}>
          {!editable && (
            <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
              Server settings apply to every Home on this server, so only the server
              administrator can change them.
            </p>
          )}
          <div className="field">
            <label htmlFor="pairing-url">Pairing server URL</label>
            <input
              id="pairing-url"
              type="text"
              placeholder={detected || "http://192.168.1.20:3199"}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy || !editable}
            />
            <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
              The address phones use to reach this server when scanning a QR
              pairing code. Use this machine's LAN IP (e.g.{" "}
              <code>http://192.168.1.20:3199</code>) — <code>localhost</code>{" "}
              only works on this computer.
            </p>
            <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
              Leave blank to auto-detect. New pairing codes will use{" "}
              <code>{effective || "—"}</code>.
            </p>
          </div>
          <div className="field">
            <span>New accounts</span>
            <label className="ctrl-toggle-row" style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                checked={registrationOpen}
                onChange={(e) => setRegistrationOpen(e.target.checked)}
                disabled={busy || !editable || registrationLocked}
              />
              <span className="ctrl-toggle-text">
                Allow new accounts to register
                <span className="ctrl-toggle-caption">
                  {registrationLocked
                    ? "Pinned by ALLOW_REGISTRATION in the server's environment."
                    : "Turn on while someone you're adding creates their account, then turn it off again. Anyone who can reach this server can sign up while it's on."}
                </span>
              </span>
            </label>
          </div>
          {editable && (
            <div className="btn-row">
              <button type="submit" className="btn primary" disabled={busy}>
                {busy ? <span className="spinner" /> : saved ? "Saved!" : "Save"}
              </button>
            </div>
          )}
        </form>
      )}

      <div className="field" style={{ marginTop: 22 }}>
        <span>Camera unlock</span>
        <label className="ctrl-toggle-row" style={{ marginTop: 8 }}>
          <input
            type="checkbox"
            checked={keepUnlocked}
            onChange={(e) => setKeepUnlocked(e.target.checked)}
          />
          <span className="ctrl-toggle-text">
            Keep me unlocked on this device
            <span className="ctrl-toggle-caption">
              Stores your camera encryption keys on this device, so feeds open without
              re-entering your password after a reload. Turning this off removes the stored
              keys immediately. Leave off on shared computers.
            </span>
          </span>
        </label>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
          Encryption for a specific Home (activation, access grants, key rotation) lives in
          that Home's Settings → Security tab.
        </p>
      </div>

      {user ? (
        <>
          <form onSubmit={saveName}>
            <div className="field" style={{ marginTop: 22 }}>
              <label htmlFor="first-name">First name</label>
              <input
                id="first-name"
                type="text"
                autoComplete="given-name"
                placeholder="Add your first name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                disabled={nameBusy}
              />
              {nameError && (
                <p className="error-box" style={{ marginTop: 8 }}>
                  {nameError}
                </p>
              )}
              <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
                Used to greet you on your Homes page. Leave blank to remove it.
              </p>
            </div>
            <div className="btn-row">
              <button type="submit" className="btn primary" disabled={nameBusy}>
                {nameBusy ? (
                  <span className="spinner" />
                ) : nameSaved ? (
                  "Saved!"
                ) : (
                  "Save name"
                )}
              </button>
            </div>
          </form>

          <form onSubmit={submitPassword}>
            <div className="field" style={{ marginTop: 22 }}>
              <span>Password</span>
              <input
                type="password"
                autoComplete="current-password"
                placeholder="Current password"
                aria-label="Current password"
                value={pwCurrent}
                onChange={(e) => setPwCurrent(e.target.value)}
                disabled={pwBusy}
                style={{ marginTop: 8 }}
              />
              <input
                type="password"
                autoComplete="new-password"
                placeholder="New password"
                aria-label="New password"
                value={pwNew}
                onChange={(e) => setPwNew(e.target.value)}
                disabled={pwBusy}
                style={{ marginTop: 8 }}
              />
              <input
                type="password"
                autoComplete="new-password"
                placeholder="Confirm new password"
                aria-label="Confirm new password"
                value={pwConfirm}
                onChange={(e) => setPwConfirm(e.target.value)}
                disabled={pwBusy}
                style={{ marginTop: 8 }}
              />
              {pwError && (
                <p className="error-box" style={{ marginTop: 8 }}>
                  {pwError}
                </p>
              )}
              <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
                {pwDone
                  ? "Password changed. Your other devices have been signed out."
                  : "Changing your password signs out your other devices and re-protects your camera encryption keys with the new password."}
              </p>
            </div>
            <div className="btn-row">
              <button type="submit" className="btn primary" disabled={pwBusy || !pwCurrent}>
                {pwBusy ? <span className="spinner" /> : "Change password"}
              </button>
              <button type="button" className="btn" onClick={() => void signOutEverywhere()} disabled={signOutBusy}>
                {signOutBusy ? <span className="spinner" /> : signOutDone ? "Signed out elsewhere" : "Sign out other devices"}
              </button>
            </div>
          </form>

          <div className="danger-zone">
            <div className="field">
              <span>Danger zone</span>
              <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
                Permanently delete your account. Homes you alone own — and
                their cameras and recorded footage — are deleted with it. This
                cannot be undone.
              </p>
            </div>
            <button
              type="button"
              className="btn danger"
              onClick={() => setShowDeleteAccount(true)}
            >
              Delete account
            </button>
          </div>
        </>
      ) : (
        <p className="faint">Sign in to manage your account.</p>
      )}

      {showDeleteAccount && (
        <DeleteAccountModal onClose={() => setShowDeleteAccount(false)} />
      )}
    </>
  );
}
