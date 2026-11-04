/**
 * Foresight console theme — a dependency-free pretty printer for this process's
 * terminal output.
 *
 * MIRRORED FILE. An identical copy lives at:
 *   foresight-server/src/console.ts
 *   foresight-recorder/src/console.ts
 * It imports nothing but `node:process` globals, so keeping the two in sync is a
 * plain file copy. Edit one, copy it over the other.
 *
 * Behaviour
 * ---------
 * - On an interactive TTY it renders aligned, coral-accented lines plus a boot
 *   banner, so `npm run dev:*` is pleasant to watch.
 * - When stdout is a pipe or a file (or NO_COLOR / LOG_PRETTY=0 is set) callers
 *   fall back to their original one-JSON-line-per-event output, so log shipping
 *   and `| grep` keep working exactly as before.
 *
 * Env overrides
 * -------------
 *   LOG_PRETTY=0|1            force the human/JSON choice instead of TTY sniffing
 *   NO_COLOR=<any>            drop all ANSI (honours the no-color.org convention)
 *   FORESIGHT_LOG_COLOR=      off | 256 | full — force the color depth
 *   FORESIGHT_LOG_ASCII=1     swap the box-drawing/glyph characters for ASCII
 *
 * The palette is lifted straight from the dashboard's dark theme
 * (Foresight-web-client/src/styles.css) so the terminal and the UI agree:
 *   #ff634a coral accent · #e0972a warn · #f0564a danger · #34c46f success
 */

export type Level = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

type Rgb = readonly [number, number, number];

/** Dashboard tokens, as RGB triples. */
export const THEME = {
  coral: [255, 99, 74],
  coralDeep: [229, 72, 47],
  coralSoft: [255, 155, 144],
  success: [52, 196, 111],
  warn: [224, 151, 42],
  danger: [240, 86, 74],
  text: [232, 232, 236],
  dim: [154, 154, 162],
  faint: [110, 110, 118],
} as const satisfies Record<string, Rgb>;

// ---------------------------------------------------------------- capability

type ColorMode = "none" | "ansi256" | "truecolor";

function envFlag(name: string): string {
  return (process.env[name] ?? "").trim().toLowerCase();
}

function detectColorMode(): ColorMode {
  const forced = envFlag("FORESIGHT_LOG_COLOR");
  if (forced === "off" || forced === "none" || forced === "0") return "none";
  if (forced === "256" || forced === "ansi256") return "ansi256";
  if (forced === "full" || forced === "truecolor" || forced === "1") return "truecolor";

  if ((process.env.NO_COLOR ?? "") !== "") return "none";
  if (envFlag("TERM") === "dumb") return "none";
  if (!process.stdout.isTTY) return "none";

  const colorterm = envFlag("COLORTERM");
  if (colorterm.includes("truecolor") || colorterm.includes("24bit")) return "truecolor";
  // Windows Terminal, VS Code and iTerm all render 24-bit; so does conhost on
  // Windows 10 1909+, which is the floor for the Node version we require.
  if (process.env.WT_SESSION) return "truecolor";
  if (process.env.TERM_PROGRAM === "vscode" || process.env.TERM_PROGRAM === "iTerm.app") {
    return "truecolor";
  }
  if (process.platform === "win32") return "truecolor";
  if (/-256(color)?$/.test(envFlag("TERM"))) return "ansi256";
  return "truecolor";
}

export const colorMode: ColorMode = detectColorMode();
export const colorEnabled = colorMode !== "none";
export const unicode = envFlag("FORESIGHT_LOG_ASCII") !== "1";

/**
 * Whether to render human output on this stream. Callers emit their raw JSON
 * line when this is false, so redirecting to a file changes the format but
 * never the information.
 */
export function prettyEnabled(stream: { isTTY?: boolean } = process.stdout): boolean {
  const forced = envFlag("LOG_PRETTY");
  if (forced === "0" || forced === "false" || forced === "off") return false;
  if (forced === "1" || forced === "true" || forced === "on") return true;
  return Boolean(stream.isTTY);
}

// -------------------------------------------------------------------- color

const RESET = "\x1b[0m";

/** Nearest xterm-256 index for an RGB triple (6x6x6 cube + gray ramp). */
function to256([r, g, b]: Rgb): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (v: number): number => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

function sgr(params: string, s: string): string {
  return colorEnabled ? `\x1b[${params}m${s}${RESET}` : s;
}

/** Foreground color. Do not nest — the inner reset would clear the outer color. */
export function fg(c: Rgb, s: string): string {
  if (!colorEnabled) return s;
  const params =
    colorMode === "truecolor" ? `38;2;${c[0]};${c[1]};${c[2]}` : `38;5;${to256(c)}`;
  return sgr(params, s);
}

/** Background color with an explicit foreground, for the level/method chips. */
export function chip(bgc: Rgb, fgc: Rgb, s: string): string {
  if (!colorEnabled) return s;
  const b =
    colorMode === "truecolor"
      ? `48;2;${bgc[0]};${bgc[1]};${bgc[2]}`
      : `48;5;${to256(bgc)}`;
  const f =
    colorMode === "truecolor"
      ? `38;2;${fgc[0]};${fgc[1]};${fgc[2]}`
      : `38;5;${to256(fgc)}`;
  return sgr(`${b};${f};1`, s);
}

export function bold(s: string): string {
  return sgr("1", s);
}

// ------------------------------------------------------------------ helpers

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Printable width, ignoring escape sequences. */
export function plainWidth(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

function padEnd(s: string, width: number): string {
  const gap = width - plainWidth(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}

function padStart(s: string, width: number): string {
  const gap = width - plainWidth(s);
  return gap > 0 ? " ".repeat(gap) + s : s;
}

/** Trim to `width`, marking the cut with an ellipsis. */
function clamp(s: string, width: number): string {
  if (s.length <= width) return s;
  return s.slice(0, Math.max(0, width - 1)) + (unicode ? "…" : ".");
}

const GLYPH = {
  bar: unicode ? "│" : "|",
  topLeft: unicode ? "╭" : "+",
  topRight: unicode ? "╮" : "+",
  bottomLeft: unicode ? "╰" : "+",
  bottomRight: unicode ? "╯" : "+",
  horizontal: unicode ? "─" : "-",
  teeLeft: unicode ? "├" : "+",
  teeRight: unicode ? "┤" : "+",
  dot: unicode ? "·" : "-",
  arrow: unicode ? "↳" : ">",
} as const;

const LEVEL_STYLE: Record<Level, { label: string; color: Rgb; glyph: string }> = {
  trace: { label: "trace", color: THEME.faint, glyph: unicode ? "·" : "." },
  debug: { label: "debug", color: THEME.dim, glyph: unicode ? "·" : "." },
  info: { label: "info", color: THEME.coral, glyph: unicode ? "▸" : ">" },
  warn: { label: "warn", color: THEME.warn, glyph: unicode ? "▲" : "!" },
  error: { label: "error", color: THEME.danger, glyph: unicode ? "✖" : "x" },
  fatal: { label: "fatal", color: THEME.danger, glyph: unicode ? "✖" : "X" },
};

const TIME_W = 12;
const LEVEL_W = 5;
const SCOPE_W = 14;
const MSG_W = 40;
/** Stack frames printed under an error before the tail is summarised. */
const STACK_FRAMES = 6;

/**
 * Squash a multi-line message onto one line. Node/Prisma errors arrive with the
 * whole reproduction embedded in `message`; the first meaningful line is what
 * belongs in the aligned column, and the detail still shows up in the trace
 * block underneath.
 */
function oneLine(msg: string): string {
  if (!msg.includes("\n")) return msg;
  const lines = msg.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  return lines.length === 1 ? lines[0] : `${lines[0]} ${unicode ? "…" : "..."}`;
}

function clockOf(time: number | string | undefined): string {
  const d =
    typeof time === "number"
      ? new Date(time)
      : typeof time === "string"
        ? new Date(time)
        : new Date();
  if (Number.isNaN(d.getTime())) return padEnd("", TIME_W);
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// ------------------------------------------------------------------- fields

/** Keys consumed by the line layout itself, never repeated in the field tail. */
const STRUCTURAL = new Set([
  "t",
  "time",
  "level",
  "msg",
  "mod",
  "scope",
  "pid",
  "hostname",
  "name",
  "v",
  "http",
]);

function renderValue(key: string, value: unknown): string {
  if (value === null) return fg(THEME.faint, "null");
  if (value === undefined) return fg(THEME.faint, "undefined");
  if (typeof value === "number" || typeof value === "bigint") {
    return fg(THEME.coralSoft, String(value));
  }
  if (typeof value === "boolean") {
    return fg(value ? THEME.success : THEME.faint, String(value));
  }
  if (typeof value === "string") {
    const looksErr = key === "err" || key === "error" || key === "stack";
    const flat = oneLine(value);
    const body = /[\s"]/.test(flat) ? JSON.stringify(flat) : flat;
    return fg(looksErr ? THEME.danger : THEME.text, body);
  }
  // pino serializes thrown errors to { type, message, stack }; show the human
  // part inline and let stackOf() render the trace underneath.
  if ((key === "err" || key === "error") && typeof value === "object") {
    const e = value as { message?: unknown; type?: unknown; code?: unknown };
    const message = typeof e.message === "string" ? oneLine(e.message) : JSON.stringify(value);
    const rawKind = typeof e.type === "string" ? e.type : typeof e.code === "string" ? e.code : "";
    // A bare "Error:" prefix adds nothing; a real class or errno does.
    const kind = rawKind === "Error" ? "" : rawKind;
    return fg(THEME.danger, kind ? `${kind}: ${message}` : message);
  }
  try {
    return fg(THEME.text, JSON.stringify(value));
  } catch {
    return fg(THEME.text, String(value));
  }
}

/** True when an `err` field would just restate the message pino already lifted. */
function duplicatesMessage(key: string, value: unknown, msg: string): boolean {
  if (key !== "err" && key !== "error") return false;
  if (typeof value === "string") return value === msg;
  if (value && typeof value === "object") {
    const m = (value as { message?: unknown }).message;
    return typeof m === "string" && m === msg;
  }
  return false;
}

function renderFields(fields: Record<string, unknown>, msg: string): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (STRUCTURAL.has(key)) continue;
    if (value === undefined) continue;
    // pino logs a bare Error as msg=<message> plus err={message,…}; printing
    // both says the same thing twice.
    if (duplicatesMessage(key, value, msg)) continue;
    parts.push(`${fg(THEME.faint, key + "=")}${renderValue(key, value)}`);
  }
  return parts.join(" ");
}


/** Pull a printable stack out of whatever shape the error field arrived in. */
function stackOf(fields: Record<string, unknown>): string | null {
  const candidate = fields.err ?? fields.error;
  if (candidate && typeof candidate === "object") {
    const stack = (candidate as { stack?: unknown }).stack;
    if (typeof stack === "string" && stack.includes("\n")) return stack;
  }
  if (typeof fields.stack === "string" && fields.stack.includes("\n")) return fields.stack;
  return null;
}

// --------------------------------------------------------------------- http

export interface HttpFields {
  method?: string;
  url?: string;
  status?: number;
  ms?: number;
}

const METHOD_COLOR: Record<string, Rgb> = {
  GET: THEME.success,
  HEAD: THEME.dim,
  POST: THEME.coral,
  PUT: THEME.warn,
  PATCH: THEME.warn,
  DELETE: THEME.danger,
  OPTIONS: THEME.faint,
};

function statusColor(status: number): Rgb {
  if (status >= 500) return THEME.danger;
  if (status >= 400) return THEME.warn;
  if (status >= 300) return THEME.coralSoft;
  return THEME.success;
}

/** `POST /homes/h_9f2/cameras   201   12ms` — one aligned line per request. */
function renderHttp(http: HttpFields): string {
  const method = (http.method ?? "?").toUpperCase();
  const methodCell = padEnd(fg(METHOD_COLOR[method] ?? THEME.text, method), 7);
  // The path is never truncated — a clipped URL is the one thing you always
  // want back when reading request logs. Long paths just push the columns out.
  const urlCell = padEnd(fg(THEME.text, http.url ?? "/"), 34);
  const status = typeof http.status === "number" ? http.status : 0;
  const statusCell = padStart(status ? fg(statusColor(status), String(status)) : "", 4);
  const msCell =
    typeof http.ms === "number"
      ? padStart(fg(http.ms >= 500 ? THEME.warn : THEME.faint, `${Math.round(http.ms)}ms`), 8)
      : "";
  return `${methodCell}${urlCell}${statusCell}${msCell}`;
}

// -------------------------------------------------------------------- entry

export interface ConsoleEntry {
  time?: number | string;
  level: Level;
  msg: string;
  /** Everything else on the record; `mod`/`scope` becomes the scope column. */
  fields?: Record<string, unknown>;
}

/**
 * Render one log record as an aligned terminal line (no trailing newline).
 *
 *   12:04:31.882 │ ▸ info   room        connected to room        homeId=h_9f2
 */
export function formatEntry(entry: ConsoleEntry): string {
  const fields = entry.fields ?? {};
  const style = LEVEL_STYLE[entry.level] ?? LEVEL_STYLE.info;

  const time = fg(THEME.faint, padEnd(clockOf(entry.time), TIME_W));
  const bar = fg(THEME.coralDeep, GLYPH.bar);
  const level = fg(style.color, `${style.glyph} ${padEnd(style.label, LEVEL_W)}`);

  // Scope column: an explicit `scope`, the recorder's `mod` binding, or "http"
  // for request records (which carry no module of their own).
  const rawScope =
    typeof fields.scope === "string"
      ? fields.scope
      : typeof fields.mod === "string"
        ? fields.mod
        : fields.http
          ? "http"
          : "";
  const scope = rawScope
    ? fg(THEME.coralDeep, padEnd(clamp(rawScope, SCOPE_W), SCOPE_W))
    : " ".repeat(SCOPE_W);

  const http = fields.http as HttpFields | undefined;
  const body = http
    ? renderHttp(http)
    : padEnd(
        fg(
          entry.level === "error" || entry.level === "fatal" ? THEME.danger : THEME.text,
          oneLine(entry.msg),
        ),
        MSG_W,
      );

  const tail = renderFields(fields, entry.msg);
  let line = `${time} ${bar} ${level} ${scope} ${body}${tail ? "  " + tail : ""}`.trimEnd();

  const stack = stackOf(fields);
  if (stack) {
    const indent = " ".repeat(TIME_W + 3);
    // Frames only. The prose part of a stack is already the message, and the
    // frames past the first handful are almost always runtime internals.
    const frames = stack
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("at "));
    const shown = frames.slice(0, STACK_FRAMES);
    const rest = shown.map((l) => `${indent}${fg(THEME.faint, GLYPH.arrow + " " + l)}`);
    if (frames.length > shown.length) {
      rest.push(`${indent}${fg(THEME.faint, `${GLYPH.arrow} +${frames.length - shown.length} more`)}`);
    }
    if (rest.length) line += "\n" + rest.join("\n");
  }
  return line;
}

// ------------------------------------------------------------------- banner

export interface BannerRow {
  label: string;
  value: string;
}

/**
 * A boxed coral banner for process boot. Returns "" when color/pretty output is
 * off so callers can print it unconditionally.
 *
 *   ╭────────────────────────────────────────────╮
 *   │  FORESIGHT · recorder                      │
 *   ├────────────────────────────────────────────┤
 *   │  control     http://127.0.0.1:3399         │
 *   ╰────────────────────────────────────────────╯
 */
export function banner(opts: { subtitle: string; rows: BannerRow[] }): string {
  const title = "FORESIGHT";
  const labelW = Math.max(0, ...opts.rows.map((r) => r.label.length));
  const contentW = Math.max(
    title.length + 3 + opts.subtitle.length,
    ...opts.rows.map((r) => labelW + 2 + r.value.length),
    46,
  );
  const inner = contentW + 4; // two spaces of padding either side

  const rule = GLYPH.horizontal.repeat(inner);
  const top = fg(THEME.coral, `${GLYPH.topLeft}${rule}${GLYPH.topRight}`);
  const mid = fg(THEME.coralDeep, `${GLYPH.teeLeft}${rule}${GLYPH.teeRight}`);
  const bottom = fg(THEME.coral, `${GLYPH.bottomLeft}${rule}${GLYPH.bottomRight}`);
  const edge = fg(THEME.coral, GLYPH.bar);

  const row = (content: string): string => `${edge}  ${padEnd(content, contentW)}  ${edge}`;

  const heading = `${bold(fg(THEME.coral, title))} ${fg(THEME.faint, GLYPH.dot)} ${fg(THEME.text, opts.subtitle)}`;
  const lines = [top, row(heading)];
  if (opts.rows.length) {
    lines.push(mid);
    for (const r of opts.rows) {
      lines.push(row(`${fg(THEME.faint, padEnd(r.label, labelW))}  ${fg(THEME.text, r.value)}`));
    }
  }
  lines.push(bottom);
  return lines.join("\n");
}
