/**
 * A Home's camera grid. Loads cameras over REST, connects to the Home's
 * LiveKit room as a viewer, and renders live LOW-quality tiles with health
 * badges + viewer counts. Clicking a tile opens the full-screen camera view.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavStage } from "../context/navStage";
import { useNavProgressWhileLoading } from "../context/navProgress";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { HomeDTO } from "@foresight/contract";

import { listHomes } from "../api/client";
import { CameraTile } from "../components/CameraTile";
import { Icon } from "../components/Icon";
import { AddCameraModal } from "../components/AddCameraModal";
import { AddMemberModal } from "../components/AddMemberModal";
import { useCameras } from "../realtime/useCameras";
import { useHomeRoom, type RoomE2EEState, type RoomStatus } from "../realtime/useHomeRoom";

export function HomePage() {
  const { homeId } = useParams<{ homeId: string }>();
  const navigate = useNavigate();
  const [showAdd, setShowAdd] = useState(false);
  const [showMember, setShowMember] = useState(false);
  const [home, setHome] = useState<HomeDTO | null>(null);

  const { cameras: dtos, loading, error, refresh } = useCameras(homeId ?? null);
  const room = useHomeRoom(homeId ?? null, dtos, true);

  // Drive the top loading bar while the camera registry loads on navigation.
  useNavProgressWhileLoading(loading);

  // No GET /homes/:id exists, so resolve this Home (its name + the viewer's
  // role) from the Homes list. The role gates owner-only actions like adding
  // members; failure is non-fatal (generic heading, owner actions hidden).
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

  const stage = useNavStage();
  const isOwner = home?.role === "owner";
  const heading = home?.name ?? "Cameras";

  return (
    <>
      <div className="breadcrumb-rail">
        <div className="breadcrumb">
          <Link to="/">Homes</Link>
          <span className="sep"><Icon name="chevronRight" size={13} /></span>
          <span>Cameras</span>
        </div>
      </div>

      <div className={`page wide no-top nav-fade ${stage}`}>
        <div className="section-head">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <HomePresence status={room.status} e2ee={room.e2ee} />
            <h1>{heading}</h1>
          </div>
          <div className="btn-row">
            {isOwner && (
              <button className="btn" onClick={() => setShowMember(true)}>
                <Icon name="plus" size={16} />
                Add Member
              </button>
            )}
            <button className="btn primary" onClick={() => setShowAdd(true)}>
              <Icon name="plus" size={16} />
              Add Camera
            </button>
            <button
              className="btn"
              onClick={() => navigate(`/homes/${homeId}/settings`)}
              title="Settings — general, this Home & security"
            >
              <Icon name="settings" size={16} />
              Settings
            </button>
          </div>
        </div>

        {error && <div className="error-box">{error}</div>}
        <E2EEStatusBanner e2ee={room.e2ee} onUnlock={room.reconnect} />
        {room.error && (
          <div className="notice-box">
            Live connection unavailable: {room.error}. Camera list still shown;
            video will appear once the backend + LiveKit are reachable.
          </div>
        )}

        {loading && room.cameraList.length === 0 ? (
          <div className="center-load">
            <span className="spinner" /> Loading cameras…
          </div>
        ) : room.cameraList.length === 0 ? (
          <div className="empty">
            <p>No cameras in this Home yet.</p>
            <p className="faint">
              Add a camera to pair an iPhone (or test with the Dev Camera
              harness).
            </p>
          </div>
        ) : (
          <div className="camera-grid">
            {room.cameraList.map((cam) => (
              <CameraTile
                key={cam.id}
                camera={cam}
                onOpen={() =>
                  navigate(`/homes/${homeId}/cameras/${cam.id}`)
                }
              />
            ))}
          </div>
        )}
      </div>

      {showAdd && (
        <AddCameraModal
          homeId={homeId}
          keyEpoch={home?.keyEpoch ?? 0}
          onClose={() => {
            setShowAdd(false);
            refresh();
          }}
        />
      )}

      {showMember && (
        <AddMemberModal
          homeId={homeId}
          homeName={home?.name}
          keyEpoch={home?.keyEpoch ?? 0}
          onClose={() => setShowMember(false)}
          onAdded={(updated) => setHome(updated)}
        />
      )}

    </>
  );
}

/**
 * Presence indicator to the left of the Home name: a shield when the Home is
 * end-to-end encrypted, a plain dot otherwise. Color tracks the room
 * connection (green = online); an encrypted Home that can't decrypt yet
 * (locked / awaiting key / unsupported) shows an amber shield while the
 * banner below explains what to do.
 */
function HomePresence({ status, e2ee }: { status: RoomStatus; e2ee: RoomE2EEState }) {
  const connectionLabel: Record<RoomStatus, string> = {
    idle: "Idle",
    connecting: "Connecting…",
    connected: "Online",
    reconnecting: "Reconnecting…",
    disconnected: "Offline",
    error: "Offline",
  };
  const encrypted = e2ee.status !== "off";
  const encryptionLabel: Record<RoomE2EEState["status"], string> = {
    off: "",
    active: "End-to-end encrypted",
    locked: "Encrypted — locked on this device",
    "awaiting-key": "Encrypted — awaiting key",
    unsupported: "Encrypted — this browser can't decrypt",
  };
  const title = encrypted
    ? `${encryptionLabel[e2ee.status]} • ${connectionLabel[status]}`
    : connectionLabel[status];
  const shieldClass =
    status === "connected" && e2ee.status !== "active" ? "attention" : status;
  return (
    <span className="home-presence" title={title} role="img" aria-label={title}>
      {encrypted ? (
        <span className={`presence-shield ${shieldClass}`}>
          <Icon name="shield" size={20} />
        </span>
      ) : (
        <span className={`status-dot ${status}`} />
      )}
    </span>
  );
}

/** Full-width banner for the states that need an explanation / action. */
function E2EEStatusBanner({ e2ee, onUnlock }: { e2ee: RoomE2EEState; onUnlock: () => void }) {
  if (e2ee.status === "unsupported") {
    return (
      <div className="error-box">
        This Home is end-to-end encrypted, but this browser can't decrypt the video. Use a recent Chromium-based
        browser (Chrome/Edge) over HTTPS to view it.
      </div>
    );
  }
  if (e2ee.status === "locked") {
    return (
      <div className="notice-box">
        <span>Encrypted cameras are locked on this device.</span>
        <button className="btn sm" style={{ marginLeft: 10 }} onClick={onUnlock}>
          Unlock
        </button>
      </div>
    );
  }
  if (e2ee.status === "awaiting-key") {
    return (
      <div className="notice-box">
        This Home is encrypted, but no one has granted this device access to the key yet. An owner can grant it from
        Settings → Security. Video will appear automatically once access is sealed.
      </div>
    );
  }
  return null;
}
