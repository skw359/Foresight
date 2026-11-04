/**
 * Foresight Security — server-side recording helpers (pure, no I/O).
 *
 * Shared by foresight-server (which generates playlists + coverage from the
 * on-disk segment files) and foresight-recorder (filename scheme + status).
 * Everything here is dependency-free and browser-safe so it can also be imported
 * by the web dashboard if needed.
 *
 * On-disk segments are the single source of truth. ffmpeg names each segment by
 * its UTC wall-clock start via `-strftime 1` + `seg_%Y%m%d%H%M%S.ts`, so the
 * filename alone tells us when a segment begins; the server parses that stamp to
 * an epoch and synthesizes HLS playlists on demand for any [from,to] window.
 *
 * Why a YYYYMMDDHHMMSS stamp and not `%s` (epoch seconds): `%s` is a POSIX
 * strftime extension the Windows C runtime does not implement, so ffmpeg fails
 * ("Could not get segment filename with strftime") and writes nothing on the
 * Windows-native host this project targets. The broken-out UTC fields are
 * standard strftime and portable across Windows and Linux.
 */

/** Prefix every HLS segment filename carries (see ffmpeg `-hls_segment_filename`). */
export const SEGMENT_PREFIX = "seg_";
/** Extension for MPEG-TS HLS segments. */
export const SEGMENT_EXT = ".ts";
/** Nominal segment length in seconds (ffmpeg `-hls_time`). Used as a fallback. */
export const DEFAULT_SEGMENT_SECONDS = 6;

/** Filename of the rolling live playlist ffmpeg maintains per camera. */
export const LIVE_PLAYLIST = "live.m3u8";

/**
 * Build the canonical segment filename for a wall-clock start epoch (seconds):
 * `seg_<YYYYMMDDHHMMSS>.ts` in UTC, matching ffmpeg's `-strftime` output.
 */
export function segmentName(epochSeconds: number): string {
  return `${SEGMENT_PREFIX}${utcStamp(Math.floor(epochSeconds))}${SEGMENT_EXT}`;
}

/** Format epoch seconds as a UTC `YYYYMMDDHHMMSS` stamp (ffmpeg `-strftime` form). */
function utcStamp(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    p(d.getUTCFullYear(), 4) +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds())
  );
}

/**
 * Parse a segment filename back to its start epoch (seconds), or null when the
 * name is not a well-formed `seg_<YYYYMMDDHHMMSS>.ts` (UTC). The strict 14-digit
 * shape doubles as a path-traversal guard: any name with separators, `..`, or a
 * wrong length fails to parse. Impossible dates (e.g. month 13) are rejected by
 * requiring the parsed epoch to round-trip back to the exact same filename.
 */
export function parseSegmentName(name: string): number | null {
  const m = /^seg_(\d{14})\.ts$/.exec(name);
  if (!m) return null;
  const s = m[1]!;
  const epochMs = Date.UTC(
    Number(s.slice(0, 4)),
    Number(s.slice(4, 6)) - 1,
    Number(s.slice(6, 8)),
    Number(s.slice(8, 10)),
    Number(s.slice(10, 12)),
    Number(s.slice(12, 14)),
  );
  if (Number.isNaN(epochMs)) return null;
  const epoch = Math.floor(epochMs / 1000);
  if (!Number.isSafeInteger(epoch)) return null;
  return segmentName(epoch) === name ? epoch : null;
}

/** A segment as discovered on disk: its start epoch, filename, and size. */
export interface SegmentRef {
  /** Wall-clock start, epoch SECONDS (parsed from the segment's UTC stamp). */
  epoch: number;
  /** Filename only, e.g. `seg_20260620194147.ts` (UTC YYYYMMDDHHMMSS). */
  name: string;
  /** File size in bytes (0 when unknown). */
  bytes: number;
  /**
   * Present when this segment lives INSIDE a consolidated day file rather than
   * as its own file: the byte window to serve/request out of `container`.
   */
  byteRange?: { offset: number; length: number };
  /** The consolidated day file holding this segment (e.g. `day_20260718.ts`). */
  container?: string;
}

/** A segment prepared for playlist emission, with its computed duration. */
export interface PlaylistSegment {
  name: string;
  /** Start, epoch seconds. */
  epoch: number;
  /** EXTINF duration in seconds. */
  duration: number;
  /** True when a gap/geometry break precedes this segment (→ DISCONTINUITY). */
  discontinuity: boolean;
  /** Carried through from SegmentRef for consolidated segments (BYTERANGE). */
  byteRange?: { offset: number; length: number };
  /** Carried through from SegmentRef: the day file the byte range points into. */
  container?: string;
}

export interface ComputeSegmentsOptions {
  /** Nominal segment length; used for the final segment + as a sanity bound. */
  segmentSeconds?: number;
  /** A gap larger than this (seconds) between segments marks a discontinuity. */
  gapToleranceSeconds?: number;
}

/**
 * Turn raw on-disk segment refs into playlist segments: sort by time, derive
 * each segment's duration from the start of the next one (clamped to a sane
 * range so a clock blip can't emit a 3-hour EXTINF), and flag discontinuities
 * across gaps. Pure + deterministic so it can be unit-tested directly.
 */
export function computeSegments(
  refs: SegmentRef[],
  opts: ComputeSegmentsOptions = {},
): PlaylistSegment[] {
  const segmentSeconds = opts.segmentSeconds ?? DEFAULT_SEGMENT_SECONDS;
  const gapTolerance = opts.gapToleranceSeconds ?? Math.max(1, segmentSeconds * 0.5);
  const sorted = [...refs].sort((a, b) => a.epoch - b.epoch);
  const out: PlaylistSegment[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const next = sorted[i + 1];
    let duration = segmentSeconds;
    if (next) {
      const delta = next.epoch - cur.epoch;
      // A delta close to the nominal length means contiguous capture; anything
      // far outside that means a gap follows (handled as the next segment's
      // discontinuity), so fall back to the nominal length here.
      duration = delta > 0 && delta <= segmentSeconds * 2 ? delta : segmentSeconds;
    }
    const prev = out[out.length - 1];
    const discontinuity = prev
      ? cur.epoch - (prev.epoch + prev.duration) > gapTolerance
      : false;
    out.push({
      name: cur.name,
      epoch: cur.epoch,
      duration,
      discontinuity,
      ...(cur.byteRange ? { byteRange: cur.byteRange, container: cur.container } : {}),
    });
  }
  return out;
}

export interface RenderPlaylistOptions {
  /** `range` emits a finite VOD playlist (ENDLIST); `live` emits a rolling one. */
  mode: "live" | "range";
  /** Maps a segment filename to the URI written into the playlist. */
  uri: (name: string) => string;
  /** EXT-X-MEDIA-SEQUENCE of the first segment (default 0). */
  mediaSequence?: number;
  /** Override the nominal segment length used for the final EXTINF. */
  segmentSeconds?: number;
  /** Gap tolerance forwarded to computeSegments when refs are passed. */
  gapToleranceSeconds?: number;
}

/**
 * Render an HLS playlist (m3u8) from on-disk segments. Accepts either raw
 * `SegmentRef[]` (durations/discontinuities computed here) or already-computed
 * `PlaylistSegment[]`. Emits PROGRAM-DATE-TIME for wall-clock seeking and
 * DISCONTINUITY markers across gaps; `range` mode appends ENDLIST.
 */
export function renderPlaylist(
  segments: SegmentRef[] | PlaylistSegment[],
  opts: RenderPlaylistOptions,
): string {
  const computed: PlaylistSegment[] = isComputed(segments)
    ? segments
    : computeSegments(segments, {
        segmentSeconds: opts.segmentSeconds,
        gapToleranceSeconds: opts.gapToleranceSeconds,
      });

  const targetDuration = computed.reduce((max, s) => Math.max(max, s.duration), 0);
  // EXT-X-BYTERANGE (consolidated day files) requires protocol version 4;
  // plain per-file playlists stay at 3 so nothing changes for old footage.
  const version = computed.some((s) => s.byteRange) ? 4 : 3;
  const lines: string[] = [
    "#EXTM3U",
    `#EXT-X-VERSION:${version}`,
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(targetDuration))}`,
    `#EXT-X-MEDIA-SEQUENCE:${opts.mediaSequence ?? 0}`,
  ];
  if (opts.mode === "range") {
    lines.push("#EXT-X-PLAYLIST-TYPE:VOD");
  }

  for (const seg of computed) {
    if (seg.discontinuity) lines.push("#EXT-X-DISCONTINUITY");
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(seg.epoch * 1000).toISOString()}`);
    lines.push(`#EXTINF:${seg.duration.toFixed(3)},`);
    if (seg.byteRange) {
      // Explicit offset every time: sub-range requests must never depend on the
      // previous entry (players may seek straight to any segment).
      lines.push(`#EXT-X-BYTERANGE:${seg.byteRange.length}@${seg.byteRange.offset}`);
      lines.push(opts.uri(seg.container ?? seg.name));
    } else {
      lines.push(opts.uri(seg.name));
    }
  }

  if (opts.mode === "range") lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

function isComputed(
  segments: SegmentRef[] | PlaylistSegment[],
): segments is PlaylistSegment[] {
  return segments.length === 0 || "duration" in segments[0]!;
}

/** A contiguous run of footage, derived from gaps between segments. */
export interface CoverageSpan {
  /** Epoch seconds, inclusive. */
  startEpoch: number;
  /** Epoch seconds, exclusive (last segment start + its duration). */
  endEpoch: number;
  segments: number;
  bytes: number;
}

/**
 * Collapse segment refs into contiguous coverage spans (oldest first). A gap
 * larger than `gapToleranceSeconds` between consecutive segments starts a new
 * span. Used by the coverage endpoint and the timeline UI.
 */
export function coverageSpans(
  refs: SegmentRef[],
  opts: ComputeSegmentsOptions = {},
): CoverageSpan[] {
  // Index byte sizes by filename ONCE so span accumulation stays O(n).
  // (A per-segment `refs.find(...)` here is O(n²): at 24/7 recording with
  // 14-day retention a camera holds ~200k segments, and 200k × 200k linear
  // scans are tens of billions of comparisons — minutes of blocked event
  // loop for a single coverage request.)
  const bytesByName = new Map<string, number>();
  for (const r of refs) bytesByName.set(r.name, r.bytes);

  const segs = computeSegments(refs, opts);
  const spans: CoverageSpan[] = [];
  for (const seg of segs) {
    const bytes = bytesByName.get(seg.name) ?? 0;
    const last = spans[spans.length - 1];
    if (!last || seg.discontinuity) {
      spans.push({
        startEpoch: seg.epoch,
        endEpoch: seg.epoch + seg.duration,
        segments: 1,
        bytes,
      });
    } else {
      last.endEpoch = seg.epoch + seg.duration;
      last.segments += 1;
      last.bytes += bytes;
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Consolidated day files
//
// Old UTC days are consolidated by the recorder into ONE MPEG-TS file per
// camera per day — a raw byte concatenation of that day's seg_*.ts in epoch
// order — plus a small JSON index mapping each original segment to its byte
// window. MPEG-TS concatenates cleanly (every segment starts with PAT/PMT and
// a keyframe via `independent_segments`), so serving [offset, offset+bytes)
// out of the day file is byte-identical to serving the old segment file, and
// playlists reference the windows via #EXT-X-BYTERANGE (HLS v4).
//
// CRASH-SAFETY INVARIANT shared by writer and readers: the presence of the
// .json index flips authority for that day to the day file. Until the index is
// renamed into place the loose segments remain authoritative (a bare day .ts
// without an index is a crash leftover to be rebuilt); once it exists, loose
// segments listed in it are deletable leftovers, and readers seeing a segment
// both loose and indexed must prefer the index entry.
// ---------------------------------------------------------------------------

/** Prefix of consolidated day files + their indexes (`day_<YYYYMMDD>`). */
export const DAY_PREFIX = "day_";
/** Extension of the day index sitting beside the day file. */
export const DAY_INDEX_EXT = ".json";

/** Format epoch seconds as the UTC `YYYYMMDD` stamp of the day it falls in. */
export function utcDayStamp(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  return p(d.getUTCFullYear(), 4) + p(d.getUTCMonth() + 1) + p(d.getUTCDate());
}

/** Canonical day-file name for a `YYYYMMDD` stamp, e.g. `day_20260718.ts`. */
export function dayFileName(dayStamp: string): string {
  return `${DAY_PREFIX}${dayStamp}${SEGMENT_EXT}`;
}

/** Canonical index name beside a day file, e.g. `day_20260718.json`. */
export function dayIndexFileName(dayStamp: string): string {
  return `${DAY_PREFIX}${dayStamp}${DAY_INDEX_EXT}`;
}

/**
 * Parse a day-file name back to the epoch (seconds) of the UTC day's START, or
 * null when the name is not a well-formed `day_<YYYYMMDD>.ts`. Like
 * parseSegmentName, the strict shape doubles as a path-traversal guard, and
 * impossible dates are rejected by requiring an exact round-trip.
 */
export function parseDayFileName(name: string): number | null {
  const m = /^day_(\d{8})\.ts$/.exec(name);
  if (!m) return null;
  const s = m[1]!;
  const epochMs = Date.UTC(
    Number(s.slice(0, 4)),
    Number(s.slice(4, 6)) - 1,
    Number(s.slice(6, 8)),
  );
  if (Number.isNaN(epochMs)) return null;
  const epoch = Math.floor(epochMs / 1000);
  if (!Number.isSafeInteger(epoch)) return null;
  return dayFileName(utcDayStamp(epoch)) === name ? epoch : null;
}

/** One original segment's byte window inside a consolidated day file. */
export interface DayIndexSegment {
  /** Wall-clock start, epoch SECONDS (from the original seg_* filename). */
  epoch: number;
  /** Byte offset of this segment's first byte in the day file. */
  offset: number;
  /** Byte length of this segment inside the day file. */
  bytes: number;
  /**
   * Duration in seconds as computed at consolidation time (same next-epoch
   * rule as computeSegments). Informational — readers recompute from epochs.
   */
  duration: number;
}

/** The JSON index written beside a consolidated day file. */
export interface DayIndex {
  version: 1;
  /** UTC day stamp `YYYYMMDD` — every segment's epoch falls in this day. */
  day: string;
  /** The day file this index describes (always `dayFileName(day)`). */
  file: string;
  /** Total size of the day file; equals the last segment's offset + bytes. */
  totalBytes: number;
  /** Epoch-ascending, byte-contiguous from offset 0. */
  segments: DayIndexSegment[];
}

/**
 * Strict structural validation of a parsed day index. Readers trust a valid
 * index enough to serve byte ranges and delete leftover loose segments, so
 * this rejects anything that doesn't uphold the v1 invariants: exact filename
 * round-trip, epochs strictly ascending and inside the stamped day, and byte
 * windows contiguous from 0 summing to totalBytes.
 */
export function isDayIndex(x: unknown): x is DayIndex {
  if (typeof x !== "object" || x === null) return false;
  const idx = x as Record<string, unknown>;
  if (idx.version !== 1) return false;
  if (typeof idx.day !== "string" || !/^\d{8}$/.test(idx.day)) return false;
  const dayEpoch = parseDayFileName(dayFileName(idx.day));
  if (dayEpoch === null) return false; // impossible date (e.g. month 13)
  if (idx.file !== dayFileName(idx.day)) return false;
  if (!Number.isSafeInteger(idx.totalBytes) || (idx.totalBytes as number) < 0) return false;
  if (!Array.isArray(idx.segments)) return false;

  let expectedOffset = 0;
  let prevEpoch = -Infinity;
  for (const s of idx.segments as unknown[]) {
    if (typeof s !== "object" || s === null) return false;
    const seg = s as Record<string, unknown>;
    const { epoch, offset, bytes, duration } = seg;
    if (!Number.isSafeInteger(epoch)) return false;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0) return false;
    if (!Number.isSafeInteger(bytes) || (bytes as number) <= 0) return false;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) return false;
    if ((epoch as number) <= prevEpoch) return false;
    if (utcDayStamp(epoch as number) !== idx.day) return false;
    if (offset !== expectedOffset) return false;
    expectedOffset = (offset as number) + (bytes as number);
    prevEpoch = epoch as number;
  }
  return expectedOffset === idx.totalBytes;
}

/**
 * Expand a day index into SegmentRefs carrying their byte windows, ready to be
 * merged with loose segments and fed to computeSegments/renderPlaylist/
 * coverageSpans. Names are the canonical seg_* names rebuilt from each epoch,
 * so deduping against a not-yet-deleted loose copy of the same segment (crash
 * leftover) works by name/epoch equality — prefer the index entry.
 */
export function dayIndexToRefs(index: DayIndex): SegmentRef[] {
  return index.segments.map((s) => ({
    epoch: s.epoch,
    name: segmentName(s.epoch),
    bytes: s.bytes,
    byteRange: { offset: s.offset, length: s.bytes },
    container: index.file,
  }));
}
