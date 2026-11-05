/**
 * The Settings page reached from a Home's camera grid
 * (/homes/:homeId/settings). One integrated surface for both app-level and
 * per-Home settings, split into tabs (the active tab rides ?tab= so it
 * deep-links):
 *
 *   • General  — app-level settings (GeneralSettings): appearance, pairing
 *                server URL, camera unlock on this device, and account. These
 *                follow the user/device across all Homes.
 *   • Home     — this Home's overview + the danger zone (Delete Home).
 *                Owner-only.
 *   • Home     also manages members (roles, removal → immediate revocation).
 *   • Security — this Home's E2EE control surface (HomeSecurityPanel):
 *                activation, access grants, key reissue, recorder consent,
 *                manual rotate, turning E2EE off. Owner-only.
 *   • Activity — the Home's audit trail (AuditLogPanel). Owner-only.
 *
 * Non-owners only get the General tab (the tab bar is hidden and a notice
 * explains why); ?tab= requests for owner-only tabs fall back to General.
 *
 * The page keeps its own viewer connection to the Home's LiveKit room: key
 * operations must broadcast `rekey` to live cameras/viewers, and activation
 * reconnects this session from plaintext to E2EE — neither works without a
 * room. All tab panels stay mounted (hidden, not unmounted) so switching
 * tabs never drops in-flight operations, fetched state, or unsaved form edits.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { HomeDTO } from "@foresight/contract";

import { ApiRequestError, listHomes, removeMember } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useNavStage } from "../context/navStage";
import { useNavProgressWhileLoading } from "../context/navProgress";
import { Icon } from "../components/Icon";
import { DeleteHomeModal } from "../components/DeleteHomeModal";
import { GeneralSettings } from "../components/GeneralSettings";
import { HomeSecurityPanel } from "../components/HomeSecurityPanel";
import { MembersPanel } from "../components/MembersPanel";
import { AuditLogPanel } from "../components/AuditLogPanel";
import { useCameras } from "../realtime/useCameras";
import { useHomeRoom } from "../realtime/useHomeRoom";

type SettingsTab = "general" | "home" | "security" | "activity";

export function HomeSettingsPage() {
  const { homeId } = useParams<{ homeId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const stage = useNavStage();
  const [showDelete, setShowDelete] = useState(false);
  const { user } = useAuth();
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  // undefined = still resolving, null = not found / failed.
  const [home, setHome] = useState<HomeDTO | null | undefined>(undefined);

  const { cameras: dtos } = useCameras(homeId ?? null);
  const room = useHomeRoom(homeId ?? null, dtos, true);

  useNavProgressWhileLoading(home === undefined);

  // No GET /homes/:id exists, so resolve this Home (name + the viewer's role)
  // from the Homes list — same pattern as HomePage. The role gates the Home and
  // Security tabs; General (app-level) is available to every member.
  const loadHome = useCallback(
    async (signal?: AbortSignal) => {
      if (!homeId) return;
      try {
        const homes = await listHomes(signal);
        if (signal?.aborted) return;
        setHome(homes.find((h) => h.id === homeId) ?? null);
      } catch {
        if (!signal?.aborted) setHome(null);
      }
    },
    [homeId],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    loadHome(ctrl.signal);
    return () => ctrl.abort();
  }, [loadHome]);

  if (!homeId) return null;

  const isOwner = home?.role === "owner";

  const tabParam = searchParams.get("tab");
  const requested: SettingsTab =
    tabParam === "home" || tabParam === "security" || tabParam === "activity" ? tabParam : "general";
  // Home & Security are owner-only; deep links to them fall back to General.
  const tab: SettingsTab = isOwner ? requested : "general";
  const switchTab = (next: SettingsTab) =>
    setSearchParams(next === "general" ? {} : { tab: next }, { replace: true });

  const keyControls = {
    reconnect: room.reconnect,
    applyHomeKey: room.applyHomeKey,
    broadcastRekey: room.broadcastRekey,
  };

  async function leaveHome() {
    if (!homeId || !user || leaveBusy) return;
    setLeaveBusy(true);
    setLeaveError(null);
    try {
      await removeMember(homeId, user.id);
      navigate("/");
    } catch (err) {
      setLeaveError(err instanceof ApiRequestError ? err.message : "Could not leave this Home.");
      setLeaveBusy(false);
    }
  }

  return (
    <>
      <div className="breadcrumb-rail">
        <div className="breadcrumb">
          <Link to="/">Homes</Link>
          <span className="sep"><Icon name="chevronRight" size={13} /></span>
          <Link to={`/homes/${homeId}`}>Cameras</Link>
          <span className="sep"><Icon name="chevronRight" size={13} /></span>
          <span>Settings</span>
        </div>
      </div>

      {/* `wide` matches the 1520px breadcrumb rail above (like the other pages
          under it); .settings-body then caps the content at a form width. */}
      <div className={`page wide no-top nav-fade ${stage}`}>
        <div className="section-head">
          <h1>{home?.name ? `${home.name} — Settings` : "Settings"}</h1>
        </div>

        {home === undefined ? (
          <div className="center-load">
            <span className="spinner" /> Loading…
          </div>
        ) : (
          <div className="settings-body">
            {home === null && (
              <div className="error-box">
                This Home could not be loaded. <Link to="/">Back to Homes</Link>.
                Your general settings are still available below.
              </div>
            )}
            {home !== null && !isOwner && (
              <div className="notice-box" style={{ display: "block" }}>
                Only this Home's owner can manage its Home and Security
                settings. Your general settings are below.
                <div className="btn-row" style={{ marginTop: 10 }}>
                  <button type="button" className="btn sm" disabled={leaveBusy} onClick={() => void leaveHome()}>
                    {leaveBusy ? <span className="spinner" /> : "Leave this Home"}
                  </button>
                </div>
                {leaveError && <p className="error-box" style={{ marginTop: 8 }}>{leaveError}</p>}
              </div>
            )}

            {isOwner && (
              <div className="tabs" role="tablist" aria-label="Settings sections">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "general"}
                  className={tab === "general" ? "active" : ""}
                  onClick={() => switchTab("general")}
                >
                  General
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "home"}
                  className={tab === "home" ? "active" : ""}
                  onClick={() => switchTab("home")}
                >
                  Home
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "security"}
                  className={tab === "security" ? "active" : ""}
                  onClick={() => switchTab("security")}
                >
                  Security
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "activity"}
                  className={tab === "activity" ? "active" : ""}
                  onClick={() => switchTab("activity")}
                >
                  Activity
                </button>
              </div>
            )}

            <section role="tabpanel" hidden={tab !== "general"}>
              <p className="muted" style={{ fontSize: 13, marginTop: 0, marginBottom: 18 }}>
                These settings apply to your account and this device — across
                all Homes, not just this one.
              </p>
              <GeneralSettings />
            </section>

            {home !== null && isOwner && (
              <>
                <section role="tabpanel" hidden={tab !== "home"}>
                  <div className="field">
                    <span>Home</span>
                    <p style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 600 }}>{home.name}</p>
                    <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
                      You own this Home · {dtos.length} camera{dtos.length === 1 ? "" : "s"} ·{" "}
                      {home.keyEpoch >= 1 ? "end-to-end encrypted" : "not end-to-end encrypted"}
                    </p>
                  </div>

                  <MembersPanel home={home} controls={keyControls} onUpdated={() => loadHome()} />

                  <div className="danger-zone">
                    <div className="field">
                      <span>Danger zone</span>
                      <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
                        Permanently delete this Home, its cameras, and its recorded footage for every
                        member. This cannot be undone.
                      </p>
                    </div>
                    <button type="button" className="btn danger" onClick={() => setShowDelete(true)}>
                      <Icon name="trash" size={16} />
                      Delete this Home
                    </button>
                  </div>
                </section>

                <section role="tabpanel" hidden={tab !== "security"}>
                  <HomeSecurityPanel
                    home={home}
                    cameras={dtos}
                    controls={keyControls}
                    onUpdated={() => loadHome()}
                  />
                </section>

                <section role="tabpanel" hidden={tab !== "activity"}>
                  {tab === "activity" && <AuditLogPanel homeId={home.id} />}
                </section>
              </>
            )}
          </div>
        )}
      </div>

      {showDelete && home && (
        <DeleteHomeModal
          homeId={homeId}
          homeName={home.name}
          onClose={() => setShowDelete(false)}
          onDeleted={() => navigate("/")}
        />
      )}
    </>
  );
}
