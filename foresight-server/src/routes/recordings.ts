/**
 * Recording playback routes. All are session-guarded and reuse
 * requireCameraAccess, so footage is only ever served to Home members. The
 * segment tree is the source of truth: playlists are SYNTHESIZED on demand for
 * any [from,to] window (live tail or historical range) rather than stored.
 *
 * Routes:
 *   GET /cameras/:cameraId/recordings?from&to        → coverage summary
 *   GET /recordings/:cameraId/playlist.m3u8?...       → generated HLS playlist
 *   GET /recordings/:cameraId/seg/:name               → one segment OR day file (.ts)
 *   GET /recordings/:cameraId/clip.mp4?from&to        → remuxed range download
 *
 * Playback in the web client uses hls.js; it attaches the bearer token via
 * xhrSetup, so the same guard protects the playlist AND every segment it lists.
 *
 * Consolidated days: playlists for old footage reference ONE `day_<D>.ts` per
 * day with #EXT-X-BYTERANGE windows (HLS v4), so the seg route accepts both
 * seg_*.ts and day_*.ts names and speaks single-range HTTP Range for the
 * latter. A seg_*.ts that no longer exists loose is looked up in its day index
 * and served as its exact byte slice — players holding a pre-consolidation
 * playlist keep working.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import {
  DEFAULT_SEGMENT_SECONDS,
  coverageSpans,
  parseDayFileName,
  parseSegmentName,
  renderPlaylist,
  type DeleteRecordingsResponse,
  type RecordingCoverage,
} from "@foresight/contract";
import { config } from "../config.js";
import { requireUser } from "../auth.js";
import { clipMuxArgs, planClipEncode } from "../lib/clipGeometry.js";
import { badRequest, notFound } from "../lib/errors.js";
import { requireCameraAccess } from "../lib/membership.js";
import {
  cameraDir,
  deleteSegments,
  listRecentSegments,
  listSegments,
  listSegmentsCached,
  lookupConsolidatedSegment,
  pipePieces,
  resolveClipPieces,
  safeDayFilePath,
  safeSegmentPath,
} from "../lib/recordings.js";

/** Parse a `from`/`to` query value: epoch seconds OR ISO-8601 → epoch seconds. */
function parseTime(v: unknown): number | undefined {
  if (typeof v !== "string" || v.trim() === "") return undefined;
  if (/^\d+$/.test(v)) return Number(v);
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

function iso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

/** Segments returned for a rolling live playlist window. ~6 × 6s ≈ 36s tail. */
const LIVE_WINDOW_SEGMENTS = 6;

/** Segments + day files are content-addressed by name and never rewritten. */
const IMMUTABLE_CACHE = "private, max-age=31536000, immutable";

/**
 * Parse a single-range `Range: bytes=…` header against a resource of `size`
 * bytes. Returns the inclusive byte window to serve as a 206,
 * "unsatisfiable" for a 416, or null to serve the plain 200 (no header,
 * malformed, or multi-range — hls.js only ever sends single ranges, so a
 * multi-range request just gets the whole file). Forms: `a-b`, `a-` (open
 * end), `-n` (suffix: the last n bytes).
 */
function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (typeof header !== "string") return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;

  if (a === "") {
    // Suffix form: the LAST n bytes. n larger than the file → the whole file.
    const n = Number(b);
    if (!Number.isSafeInteger(n)) return null;
    if (n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }

  const start = Number(a);
  if (!Number.isSafeInteger(start)) return null;
  if (start >= size) return "unsatisfiable";
  if (b === "") return { start, end: size - 1 };
  const end = Number(b);
  if (!Number.isSafeInteger(end) || end < start) return null; // invalid spec → ignore header
  return { start, end: Math.min(end, size - 1) };
}

export async function recordingRoutes(app: FastifyInstance): Promise<void> {
  // Coverage summary: which footage exists, as contiguous spans.
  app.get(
    "/cameras/:cameraId/recordings",
    { preHandler: requireUser },
    async (req): Promise<RecordingCoverage> => {
      const { cameraId } = req.params as { cameraId: string };
      const q = req.query as { from?: string; to?: string };
      const camera = await requireCameraAccess(req.user!.id, cameraId);

      const from = parseTime(q.from);
      const to = parseTime(q.to);
      // Cached full-tree listing (15s TTL): coverage is refetched every page
      // load and a 14-day tree is ~200k files — see listSegmentsCached. The
      // delete route below invalidates, so post-delete coverage is never stale.
      // Consolidated days contribute their index-recorded sizes, so spans and
      // byte totals need no day-file stats at all.
      const refs = await listSegmentsCached(cameraDir(camera.homeId, cameraId), from, to);
      const spans = coverageSpans(refs).map((s) => ({
        start: iso(s.startEpoch),
        end: iso(s.endEpoch),
        segments: s.segments,
        bytes: s.bytes,
      }));
      const totalBytes = refs.reduce((sum, r) => sum + r.bytes, 0);
      return {
        cameraId,
        recordingEnabled: camera.recordingEnabled,
        spans,
        earliest: spans[0]?.start ?? null,
        latest: spans[spans.length - 1]?.end ?? null,
        totalBytes,
      };
    },
  );

  // Permanently delete a [from,to) range of footage (the segments backing one
  // coverage span). Same access guard as playback — only Home members can prune.
  app.delete(
    "/cameras/:cameraId/recordings",
    { preHandler: requireUser },
    async (req): Promise<DeleteRecordingsResponse> => {
      const { cameraId } = req.params as { cameraId: string };
      const q = req.query as { from?: string; to?: string };
      const camera = await requireCameraAccess(req.user!.id, cameraId);

      const from = parseTime(q.from);
      const to = parseTime(q.to);
      if (from === undefined || to === undefined || to <= from) {
        throw badRequest("from and to (epoch seconds or ISO) are required, with to > from");
      }

      const { deletedSegments, deletedBytes } = await deleteSegments(
        cameraDir(camera.homeId, cameraId),
        from,
        to,
      );
      return { cameraId, deletedSegments, deletedBytes };
    },
  );

  // Generated HLS playlist (live tail or historical range).
  app.get(
    "/recordings/:cameraId/playlist.m3u8",
    { preHandler: requireUser },
    async (req, reply) => {
      const { cameraId } = req.params as { cameraId: string };
      const q = req.query as { from?: string; to?: string; mode?: string };
      const camera = await requireCameraAccess(req.user!.id, cameraId);
      const dir = cameraDir(camera.homeId, cameraId);
      const mode = q.mode === "range" ? "range" : "live";

      let refs;
      let mediaSequence = 0;
      if (mode === "range") {
        const from = parseTime(q.from);
        const to = parseTime(q.to);
        // Widen the lower bound by one segment so the segment covering `from` is
        // included (segments are keyed by their START epoch). Served from the
        // 15s listing cache: hls.js re-requests the playlist while scrubbing,
        // and a VOD range doesn't need to see segments newer than that.
        const widenedFrom = from !== undefined ? from - DEFAULT_SEGMENT_SECONDS : undefined;
        refs = await listSegmentsCached(dir, widenedFrom, to);
      } else {
        // Live tail: hls.js refetches this every few seconds, and only the
        // newest ~36s matter, so list just the current UTC day bucket (plus
        // yesterday's briefly after UTC midnight) instead of walking the whole
        // 14-day tree. Deliberately UNcached — a live playlist must advance
        // every ~6s or playback stalls. Byte sizes are skipped (playlists only
        // use epoch + name).
        const all = await listRecentSegments(dir);
        refs = all.slice(Math.max(0, all.length - LIVE_WINDOW_SEGMENTS));
        // Monotonic media sequence derived from wall-clock so pruning the oldest
        // segments never makes the sequence go backwards across refreshes.
        if (refs[0]) mediaSequence = Math.floor(refs[0].epoch / DEFAULT_SEGMENT_SECONDS);
      }

      // Consolidated refs carry byteRange/container, so renderPlaylist emits
      // #EXT-X-BYTERANGE lines and calls uri() with the day-file name — the
      // same seg/ route serves both shapes.
      const m3u8 = renderPlaylist(refs, {
        mode,
        mediaSequence,
        uri: (name) => `seg/${name}`,
      });
      return reply
        .header("Cache-Control", "no-store")
        .type("application/vnd.apple.mpegurl")
        .send(m3u8);
    },
  );

  // One immutable segment — a loose seg_*.ts, or a consolidated day_*.ts (the
  // target of playlist BYTERANGE entries, served with HTTP Range support).
  app.get(
    "/recordings/:cameraId/seg/:name",
    { preHandler: requireUser },
    async (req, reply) => {
      const { cameraId, name } = req.params as { cameraId: string; name: string };
      const camera = await requireCameraAccess(req.user!.id, cameraId);
      const dir = cameraDir(camera.homeId, cameraId);

      // Consolidated day file: hls.js fetches each segment's window with a
      // single `Range: bytes=a-b`, so speak just enough of RFC 9110 for that
      // (plus full 200s so a plain fetch of the file also works).
      if (parseDayFileName(name) !== null) {
        const file = await safeDayFilePath(dir, name);
        if (!file) throw notFound("Segment not found");
        const size = (await fsp.stat(file)).size;
        reply.header("Accept-Ranges", "bytes").header("Cache-Control", IMMUTABLE_CACHE);

        const range = parseByteRange(req.headers.range, size);
        if (range === "unsatisfiable") {
          return reply.code(416).header("Content-Range", `bytes */${size}`).send();
        }
        if (range === null) {
          return reply
            .header("Content-Length", size)
            .type("video/mp2t")
            .send(fs.createReadStream(file));
        }
        return reply
          .code(206)
          .header("Content-Range", `bytes ${range.start}-${range.end}/${size}`)
          .header("Content-Length", range.end - range.start + 1)
          .type("video/mp2t")
          .send(fs.createReadStream(file, { start: range.start, end: range.end }));
      }

      const file = await safeSegmentPath(dir, name);
      if (file) {
        const stat = await fsp.stat(file);
        return reply
          .header("Content-Length", stat.size)
          // Segments are content-addressed by start epoch and never rewritten.
          .header("Cache-Control", IMMUTABLE_CACHE)
          .type("video/mp2t")
          .send(fs.createReadStream(file));
      }

      // Stale-playlist fallback: the segment may have been consolidated into a
      // day file after the playlist referencing it was generated. Serve exactly
      // its byte slice as a plain 200 — such playlists predate BYTERANGE and
      // never send Range headers, so any Range here is deliberately ignored.
      const epoch = parseSegmentName(name);
      if (epoch === null) throw notFound("Segment not found");
      const slice = await lookupConsolidatedSegment(dir, epoch);
      if (!slice) throw notFound("Segment not found");
      return reply
        .header("Content-Length", slice.bytes)
        .header("Cache-Control", IMMUTABLE_CACHE)
        .type("video/mp2t")
        .send(
          fs.createReadStream(slice.dayFilePath, {
            start: slice.offset,
            end: slice.offset + slice.bytes - 1, // createReadStream end is INCLUSIVE
          }),
        );
    },
  );

  // Remux a [from,to] range into a single downloadable MP4 (one-shot ffmpeg).
  // Segment bytes are piped into ffmpeg's stdin in epoch order — consolidated
  // segments as byte windows of their day file, loose ones whole — so no
  // temp concat-list file and no reliance on every segment being its own file.
  //
  // An MP4 track declares ONE resolution, so a range whose segments disagree
  // cannot be copied: the header would claim the first piece's size for the whole
  // clip (footage recorded before the recorder pinned its layer runs anywhere
  // from 320x180 to 1080p within a single day). planClipEncode reads each piece's
  // SPS to tell the two cases apart — uniform ranges still stream out with
  // `-c copy`, mixed ones are re-encoded onto the range's largest geometry.
  app.get(
    "/recordings/:cameraId/clip.mp4",
    { preHandler: requireUser },
    async (req, reply) => {
      const { cameraId } = req.params as { cameraId: string };
      const q = req.query as { from?: string; to?: string };
      const camera = await requireCameraAccess(req.user!.id, cameraId);
      const dir = cameraDir(camera.homeId, cameraId);

      const from = parseTime(q.from);
      const to = parseTime(q.to);
      if (from === undefined || to === undefined || to <= from) {
        throw badRequest("from and to (epoch seconds or ISO) are required, with to > from");
      }

      // Fresh (uncached) listing so a clip export always sees the tree as it
      // is, but skip the stat sweep — only paths/byte windows feed the remux.
      const refs = await listSegments(dir, from - DEFAULT_SEGMENT_SECONDS, to, {
        withBytes: false,
      });
      if (refs.length === 0) throw notFound("No footage in the requested range");

      const pieces = await resolveClipPieces(dir, refs);
      if (pieces.length === 0) throw notFound("No footage in the requested range");

      const plan = await planClipEncode(pieces);
      const muxArgs = clipMuxArgs(plan);
      if (!plan.uniform && plan.target) {
        req.log.info(
          { cameraId, distinct: plan.distinct, target: plan.target, probed: plan.probed },
          "clip range spans multiple geometries — re-encoding to one",
        );
      }

      // The concatenated MPEG-TS pieces are one valid stream (every segment
      // starts with PAT/PMT + keyframe). Fragmented MP4 either way, so the
      // output streams without a seekable destination.
      const ff = spawn(config.ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "mpegts",
        "-i",
        "pipe:0",
        ...muxArgs,
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "-f",
        "mp4",
        "pipe:1",
      ]);

      ff.on("error", (err) => {
        req.log.error({ err }, "clip ffmpeg failed to start");
      });
      ff.stderr.on("data", (d) => req.log.debug({ ff: String(d) }, "clip ffmpeg"));
      // If the client goes away, stop encoding.
      reply.raw.on("close", () => {
        if (!ff.killed) ff.kill("SIGKILL");
      });

      // Feed pieces sequentially with backpressure; stdin ends after the last
      // piece. ffmpeg exiting early (client disconnect → SIGKILL above, or a
      // remux error) surfaces here as EPIPE/premature-close — expected, not an
      // error worth more than a debug line.
      void pipePieces(pieces, ff.stdin).catch((err: unknown) => {
        ff.stdin.destroy();
        const code = (err as NodeJS.ErrnoException)?.code;
        const benign =
          code === "EPIPE" ||
          code === "ECONNRESET" ||
          code === "ERR_STREAM_PREMATURE_CLOSE" ||
          code === "ERR_STREAM_DESTROYED";
        if (benign) req.log.debug({ err }, "clip stdin closed early");
        else req.log.error({ err }, "clip segment piping failed");
      });

      return reply
        .header("Content-Disposition", `attachment; filename="clip-${from}-${to}.mp4"`)
        .type("video/mp4")
        .send(ff.stdout);
    },
  );
}
