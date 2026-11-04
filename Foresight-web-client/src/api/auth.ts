/**
 * JWT + user persistence for the dashboard. The bearer token from
 * /auth/register and /auth/login is stored in localStorage and attached to
 * authenticated requests by the API client.
 */
import type { UserDTO } from "@foresight/contract";

const TOKEN_KEY = "foresight.token";
const USER_KEY = "foresight.user";

type Listener = () => void;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

/** Subscribe to auth changes (login/logout). Returns an unsubscribe fn. */
export function onAuthChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getUser(): UserDTO | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as UserDTO) : null;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: UserDTO): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* storage may be unavailable (private mode); session stays in-memory only */
  }
  emit();
}

/** Replace the stored user (e.g. after a profile edit) without touching the token. */
export function setUser(user: UserDTO): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* storage may be unavailable; in-memory listeners still get notified */
  }
  emit();
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
  emit();
}

export function isAuthenticated(): boolean {
  return getToken() !== null;
}
