/**
 * Fastify/pino wiring for the themed console.
 *
 * pino always produces the same newline-delimited JSON records. When stdout is
 * a terminal we hand it a transform stream that re-renders each record through
 * console.ts; when stdout is a pipe or a file we leave pino alone and the raw
 * JSON goes out untouched, so log shipping and `| grep` are unaffected.
 *
 * Force either mode with LOG_PRETTY=0|1.
 */
import { Writable } from "node:stream";
import { formatEntry, prettyEnabled, type Level } from "./console.js";

/** pino's numeric levels → the names console.ts styles. */
const PINO_LEVELS: Record<number, Level> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

function render(raw: string): void {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Not a pino record (a stray write from a dependency) — pass it through.
    process.stdout.write(raw + "\n");
    return;
  }

  const level = PINO_LEVELS[Number(record.level)] ?? "info";
  const msg = typeof record.msg === "string" ? record.msg : "";

  // Fastify logs one "Server listening at …" per bound address the moment the
  // socket opens, immediately before index.ts prints the banner that lists the
  // same addresses (plus everything else worth knowing). Human mode drops the
  // duplicates; JSON mode never reaches here, so machine consumers keep them.
  if (msg.startsWith("Server listening at ")) return;

  const time = typeof record.time === "number" ? record.time : undefined;
  // formatEntry ignores the structural keys (level/time/msg/pid/hostname/…),
  // so the whole record can go in as fields.
  const line = formatEntry({ time, level, msg, fields: record });

  const out = level === "warn" || level === "error" || level === "fatal" ? process.stderr : process.stdout;
  out.write(line + "\n");
}

/**
 * A pino destination that re-renders records for humans. Buffers across writes
 * so a record split over two chunks is never rendered as garbage.
 */
export function createPrettyStream(): Writable {
  let pending = "";
  return new Writable({
    write(chunk, _encoding, callback): void {
      pending += chunk.toString();
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.trim()) render(line);
        newline = pending.indexOf("\n");
      }
      callback();
    },
    final(callback): void {
      if (pending.trim()) render(pending);
      pending = "";
      callback();
    },
  });
}

/** True when this process is rendering for a human (banner printing hinges on it). */
export const isPretty = prettyEnabled(process.stdout);

/**
 * The `logger` value to hand Fastify. `true` keeps pino's stock JSON on stdout;
 * the object form swaps in the themed renderer.
 */
export function fastifyLogger(): true | { level: string; stream: Writable } {
  if (!isPretty) return true;
  return {
    level: process.env.LOG_LEVEL ?? "info",
    stream: createPrettyStream(),
  };
}
