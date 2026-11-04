/**
 * Shared register/login form. SINGLE identifier field (email OR username) +
 * password with no complexity rules, per the contract.
 *
 * Visual layout mirrors the Journey login: a dark, two-panel split card with an
 * animated visual side and a form side. Recolored to Foresight's coral accent.
 * Styling lives under the scoped `.login-screen` block in styles.css.
 */
import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { AuthResponse } from "@foresight/contract";

import { ApiRequestError, login, putMyKeys, register } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useE2EE } from "../e2ee/E2EEContext";
import { createVault, unlockVault } from "../crypto/identity";
import VisualCanvas from "../components/VisualCanvas";

type Mode = "login" | "register";

/** Sub-phase of a submit so the spinner can name the (potentially ~1-2s) KDF step. */
type Phase = "idle" | "auth" | "keys";

export function AuthForm({ mode }: { mode: Mode }) {
  const [identifier, setIdentifier] = useState("");
  const [firstName, setFirstName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const { signIn } = useAuth();
  const { setIdentity, keepUnlocked: keepUnlockedPref, setKeepUnlocked } = useE2EE();
  const [keepUnlocked, setKeepUnlockedChecked] = useState(keepUnlockedPref);
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };

  const isLogin = mode === "login";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);

    if (!identifier.trim() || !password) {
      setError("Enter your email/username and password.");
      return;
    }

    setBusy(true);
    setPhase("auth");
    try {
      const res: AuthResponse = isLogin
        ? await login({ identifier: identifier.trim(), password })
        : await register({
            identifier: identifier.trim(),
            password,
            firstName: firstName.trim() || undefined,
          });
      signIn(res.token, res.user);

      // Record the "keep me unlocked" choice first so the identity adoption
      // below persists (or clears) the device key cache accordingly.
      setKeepUnlocked(keepUnlocked);

      // Unlock (or, for a first login / register, create + upload) the E2EE key
      // vault while the password is still in hand. The Argon2id KDF runs in a
      // Web Worker (§9.2) — keep the spinner up but never freeze the UI.
      setPhase("keys");
      try {
        if (res.keyVault) {
          setIdentity(await unlockVault(password, res.keyVault));
        } else {
          // First-ever login OR register (register never carries a vault): mint
          // the keypair, wrap under this password, POST /me/keys. (§6 Register /
          // first-login migration reconciliation.)
          const created = await createVault(password);
          await putMyKeys(created.vault);
          setIdentity(created.identity);
        }
      } catch (keyErr) {
        // Non-fatal: the app re-prompts to unlock when an E2EE action needs the
        // key (cold-reload path). Don't block sign-in on a key hiccup.
        console.warn("E2EE key setup deferred:", keyErr);
      }

      navigate(location.state?.from ?? "/", { replace: true });
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(err.message);
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setBusy(false);
      setPhase("idle");
    }
  }

  function onForgotPassword() {
    setError("Password reset isn't available yet. Contact your administrator.");
  }

  return (
    <div className="login-screen">
      <div className="login-wrapper">
        <div className="visual-side" aria-hidden="true">
          <VisualCanvas />
          <div className="visual-content">
            <h2>
              Old iPhones, reborn as
              <br />
              <span className="highlight">security cameras.</span>
            </h2>
          </div>
          <div className="visual-footer">
            <p>© 2026 Foresight Security</p>
          </div>
        </div>

        <div className="form-side">
          <div className="logo">
            <span className="mark">
              <img src="/logo.png" alt="" />
            </span>
            <span>Foresight Security</span>
          </div>

          <div className="header-text">
            <h1>{isLogin ? "Sign in to continue" : "Create your account"}</h1>
            <p style={isLogin ? { visibility: "hidden", marginBottom: "20px" } : undefined}>
              {isLogin
                ? "Welcome back. Access your cameras."
                : "Turn old iPhones into live security cameras."}
            </p>
          </div>

          <form className="login-form" onSubmit={onSubmit}>
            {error && (
              <div className="error-box" role="alert">
                {error}
              </div>
            )}

            {!isLogin && (
              <div className="input-group">
                <input
                  id="firstName"
                  type="text"
                  autoComplete="given-name"
                  placeholder="First name"
                  aria-label="First name"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  disabled={busy}
                />
              </div>
            )}

            <div className="input-group">
              <input
                id="identifier"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                placeholder="Email or username"
                aria-label="Email or username"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                disabled={busy}
                autoFocus
                required
              />
            </div>

            <div className="input-group">
              <input
                id="password"
                type="password"
                autoComplete={isLogin ? "current-password" : "new-password"}
                placeholder="Your password"
                aria-label="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
                required
              />
              {!isLogin && password.length > 0 && <PassphraseHint password={password} />}
            </div>

            <label className="keep-unlocked">
              <input
                type="checkbox"
                checked={keepUnlocked}
                disabled={busy}
                onChange={(e) => setKeepUnlockedChecked(e.target.checked)}
              />
              <span className="keep-unlocked-label">
                Keep me unlocked on this device
                <span className="keep-unlocked-caption">
                  Open cameras without re-entering your password. Leave off on shared computers.
                </span>
              </span>
            </label>

            {isLogin && (
              <div className="actions">
                <button
                  className="forgot-pass"
                  type="button"
                  onClick={onForgotPassword}
                  disabled={busy}
                >
                  Forgot password?
                </button>
              </div>
            )}

            <button className="btn-primary" type="submit" disabled={busy}>
              {busy ? (
                <>
                  <span className="spinner" />{" "}
                  {phase === "keys" ? "Securing your account…" : "Please wait…"}
                </>
              ) : isLogin ? (
                "Sign in"
              ) : (
                "Create account"
              )}
            </button>
          </form>

          <p className="signup-link">
            {isLogin ? (
              <>
                Don't have an account?
                <Link to="/register">Create one.</Link>
              </>
            ) : (
              <>
                Already have an account?
                <Link to="/login">Sign in.</Link>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Unobtrusive passphrase-strength hint (§10.4#8). Your password is the root of
 * the E2EE identity — a weak one is brute-forceable against a leaked vault, and
 * Argon2id makes each guess costly but cannot rescue a truly weak password.
 * Heuristic only (length + character variety) — no external estimator.
 */
function PassphraseHint({ password }: { password: string }) {
  const { score, label } = passphraseStrength(password);
  const colors = ["#e0392b", "#c77a00", "#c7a000", "#3a9d57", "#1f9d57"];
  return (
    <div style={{ marginTop: 8 }} aria-live="polite">
      <div style={{ display: "flex", gap: 4 }}>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              background: i < score ? colors[score] : "rgba(128,128,128,0.25)",
              transition: "background 0.2s",
            }}
          />
        ))}
      </div>
      <div className="faint" style={{ fontSize: 12, marginTop: 5 }}>
        Password strength: {label}. It protects your encrypted camera keys — longer is stronger.
      </div>
    </div>
  );
}

function passphraseStrength(pw: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  let variety = 0;
  if (/[a-z]/.test(pw)) variety++;
  if (/[A-Z]/.test(pw)) variety++;
  if (/[0-9]/.test(pw)) variety++;
  if (/[^A-Za-z0-9]/.test(pw)) variety++;
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12 && variety >= 2) score++;
  if (pw.length >= 16 && variety >= 3) score++;
  if (pw.length >= 20 && variety >= 3) score++;
  const clamped = Math.min(4, score) as 0 | 1 | 2 | 3 | 4;
  const label = ["very weak", "weak", "fair", "strong", "very strong"][clamped];
  return { score: clamped, label };
}
