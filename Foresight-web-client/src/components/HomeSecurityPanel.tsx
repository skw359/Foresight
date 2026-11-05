/**
 * Owner-only End-to-End Encryption control surface for a Home (shared/E2EE.md
 * §6, §7.2, §10.5), rendered as the Security tab of the Home's Settings page.
 * Handles, all as EXPLICIT owner actions:
 *   - Activation (epoch 0→1): eligibility precheck (every camera needs a pubkey),
 *     the stale-viewer warning, generate + seal + POST /key/init, then reconnect.
 *   - Pending first-contact grants (new members / newly-paired cameras).
 *   - Recorder consent toggle with the pubkey FINGERPRINT for out-of-band checks;
 *     disable rotates the HMK (revoke forces a rotate).
 *   - TOFU pin-change alerts + an explicit re-grant path (§10.5).
 *   - Turning E2EE off (epoch → 0) behind a confirmation, then reconnect.
 */
import { useCallback, useEffect, useState } from "react";
import type { CameraDTO, HomeDTO, HomeMemberDTO, KeyHolderType, PendingKeyHolder } from "@foresight/contract";

import { ApiRequestError, getPendingKeyHolders, listHomeMembers } from "../api/client";
import { useE2EE } from "../e2ee/E2EEContext";
import {
  activateHome,
  checkActivationEligibility,
  disableRecorderConsentAndRotate,
  enableRecorderConsent,
  fetchRecorderIdentity,
  grantHolders,
  reissueKey,
  rotateHome,
  type PinConflict,
} from "../e2ee/operations";
import { pubkeyFingerprint } from "../crypto/homeKey";
import { DisableEncryptionModal } from "./DisableEncryptionModal";
import { Icon } from "./Icon";

/** The subset of the room API this panel drives after a key change. */
export interface HomeKeyControls {
  reconnect: () => void;
  applyHomeKey: (hmkBase64: string, epoch: number) => Promise<void>;
  broadcastRekey: (epoch: number) => Promise<void>;
}

export function HomeSecurityPanel({
  home,
  cameras,
  controls,
  onUpdated,
}: {
  home: HomeDTO;
  cameras: CameraDTO[];
  controls: HomeKeyControls;
  onUpdated: () => void;
}) {
  const e2ee = useE2EE();
  const activated = home.keyEpoch >= 1;

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<PinConflict[]>([]);
  // Holders whose keys this device pinned for the first time during this session
  // (TOFU §10.5 — make the trust decision visible instead of silent).
  const [newPins, setNewPins] = useState<string[]>([]);

  // Activation precheck.
  const [offenders, setOffenders] = useState<string[] | null>(null);
  // Pending first-contact grants (activated homes).
  const [pending, setPending] = useState<PendingKeyHolder[] | null>(null);
  // Members + the FULL pending id set (`pending` above is firstContact-only) —
  // the issued-keys repair list is (members ∪ cameras with a key) − pending.
  const [members, setMembers] = useState<HomeMemberDTO[] | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string> | null>(null);
  // Recorder consent.
  const [recorderPk, setRecorderPk] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  // Turn-off confirmation.
  const [showDisable, setShowDisable] = useState(false);

  const cameraName = useCallback(
    (id: string) => cameras.find((c) => c.id === id)?.name ?? id.slice(0, 8),
    [cameras],
  );

  /* ---- load state on open ---- */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!activated) {
          const elig = await checkActivationEligibility(
            home.id,
            cameras.map((c) => c.id),
          );
          if (alive) setOffenders(elig.offendingCameraIds);
          return;
        }
        const [{ pending: p }, recorder, mems] = await Promise.all([
          getPendingKeyHolders(home.id),
          fetchRecorderIdentity(),
          listHomeMembers(home.id),
        ]);
        if (!alive) return;
        setPending(p.filter((h) => h.firstContact));
        setPendingIds(new Set(p.map((h) => `${h.holderType}:${h.holderId}`)));
        setMembers(mems);
        setRecorderPk(recorder);
        if (recorder) setFingerprint(await pubkeyFingerprint(recorder));
      } catch (err) {
        if (alive) setError(err instanceof ApiRequestError ? err.message : "Failed to load encryption state.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [home.id, activated, cameras]);

  /** Refetch pending and update BOTH the firstContact grant list and the full id set. */
  async function refreshPending() {
    const { pending: p } = await getPendingKeyHolders(home.id);
    setPending(p.filter((h) => h.firstContact));
    setPendingIds(new Set(p.map((h) => `${h.holderType}:${h.holderId}`)));
  }

  function reportConflicts(list: PinConflict[]) {
    if (list.length > 0) {
      setConflicts((prev) => [...prev, ...list.filter((c) => !prev.some((p) => p.holderId === c.holderId))]);
    }
  }

  function reportNewPins(labels: string[]) {
    if (labels.length > 0) {
      setNewPins((prev) => [...prev, ...labels.filter((l) => !prev.includes(l))]);
    }
  }

  /* ---- activation ---- */
  async function activate() {
    setBusy("activate");
    setError(null);
    try {
      await e2ee.ensureIdentity(); // unlock if cold-loaded
      const elig = await checkActivationEligibility(
        home.id,
        cameras.map((c) => c.id),
      );
      if (elig.offendingCameraIds.length > 0) {
        setOffenders(elig.offendingCameraIds);
        setError("Some cameras still need to register their encryption key. Update those camera apps first.");
        return;
      }
      const res = await activateHome(home.id, elig.eligible);
      e2ee.cacheHomeKey(home.id, res.epoch, res.hmkBase64);
      reportConflicts(res.conflicts);
      reportNewPins(res.newPins);
      controls.reconnect(); // plaintext → E2EE room
      onUpdated();
      setNotice(`End-to-end encryption is on (epoch ${res.epoch}).`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : err instanceof Error ? err.message : "Activation failed.");
    } finally {
      setBusy(null);
    }
  }

  /* ---- grant first-contact holders ---- */
  async function grant(holders: PendingKeyHolder[], allowRepin = false) {
    setBusy("grant");
    setError(null);
    try {
      const { hmkBase64, epoch } = await e2ee.ensureHomeKey(home.id);
      if (!hmkBase64) {
        setError("You don't hold this Home's key on this device yet.");
        return;
      }
      const res = await grantHolders(home.id, hmkBase64, epoch, holders, allowRepin);
      reportConflicts(res.conflicts);
      reportNewPins(res.newPins);
      if (allowRepin) setConflicts((prev) => prev.filter((c) => !holders.some((h) => h.holderId === c.holderId)));
      await refreshPending();
      onUpdated();
      if (res.sealed > 0) setNotice(`Granted access to ${res.sealed} holder(s).`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Grant failed.");
    } finally {
      setBusy(null);
    }
  }

  /* ---- recorder consent ---- */
  async function toggleRecorder(enable: boolean) {
    setBusy("recorder");
    setError(null);
    try {
      if (enable) {
        if (!recorderPk) {
          setError("No recorder is registered on this server.");
          return;
        }
        const { hmkBase64 } = await e2ee.ensureHomeKey(home.id);
        if (!hmkBase64) {
          setError("You don't hold this Home's key on this device yet.");
          return;
        }
        await enableRecorderConsent(home.id, hmkBase64, recorderPk);
        onUpdated();
        setNotice("Recording consent enabled — the recorder can now decrypt this Home's feeds.");
      } else {
        // Revoke forces a rotate (§6): new epoch sealed only to users + cameras.
        const res = await disableRecorderConsentAndRotate(home.id);
        e2ee.cacheHomeKey(home.id, res.epoch, res.hmkBase64);
        reportConflicts(res.conflicts);
        reportNewPins(res.newPins);
        await controls.applyHomeKey(res.hmkBase64, res.epoch);
        await controls.broadcastRekey(res.epoch);
        onUpdated();
        setNotice("Recording consent revoked and the key rotated. Footage recorded while consented remains on the server.");
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not change recorder consent.");
    } finally {
      setBusy(null);
    }
  }

  /* ---- manual rotate (defensive: available after a pin change / suspected leak) ---- */
  async function manualRotate() {
    setBusy("rotate");
    setError(null);
    try {
      await e2ee.ensureIdentity();
      const res = await rotateHome(home.id, home.keyEpoch);
      e2ee.cacheHomeKey(home.id, res.epoch, res.hmkBase64);
      reportConflicts(res.conflicts);
      reportNewPins(res.newPins);
      await controls.applyHomeKey(res.hmkBase64, res.epoch);
      await controls.broadcastRekey(res.epoch);
      onUpdated();
      setNotice(`Key rotated to epoch ${res.epoch}.`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Rotate failed.");
    } finally {
      setBusy(null);
    }
  }

  /* ---- turned off (the modal made the call; the server already told the room) ---- */
  function onDisabled() {
    setShowDisable(false);
    setError(null);
    controls.reconnect(); // E2EE → plaintext room
    onUpdated();
    setNotice("End-to-end encryption is off for this Home.");
  }

  /* ---- reissue a holder's sealed copy (repair for a poisoned/undecryptable row) ---- */
  async function reissue(holderType: KeyHolderType, holderId: string, label: string) {
    setBusy("reissue");
    setError(null);
    try {
      const { hmkBase64 } = await e2ee.ensureHomeKey(home.id);
      if (!hmkBase64) {
        setError("You don't hold this Home's key on this device yet.");
        return;
      }
      const res = await reissueKey(home.id, hmkBase64, holderType, holderId);
      reportConflicts(res.conflicts);
      reportNewPins(res.newPins);
      await refreshPending();
      onUpdated();
      if (res.sealed > 0) setNotice(`Re-issued the key for ${label}.`);
      else if (res.conflicts.length === 0) setError(`Could not re-issue for ${label} — it has no encryption key registered.`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Re-issue failed.");
    } finally {
      setBusy(null);
    }
  }

  // Holders that HOLD a current-epoch sealed copy (i.e. not pending) — the
  // reissue candidates. The recorder is deliberately absent: its repair path is
  // the consent toggle below.
  const issued: { holderType: KeyHolderType; holderId: string; label: string }[] =
    members === null || pendingIds === null
      ? []
      : [
          ...members
            .filter((m) => m.publicKey && !pendingIds.has(`user:${m.userId}`))
            .map((m) => ({ holderType: "user" as const, holderId: m.userId, label: m.identifier })),
          ...cameras
            .filter((c) => !pendingIds.has(`camera:${c.id}`))
            .map((c) => ({ holderType: "camera" as const, holderId: c.id, label: c.name })),
        ];

  return (
    <>
      {error && <div className="error-box">{error}</div>}
      {notice && (
        <div className="notice-box">
          <Icon name="check" size={16} /> <span>{notice}</span>
        </div>
      )}

      {activated && home.keyRotationRequired && (
        <div className="error-box" role="alert" style={{ display: "block" }}>
          <strong>
            <Icon name="shieldAlert" size={15} /> Rotate this Home's key.
          </strong>
          <p style={{ margin: "6px 0" }}>
            A member, camera or account that held this Home's encryption key was removed. Until the
            key is rotated, that copy could still decrypt new video.
          </p>
          <button className="btn danger sm" disabled={busy !== null} onClick={() => void manualRotate()}>
            {busy === "rotate" ? <span className="spinner" /> : "Rotate now"}
          </button>
        </div>
      )}

      {newPins.length > 0 && (
        <div className="notice-box" style={{ display: "block" }}>
          <strong>
            <Icon name="shield" size={15} /> First time trusting {newPins.length} key holder(s) on this device.
          </strong>
          <p style={{ margin: "6px 0 0" }}>
            This device pinned the encryption keys of {newPins.join(", ")} for the first time. If any of these keys
            ever changes, you'll see a security alert here before anything is re-sealed to it.
          </p>
        </div>
      )}

      {conflicts.length > 0 && (
        <div className="error-box" role="alert" style={{ display: "block" }}>
          <strong>
            <Icon name="shieldAlert" size={15} /> Security alert: a holder's key changed.
          </strong>
          <p style={{ margin: "6px 0" }}>
            The server presented a different public key than we previously pinned for{" "}
            {conflicts.map((c) => c.label).join(", ")}. Sealing was refused. Only re-grant if you trust that these
            devices legitimately re-keyed (e.g. after a password reset).
          </p>
          <button
            className="btn danger sm"
            disabled={busy !== null}
            onClick={() =>
              void grant(
                conflicts.map((c) => ({
                  holderType: c.holderType,
                  holderId: c.holderId,
                  publicKey: c.publicKey,
                  label: c.label,
                  firstContact: false,
                })),
                true,
              )
            }
          >
            Re-grant access (re-pin new keys)
          </button>
        </div>
      )}

      {!activated ? (
        /* ------------------------------ activation ------------------------------ */
        <div>
          <p className="muted" style={{ marginTop: 0 }}>
            <Icon name="lock" size={15} /> End-to-end encryption makes camera video readable only on your authorized
            devices — the server and network see ciphertext. It is <strong>off</strong> for this Home.
          </p>
          <div className="notice-box" style={{ display: "block" }}>
            Before turning it on: <strong>every viewing device (web and iOS) must be on a current app version.</strong>{" "}
            Older apps will show black video for this Home until they update.
          </div>

          {offenders === null ? (
            <div className="center-load">
              <span className="spinner" /> Checking cameras…
            </div>
          ) : offenders.length > 0 ? (
            <div className="error-box" style={{ display: "block" }}>
              <strong>Waiting for camera app updates.</strong>
              <p style={{ margin: "6px 0 0" }}>
                These cameras haven't registered an encryption key yet — activation is blocked until they do:
              </p>
              <ul style={{ margin: "6px 0 0 18px" }}>
                {offenders.map((id) => (
                  <li key={id}>{cameraName(id)}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="faint">All {cameras.length} camera(s) are ready. You can activate encryption for this Home.</p>
          )}

          <div className="btn-row" style={{ marginTop: 18 }}>
            <button
              className="btn primary"
              disabled={busy !== null || offenders === null || (offenders?.length ?? 0) > 0}
              onClick={() => void activate()}
            >
              {busy === "activate" ? (
                <>
                  <span className="spinner" /> Activating…
                </>
              ) : (
                <>
                  <Icon name="shield" size={15} /> Turn on encryption
                </>
              )}
            </button>
          </div>
        </div>
      ) : (
        /* ------------------------------ activated ------------------------------ */
        <div>
          <p className="e2ee-status">
            <Icon name="shield" size={16} className="icon e2ee-shield" /> Encrypted
            <span className="info-tip">
              <button type="button" className="info-tip-trigger" aria-label="What is encrypted?" aria-describedby="e2ee-scope-tip">
                <Icon name="help" size={15} />
              </button>
              <span role="tooltip" id="e2ee-scope-tip" className="info-tip-bubble">
                The live camera feed is end-to-end encrypted. The control channel and any stored recordings are not.
              </span>
            </span>
          </p>

          {/* pending first-contact grants */}
          <h3 style={{ marginBottom: 6 }}>Access grants</h3>
          {pending === null ? (
            <div className="center-load">
              <span className="spinner" /> Loading…
            </div>
          ) : pending.length === 0 ? (
            <p className="faint">Everyone with a key vault already has access.</p>
          ) : (
            <>
              <p className="faint" style={{ marginTop: 0 }}>
                These holders are waiting for access. Granting seals this Home's key to them (owner-only).
              </p>
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {pending.map((h) => (
                  <li
                    key={`${h.holderType}:${h.holderId}`}
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0" }}
                  >
                    <span>
                      <Icon name={h.holderType === "camera" ? "camera" : "eye"} size={14} />{" "}
                      {h.holderType === "camera" ? cameraName(h.holderId) : h.label}{" "}
                      <span className="faint">({h.holderType})</span>
                    </span>
                    <button className="btn sm" disabled={busy !== null} onClick={() => void grant([h])}>
                      Grant access
                    </button>
                  </li>
                ))}
              </ul>
              <button className="btn sm" disabled={busy !== null} onClick={() => void grant(pending)}>
                {busy === "grant" ? <span className="spinner" /> : "Grant all"}
              </button>
            </>
          )}

          {/* issued-key repair (poisoned/undecryptable copy) */}
          <h3 style={{ marginTop: 20, marginBottom: 6 }}>Issued keys</h3>
          <p className="faint" style={{ marginTop: 0 }}>
            If a member or camera stays at "awaiting key" even though access was granted, its stored copy may be
            corrupt. Re-issuing drops that copy and seals a fresh one (owner-only).
          </p>
          {members === null || pendingIds === null ? (
            <div className="center-load">
              <span className="spinner" /> Loading…
            </div>
          ) : issued.length === 0 ? (
            <p className="faint">No holder has a key issued at the current epoch yet.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {issued.map((h) => (
                <li
                  key={`${h.holderType}:${h.holderId}`}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0" }}
                >
                  <span>
                    <Icon name={h.holderType === "camera" ? "camera" : "eye"} size={14} /> {h.label}{" "}
                    <span className="faint">({h.holderType})</span>
                  </span>
                  <button
                    className="btn sm"
                    disabled={busy !== null}
                    onClick={() => void reissue(h.holderType, h.holderId, h.label)}
                  >
                    Reissue key
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* recorder consent */}
          <h3 style={{ marginTop: 20, marginBottom: 6 }}>24/7 recording</h3>
          {recorderPk === null ? (
            <p className="faint">No recorder is registered on this server, so recording can't be consented to.</p>
          ) : (
            <>
              <p className="faint" style={{ marginTop: 0 }}>
                Consenting lets the server-side recorder decrypt and store this Home's footage. Verify the recorder's
                fingerprint out-of-band against your ops runbook before enabling:
              </p>
              <code
                style={{ display: "block", padding: "8px 10px", fontSize: 12.5, wordBreak: "break-all", opacity: 0.85 }}
              >
                {fingerprint ?? "…"}
              </code>
              <label className="ctrl-toggle-row" style={{ marginTop: 10 }}>
                <input
                  type="checkbox"
                  checked={home.recorderConsented}
                  disabled={busy !== null}
                  onChange={(e) => void toggleRecorder(e.target.checked)}
                />
                <span className="ctrl-toggle-text">
                  {busy === "recorder" ? "Working…" : home.recorderConsented ? "Recording consent is ON" : "Allow the recorder to decrypt this Home"}
                  <span className="ctrl-toggle-caption">
                    Revoking rotates the key immediately. Footage recorded while consented remains on the server.
                  </span>
                </span>
              </label>
            </>
          )}

          {/* defensive manual rotate */}
          <h3 style={{ marginTop: 20, marginBottom: 6 }}>Rotate key</h3>
          <p className="faint" style={{ marginTop: 0 }}>
            Replace the Home key and re-seal to all current holders (brief sub-second decrypt blip for viewers).
          </p>
          <button className="btn sm" disabled={busy !== null} onClick={() => void manualRotate()}>
            {busy === "rotate" ? <span className="spinner" /> : "Rotate now"}
          </button>

          {/* turn off */}
          <div className="danger-zone">
            <h3 style={{ marginTop: 0, marginBottom: 6 }}>Turn off encryption</h3>
            <p className="faint" style={{ marginTop: 0 }}>
              Stop end-to-end encrypting this Home's camera video. You can turn it back on later.
            </p>
            <button className="btn danger sm" disabled={busy !== null} onClick={() => setShowDisable(true)}>
              Turn off encryption
            </button>
          </div>
        </div>
      )}

      {showDisable && (
        <DisableEncryptionModal
          homeId={home.id}
          recorderConsented={home.recorderConsented}
          onClose={() => setShowDisable(false)}
          onDisabled={onDisabled}
        />
      )}
    </>
  );
}
