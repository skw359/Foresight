/**
 * E2EE identity + key context (shared/E2EE.md §7.2).
 *
 * Owns:
 *   - the unlocked user identity (X25519 sk/pk) — held in memory, and — ONLY
 *     when the user opts in to "Keep me unlocked on this device" — mirrored
 *     into the device key cache (crypto/keystore.ts: IndexedDB under a
 *     non-extractable WebCrypto key) so a restored session unlocks silently.
 *   - a Map<homeId, {epoch, hmkBase64}> HMK cache (memory only).
 * Everything — including the device cache — is wiped on signOut and on any 401
 * (both clear the token → onAuthChange), so no session ⇒ no key material at rest.
 *
 * Cold reload, opted in: the JWT survives in localStorage and the identity is
 * silently restored from the device cache, so the login password stays the only
 * password the user types (the web analog of §7.4's Face ID cache). Opted out
 * (the default) or when restore comes up empty (new device, cleared storage,
 * private mode), `ensureIdentity()` prompts for the password and re-unlocks in
 * the KDF worker (spinner, never freezes the UI). The same modal doubles as
 * first-login setup when GET /me/keys has no vault yet. The opt-in is offered
 * on the login form, in the unlock prompt, and in Settings; disabling it clears
 * the cache immediately.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { EncryptedKeyVault, SealedKey } from "@foresight/contract";

import { getHomeKey, getMyKeys, putMyKeys } from "../api/client";
import { getToken, getUser, onAuthChange } from "../api/auth";
import { Modal } from "../components/Modal";
import { loadSodium, VAULT_TAMPER_MESSAGE } from "../crypto/sodium";
import { unsealHmkToBase64 } from "../crypto/homeKey";
import {
  clearPersistedIdentity,
  isKeepUnlockedEnabled,
  persistIdentity,
  restoreIdentity,
  setKeepUnlockedEnabled,
} from "../crypto/keystore";
import { createVault, ensureSelfTest, unlockVault, type Identity } from "../crypto/identity";

/** A home's key state as far as this device is concerned. */
export interface HomeKeyState {
  epoch: number;
  /** base64(HMK) — the LiveKit setKey string — or null when awaiting a key / not activated. */
  hmkBase64: string | null;
}

interface E2EEContextValue {
  /** True once the user's private key is unlocked in memory. */
  hasIdentity: boolean;
  /** The user's own X25519 public key (base64), once known. */
  publicKeyB64: string | null;
  /** Adopt an identity produced by the auth flow (post-login unlock / first-login). */
  setIdentity: (identity: Identity) => void;
  /** The unlocked identity if present, else null (no prompt). */
  peekIdentity: () => Identity | null;
  /** Ensure the sk is unlocked, prompting for the password if needed. Rejects if cancelled. */
  ensureIdentity: () => Promise<Identity>;
  /** The opt-in "keep me unlocked on this device" preference (default off). */
  keepUnlocked: boolean;
  /** Flip the preference. Enabling caches the current identity (if unlocked); disabling clears the cache. */
  setKeepUnlocked: (enabled: boolean) => void;
  /** Cached HMK base64 for a home AT THE GIVEN EPOCH, or null (a stale-epoch cache entry never matches). */
  getCachedHomeKey: (homeId: string, epoch: number) => string | null;
  /** Cache an unsealed HMK base64 at an epoch. */
  cacheHomeKey: (homeId: string, epoch: number, hmkBase64: string) => void;
  /** Unseal an inline sealed key (e.g. from /rt/token) and cache it. May prompt. */
  unsealInto: (homeId: string, sealed: SealedKey) => Promise<string>;
  /**
   * Fetch (GET /homes/:id/key), unseal + cache the caller's HMK. null hmk ⇒ awaiting/not activated.
   * When `expectedEpoch` is given, a cached HMK at a DIFFERENT epoch is ignored (re-fetched).
   */
  ensureHomeKey: (homeId: string, expectedEpoch?: number) => Promise<HomeKeyState>;
  /** Wipe all in-memory key material. */
  wipe: () => void;
}

const E2EECtx = createContext<E2EEContextValue | null>(null);

export function E2EEProvider({ children }: { children: ReactNode }) {
  const identityRef = useRef<Identity | null>(null);
  const cacheRef = useRef<Map<string, HomeKeyState>>(new Map());
  const [hasIdentity, setHasIdentity] = useState(false);
  const [publicKeyB64, setPublicKeyB64] = useState<string | null>(null);
  const [keepUnlocked, setKeepUnlockedState] = useState(isKeepUnlockedEnabled);

  // Unlock prompt plumbing.
  const [prompt, setPrompt] = useState<{ mode: "unlock" | "setup" } | null>(null);
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const vaultRef = useRef<EncryptedKeyVault | null>(null);
  const pendingRef = useRef<{ resolve: (i: Identity) => void; reject: (e: Error) => void } | null>(null);
  const inFlightRef = useRef<Promise<Identity> | null>(null);

  // Run the §3.2 self-test once, before the first crypto use (lazy: this is what
  // "the provider initializes the self-test" means — it never eagerly loads the
  // 150 KB WASM for users who never touch E2EE; §9.2).
  const readyRef = useRef<Promise<void> | null>(null);
  const ready = useCallback(() => (readyRef.current ??= ensureSelfTest()), []);

  const applyIdentity = useCallback((identity: Identity, persist = true) => {
    identityRef.current = identity;
    setHasIdentity(true);
    setPublicKeyB64(identity.publicKeyB64);
    if (persist && isKeepUnlockedEnabled()) {
      const userId = getUser()?.id;
      // Best-effort device cache (keystore.ts) so the next cold load restores
      // silently instead of re-prompting; the unlock modal remains the fallback.
      if (userId) void persistIdentity(userId, identity);
    }
  }, []);

  const setKeepUnlocked = useCallback((enabled: boolean) => {
    setKeepUnlockedEnabled(enabled); // disabling clears the device cache itself
    setKeepUnlockedState(enabled);
    if (enabled) {
      const userId = getUser()?.id;
      // Already unlocked (e.g. toggled on from Settings mid-session) → cache
      // now; otherwise the next login/unlock persists it.
      if (userId && identityRef.current) void persistIdentity(userId, identityRef.current);
    }
  }, []);

  // Silent cold-load restore: opted in + a live session + a device-cached
  // identity means no prompt. ensureIdentity awaits this before deciding to
  // show the modal. Opted out, any leftover cache row is dropped instead.
  const restoreRef = useRef<Promise<void> | null>(null);
  useEffect(() => {
    if (restoreRef.current) return;
    const userId = getUser()?.id;
    if (!getToken() || !userId || identityRef.current || !isKeepUnlockedEnabled()) {
      if (!isKeepUnlockedEnabled()) void clearPersistedIdentity();
      restoreRef.current = Promise.resolve();
      return;
    }
    restoreRef.current = (async () => {
      const restored = await restoreIdentity(userId);
      // A sign-out/401 while restoring already wiped — don't resurrect the key.
      if (restored && getToken() && !identityRef.current) applyIdentity(restored, false);
    })();
  }, [applyIdentity]);

  const wipe = useCallback(() => {
    const prev = identityRef.current;
    identityRef.current = null;
    cacheRef.current.clear();
    setHasIdentity(false);
    setPublicKeyB64(null);
    void clearPersistedIdentity();
    if (prev) {
      // Best-effort scrub of the private key bytes.
      void loadSodium().then((s) => {
        try {
          s.memzero(prev.privateKey);
        } catch {
          /* ignore */
        }
      });
    }
  }, []);

  // Wipe whenever the token is cleared — covers explicit signOut AND 401 handling
  // (api/client clears the token on 401, which emits onAuthChange).
  useEffect(() => {
    return onAuthChange(() => {
      if (!getToken()) wipe();
    });
  }, [wipe]);

  const ensureIdentity = useCallback((): Promise<Identity> => {
    if (identityRef.current) return Promise.resolve(identityRef.current);
    if (inFlightRef.current) return inFlightRef.current;
    const flow = (async () => {
      // The device-cache restore may still be in flight on a cold load — let it
      // finish before concluding a password prompt is needed.
      if (restoreRef.current) await restoreRef.current;
      if (identityRef.current) return identityRef.current;
      await ready();
      const { keyVault } = await getMyKeys();
      vaultRef.current = keyVault;
      return await new Promise<Identity>((resolve, reject) => {
        pendingRef.current = { resolve, reject };
        setPromptError(null);
        setPrompt({ mode: keyVault ? "unlock" : "setup" });
      });
    })();
    inFlightRef.current = flow;
    const clear = () => {
      inFlightRef.current = null;
    };
    flow.then(clear, clear);
    return flow;
  }, [ready]);

  const submitPrompt = useCallback(
    async (password: string, keep: boolean) => {
      const pending = pendingRef.current;
      if (!pending || promptBusy) return;
      setPromptBusy(true);
      setPromptError(null);
      try {
        let identity: Identity;
        if (vaultRef.current) {
          identity = await unlockVault(password, vaultRef.current);
        } else {
          const created = await createVault(password);
          await putMyKeys(created.vault);
          identity = created.identity;
        }
        // Record the checkbox only on success (a failed attempt changes nothing),
        // and before applyIdentity so the persist decision sees it.
        setKeepUnlocked(keep);
        applyIdentity(identity);
        pendingRef.current = null;
        setPrompt(null);
        pending.resolve(identity);
      } catch (err) {
        // The tamper alarm must never be blurred into "wrong password" (§10.4).
        const tampered = err instanceof Error && err.message === VAULT_TAMPER_MESSAGE;
        setPromptError(
          vaultRef.current && !tampered
            ? "Incorrect password. Try again."
            : err instanceof Error
              ? err.message
              : "Could not set up your secure keys.",
        );
      } finally {
        setPromptBusy(false);
      }
    },
    [applyIdentity, setKeepUnlocked, promptBusy],
  );

  const cancelPrompt = useCallback(() => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setPrompt(null);
    setPromptError(null);
    pending?.reject(new Error("Unlock cancelled"));
  }, []);

  const cacheHomeKey = useCallback((homeId: string, epoch: number, hmkBase64: string) => {
    cacheRef.current.set(homeId, { epoch, hmkBase64 });
  }, []);

  const getCachedHomeKey = useCallback((homeId: string, epoch: number) => {
    const cached = cacheRef.current.get(homeId);
    // A cached HMK from an older epoch would "decrypt" nothing while reporting
    // status active — only ever serve a cache entry at the requested epoch.
    return cached && cached.epoch === epoch ? cached.hmkBase64 : null;
  }, []);

  const unsealInto = useCallback(
    async (homeId: string, sealed: SealedKey): Promise<string> => {
      await ready();
      const identity = await ensureIdentity();
      const hmkBase64 = await unsealHmkToBase64(sealed.ciphertext, identity.publicKey, identity.privateKey);
      cacheHomeKey(homeId, sealed.epoch, hmkBase64);
      return hmkBase64;
    },
    [ready, ensureIdentity, cacheHomeKey],
  );

  const ensureHomeKey = useCallback(
    async (homeId: string, expectedEpoch?: number): Promise<HomeKeyState> => {
      const cached = cacheRef.current.get(homeId);
      if (cached && cached.hmkBase64 && (expectedEpoch === undefined || cached.epoch === expectedEpoch)) {
        return cached;
      }
      const resp = await getHomeKey(homeId);
      if (resp.epoch === 0 || !resp.sealedKey) {
        const state: HomeKeyState = { epoch: resp.epoch, hmkBase64: null };
        return state;
      }
      const hmkBase64 = await unsealInto(homeId, { ciphertext: resp.sealedKey, epoch: resp.epoch });
      return { epoch: resp.epoch, hmkBase64 };
    },
    [unsealInto],
  );

  const peekIdentity = useCallback(() => identityRef.current, []);

  const value = useMemo<E2EEContextValue>(
    () => ({
      hasIdentity,
      publicKeyB64,
      setIdentity: applyIdentity,
      peekIdentity,
      ensureIdentity,
      keepUnlocked,
      setKeepUnlocked,
      getCachedHomeKey,
      cacheHomeKey,
      unsealInto,
      ensureHomeKey,
      wipe,
    }),
    [
      hasIdentity,
      publicKeyB64,
      applyIdentity,
      peekIdentity,
      ensureIdentity,
      keepUnlocked,
      setKeepUnlocked,
      getCachedHomeKey,
      cacheHomeKey,
      unsealInto,
      ensureHomeKey,
      wipe,
    ],
  );

  return (
    <E2EECtx.Provider value={value}>
      {children}
      {prompt && (
        <UnlockPrompt
          mode={prompt.mode}
          busy={promptBusy}
          error={promptError}
          keepUnlockedDefault={keepUnlocked}
          onSubmit={submitPrompt}
          onCancel={cancelPrompt}
        />
      )}
    </E2EECtx.Provider>
  );
}

export function useE2EE(): E2EEContextValue {
  const ctx = useContext(E2EECtx);
  if (!ctx) throw new Error("useE2EE must be used within <E2EEProvider>");
  return ctx;
}

/* ------------------------------------------------------------- unlock modal */

function UnlockPrompt({
  mode,
  busy,
  error,
  keepUnlockedDefault,
  onSubmit,
  onCancel,
}: {
  mode: "unlock" | "setup";
  busy: boolean;
  error: string | null;
  keepUnlockedDefault: boolean;
  onSubmit: (password: string, keepUnlocked: boolean) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const [keep, setKeep] = useState(keepUnlockedDefault);
  const setup = mode === "setup";

  function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !password) return;
    onSubmit(password, keep);
  }

  return (
    <Modal title={setup ? "Set up end-to-end encryption" : "Unlock your cameras"} onClose={onCancel}>
      {(close) => (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            {setup
              ? "Enter your password to create the encryption keys that protect this account's camera feeds. This runs entirely on your device."
              : "Your camera feeds are end-to-end encrypted. Enter your password to unlock them on this device."}
          </p>
          {error && <div className="error-box">{error}</div>}
          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="e2ee-unlock-pw">Password</label>
              <input
                id="e2ee-unlock-pw"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                disabled={busy}
              />
            </div>
            <label className="ctrl-toggle-row">
              <input
                type="checkbox"
                checked={keep}
                disabled={busy}
                onChange={(e) => setKeep(e.target.checked)}
              />
              <span className="ctrl-toggle-text">
                Keep me unlocked on this device
                <span className="ctrl-toggle-caption">
                  Your encryption keys stay on this device so cameras open without your password. Leave off on
                  shared computers.
                </span>
              </span>
            </label>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={close} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={busy || !password}>
                {busy ? (
                  <>
                    <span className="spinner" /> {setup ? "Creating keys…" : "Unlocking…"}
                  </>
                ) : setup ? (
                  "Create keys"
                ) : (
                  "Unlock"
                )}
              </button>
            </div>
          </form>
        </>
      )}
    </Modal>
  );
}
