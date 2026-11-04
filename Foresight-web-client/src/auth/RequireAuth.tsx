/** Redirects to /login when the user is not authenticated. */
import { Navigate, useLocation } from "react-router-dom";
import { useMemo, type ReactNode } from "react";

import { useAuth } from "./AuthContext";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  // <Navigate>'s effect re-runs whenever its `state` prop changes identity, so
  // a fresh `{ from }` literal each render would re-fire the redirect on every
  // re-render and loop the router. Memoize it to a stable reference per path.
  const redirectState = useMemo(
    () => ({ from: location.pathname }),
    [location.pathname],
  );

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={redirectState} />;
  }
  return <>{children}</>;
}
