/**
 * Light/dark theme persistence for the dashboard. The user's choice is stored
 * in localStorage and reflected onto <html data-theme="…">, which flips the
 * global CSS custom properties declared in styles.css (the `:root[data-theme=
 * "dark"]` block). Mirrors the storage helpers in api/auth.ts.
 *
 * The default is "light" — the app's original appearance — so existing users
 * see no change until they opt into dark mode from Settings. An inline boot
 * script in index.html applies the same stored value before first paint to
 * avoid a flash of the light theme on reload.
 */
export type Theme = "light" | "dark";

export const THEME_KEY = "foresight.theme";

/** The persisted theme, defaulting to light when unset or storage is blocked. */
export function getStoredTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function setStoredTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage may be unavailable (private mode); theme holds for this session */
  }
}

/**
 * Reflect the theme onto <html> so the global token overrides take effect.
 * Light is the absence of the attribute, keeping the default `:root` palette.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
}
