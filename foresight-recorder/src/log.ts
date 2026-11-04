/**
 * Minimal structured logger (no external deps).
 *
 * Two output modes, chosen once at boot from whether stdout is a terminal:
 *   - piped/redirected → one JSON line per event, exactly as before, so logs
 *     stay greppable and ingestible.
 *   - interactive TTY  → the aligned, coral-themed rendering in console.ts.
 * The record is identical either way; only the presentation differs. Force one
 * with LOG_PRETTY=0|1.
 */
import { formatEntry, prettyEnabled, type Level } from "./console.js";

const LEVEL_ORDER: Record<Level, number> = {
  trace: 5,
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};
const threshold = LEVEL_ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVEL_ORDER.info;

/** Decided once: process.stdout.isTTY does not change mid-run. */
const pretty = prettyEnabled(process.stdout);

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const out = level === "error" || level === "warn" || level === "fatal" ? process.stderr : process.stdout;
  if (pretty) {
    out.write(formatEntry({ time: Date.now(), level, msg, fields }) + "\n");
    return;
  }
  const line = { t: new Date().toISOString(), level, msg, ...fields };
  out.write(JSON.stringify(line) + "\n");
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Child logger that prefixes a fixed set of fields on every line. */
  child(bound: Record<string, unknown>): Logger;
}

function make(bound: Record<string, unknown>): Logger {
  const at =
    (level: Level) =>
    (msg: string, fields?: Record<string, unknown>): void =>
      emit(level, msg, { ...bound, ...fields });
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: (b: Record<string, unknown>) => make({ ...bound, ...b }),
  };
}

export const log: Logger = make({});

/** True when the human-readable renderer is active (banner printing hinges on it). */
export const isPretty = pretty;
