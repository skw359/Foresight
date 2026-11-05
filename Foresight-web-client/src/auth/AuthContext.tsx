import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { UserDTO } from "@foresight/contract";

import {
  clearToken,
  getToken,
  getUser,
  onAuthChange,
  setSession,
  setUser as persistUser,
} from "../api/auth";

interface AuthState {
  token: string | null;
  user: UserDTO | null;
  isAuthenticated: boolean;
  signIn: (token: string, user: UserDTO) => void;
  updateUser: (user: UserDTO) => void;
  signOut: () => void;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => getToken());
  const [user, setUser] = useState<UserDTO | null>(() => getUser());

  // Re-sync whenever the underlying storage changes (e.g. 401 clears the token).
  useEffect(() => {
    return onAuthChange(() => {
      setToken(getToken());
      setUser(getUser());
    });
  }, []);

  const signIn = useCallback((nextToken: string, nextUser: UserDTO) => {
    setSession(nextToken, nextUser);
    setToken(nextToken);
    setUser(nextUser);
  }, []);

  const updateUser = useCallback((nextUser: UserDTO) => {
    persistUser(nextUser);
    setUser(nextUser);
  }, []);

  const signOut = useCallback(() => {
    clearToken();
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      token,
      user,
      isAuthenticated: token !== null,
      signIn,
      updateUser,
      signOut,
    }),
    [token, user, signIn, updateUser, signOut],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
