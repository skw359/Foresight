/**
 * Shared formatting + conversion helpers for the recordings UI (the panel list
 * and the player popup both render the same span metadata).
 */

/** epoch-seconds string for an ISO timestamp (what the recordings API expects). */
export function epoch(iso: string): string {
  return String(Math.floor(Date.parse(iso) / 1000));
}

export function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Human duration between two ISO timestamps, e.g. "1h 32m", "5m", "48s". */
export function fmtDuration(startIso: string, endIso: string): string {
  const totalSec = Math.max(0, Math.round((Date.parse(endIso) - Date.parse(startIso)) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

const DAY_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DAY_TIME_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "Fri, Jun 20" — the day a span started. */
export function fmtDay(iso: string): string {
  return DAY_FMT.format(new Date(iso));
}

/** "2:15 PM – 3:47 PM", expanding to include dates when the span crosses midnight. */
export function fmtRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  return sameDay
    ? `${TIME_FMT.format(start)} – ${TIME_FMT.format(end)}`
    : `${DAY_TIME_FMT.format(start)} – ${DAY_TIME_FMT.format(end)}`;
}
