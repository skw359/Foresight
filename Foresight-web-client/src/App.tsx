/**
 * Route table for the dashboard.
 *
 *   /login            — sign in (single identifier + password)
 *   /register         — create account
 *   /                 — Homes list (protected)
 *   /homes/:homeId    — camera grid for a Home (protected)
 *   /homes/:homeId/settings — Settings tabs: General (app-level) | Home | Security (protected)
 *   /homes/:homeId/cameras/:cameraId — full-screen + control panel (protected)
 *   /dev/camera       — in-browser dev camera harness (protected)
 *
 * The TopBar is rendered once here (persistent, never animated). Only the page
 * body below it transitions on navigation: the outgoing page fades out for
 * 0.25s, then the incoming page fades in for 0.25s. Pinning <Routes> to a held
 * `displayLocation` keeps the old page on screen while it fades out.
 */
import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { NavStageContext } from "./context/navStage";
import { NavProgressProvider, useNavProgress } from "./context/navProgress";

import { RequireAuth } from "./auth/RequireAuth";
import { TopBar } from "./components/TopBar";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { HomesPage } from "./pages/HomesPage";
import { HomePage } from "./pages/HomePage";
import { HomeSettingsPage } from "./pages/HomeSettingsPage";
import { CameraPage } from "./pages/CameraPage";
import { DevCameraPage } from "./pages/DevCameraPage";

const AUTH_PATHS = ["/login", "/register"];

/** Inner shell — rendered inside NavProgressProvider so it can call useNavProgress. */
function AppShell() {
  const location = useLocation();
  const [displayLocation, setDisplayLocation] = useState(location);
  const [stage, setStage] = useState<"in" | "out">("in");
  const { start } = useNavProgress();

  useEffect(() => {
    if (location.pathname === displayLocation.pathname) {
      // Same page — only search/hash/state moved (e.g. the Settings ?tab=
      // switch). Sync the pinned location WITHOUT the fade: <Routes location>
      // overrides what useLocation/useSearchParams return for descendants, so
      // holding the stale object here would make in-page URL state read as
      // frozen at its value from mount.
      if (location !== displayLocation) setDisplayLocation(location);
      return;
    }
    // Auth redirects must swap instantly — never via the 250ms fade-hold. The
    // hold keeps the OUTGOING page mounted while the URL has already moved; if
    // that held page is a route that redirects under the current auth state
    // (RequireAuth -> /login, or the signed-in guard on /login|/register -> /),
    // it re-fires its <Navigate> on every re-render and the browser throttles
    // the runaway history calls (blank page + "Throttling navigation"). This
    // must cover BOTH ends of the transition: leaving an auth page AND arriving
    // at one (e.g. a signed-out visitor hitting "/" is redirected to /login —
    // here the OUTGOING page is "/", so only the incoming check catches it).
    // TopBar is hidden on auth pages, so there is nothing to fade anyway.
    if (
      AUTH_PATHS.includes(displayLocation.pathname) ||
      AUTH_PATHS.includes(location.pathname)
    ) {
      setDisplayLocation(location);
      setStage("in");
      return;
    }
    // Start the bar immediately on click — before the new page even mounts.
    start();
    setStage("out");
    const id = setTimeout(() => {
      setDisplayLocation(location);
      setStage("in");
    }, 250);
    return () => clearTimeout(id);
  }, [location, displayLocation, start]);

  // The header follows the *displayed* page, so it stays put while the body
  // fades rather than flickering at the halfway point.
  const showChrome = !AUTH_PATHS.includes(displayLocation.pathname);

  return (
    <NavStageContext.Provider value={stage}>
    <div className="app-shell">
      {showChrome && <TopBar />}
      <div className="route-body">
        <Routes location={displayLocation}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />

          <Route
            path="/"
            element={
              <RequireAuth>
                <HomesPage />
              </RequireAuth>
            }
          />
          <Route
            path="/homes/:homeId"
            element={
              <RequireAuth>
                <HomePage />
              </RequireAuth>
            }
          />
          <Route
            path="/homes/:homeId/settings"
            element={
              <RequireAuth>
                <HomeSettingsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/homes/:homeId/cameras/:cameraId"
            element={
              <RequireAuth>
                <CameraPage />
              </RequireAuth>
            }
          />
          <Route
            path="/dev/camera"
            element={
              <RequireAuth>
                <DevCameraPage />
              </RequireAuth>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
    </NavStageContext.Provider>
  );
}

export function App() {
  return (
    <NavProgressProvider>
      <AppShell />
    </NavProgressProvider>
  );
}
