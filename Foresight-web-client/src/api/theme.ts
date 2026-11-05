export type Theme = "light" | "dark";

export const THEME_KEY = "foresight.theme";

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
