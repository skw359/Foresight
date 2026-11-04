/** Lists the user's Homes, lets them create a Home and open one. */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavStage } from "../context/navStage";
import { useNavProgress } from "../context/navProgress";
import { useNavigate } from "react-router-dom";
import type { HomeDTO } from "@foresight/contract";

import { ApiRequestError, createHome, listHomes } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Modal } from "../components/Modal";
import { Icon } from "../components/Icon";

/**
 * Greeting name. Prefers the user's chosen first name (set at registration or in
 * Settings); for accounts without one, falls back to a best-effort name derived
 * from the login identifier — the email local-part / first token, capitalized.
 */
function greetingName(
  firstName: string | null | undefined,
  identifier: string | undefined,
): string | null {
  const chosen = firstName?.trim();
  if (chosen) return chosen;
  if (!identifier) return null;
  const local = identifier.split("@")[0];
  const first = local.split(/[._\-\s]/)[0];
  if (!first) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

export function HomesPage() {
  const [homes, setHomes] = useState<HomeDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();
  const nav = useNavProgress();
  const { user } = useAuth();
  const name = greetingName(user?.firstName, user?.identifier);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      nav.start();
      try {
        const result = await listHomes(signal);
        setHomes(result);
      } catch (err) {
        if (signal?.aborted) return;
        setHomes([]);
        setError(
          err instanceof ApiRequestError ? err.message : "Failed to load homes.",
        );
      } finally {
        // On abort the page is navigating away; let the next page own the bar.
        if (!signal?.aborted) nav.finish();
      }
    },
    [nav],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const stage = useNavStage();
  return (
    <>
      <div className={`page nav-fade ${stage}`}>
        <div className="section-head">
          <h1>{name ? `Welcome back, ${name}.` : "Welcome back."}</h1>
          <button className="btn primary" onClick={() => setShowCreate(true)}>
            <Icon name="plus" size={16} />
            New Home
          </button>
        </div>

        {error && <div className="error-box">{error}</div>}

        {homes === null ? (
          <div className="center-load">
            <span className="spinner" /> Loading homes…
          </div>
        ) : homes.length === 0 ? (
          <div className="empty">
            <p>You don't have any Homes yet.</p>
            <p className="faint">
              A Home is a group of cameras. Create one to start pairing
              cameras.
            </p>
            <button
              className="btn primary"
              style={{ marginTop: 18 }}
              onClick={() => setShowCreate(true)}
            >
              <Icon name="plus" size={16} />
              Create your first Home
            </button>
          </div>
        ) : (
          <div className="card-grid">
            {homes.map((home) => (
              <div
                key={home.id}
                className="home-card"
                onClick={() => navigate(`/homes/${home.id}`)}
              >
                <h3>
                  {home.keyEpoch >= 1 && (
                    <Icon name="shield" size={16} className="icon e2ee-shield" title="End-to-end encrypted" />
                  )}
                  {home.name}
                </h3>
                <div className="role">{home.role}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateHomeModal
          onClose={() => setShowCreate(false)}
          onCreated={(home) => {
            setShowCreate(false);
            setHomes((prev) => (prev ? [...prev, home] : [home]));
            navigate(`/homes/${home.id}`);
          }}
        />
      )}
    </>
  );
}

function CreateHomeModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (home: HomeDTO) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const home = await createHome({ name: name.trim() });
      onCreated(home);
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : "Failed to create home.",
      );
      setBusy(false);
    }
  }

  return (
    <Modal title="New Home" onClose={onClose}>
      {(close) => (
        <>
          {error && <div className="error-box">{error}</div>}
          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="home-name">Home name</label>
              <input
                id="home-name"
                type="text"
                placeholder="e.g. Main House"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
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
                className="btn primary"
                disabled={busy || !name.trim()}
              >
                {busy ? <span className="spinner" /> : "Create"}
              </button>
            </div>
          </form>
        </>
      )}
    </Modal>
  );
}
