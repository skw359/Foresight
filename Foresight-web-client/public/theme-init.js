// Apply the saved theme before first paint so a dark-mode reload never flashes
// the light palette. Mirrors src/api/theme.ts (key + data-theme). Kept as an
// external file (not inline) so the dashboard's CSP can forbid inline scripts.
try {
  if (localStorage.getItem("foresight.theme") === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  }
} catch (e) {}
