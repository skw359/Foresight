/**
 * Decide how a clip export must be muxed: losslessly copied, or re-encoded onto
 * one geometry.
 *
 * An MP4 track declares ONE resolution. Concatenated MPEG-TS pieces do not have
 * to agree on one, and historically did not: the recorder used to write whatever
 * resolution the SFU was forwarding at the time, so a single camera-day held runs
 * of 1280x720, 960x540, 480x270 and 320x180. Remuxing such a range with `-c copy`
 * produces a file whose header claims the FIRST piece's size for the whole clip —
 * the "downloads at a tiny resolution" bug.
 *
 * The recorder now pins its subscription and encodes every segment for a camera
 * at one geometry, so new footage is uniform and takes the fast copy path. Older
 * footage, and any range straddling that change, is re-encoded onto the largest
 * geometry in the range instead — ffmpeg reinitializes its filter graph when the
 * decoded frame size changes, so one pass normalizes the whole range.
 */
import fsp from "node:fs/promises";
import { SPS_SEARCH_BYTES, spsDimensions, findSpsInTs, type Dimensions } from "./h264.js";
import type { ClipPiece } from "./recordings.js";

/**
 * Cap on how many pieces are inspected. Every realistic export stays well under
 * it (an hour of 6s segments is 600 pieces); a multi-day range is sampled evenly
 * instead, which can only mean an unsampled excursion is missed — never a wrong
 * scale target, since the target is the largest geometry actually observed.
 */
export const MAX_PROBED_PIECES = 4096;

export interface ClipEncodePlan {
  /** Every inspected piece decodes at one size → safe to `-c copy`. */
  uniform: boolean;
  /** Largest geometry observed; the scale target when `uniform` is false. */
  target: Dimensions | null;
  /** How many distinct geometries were seen (diagnostics). */
  distinct: number;
  /** Pieces whose SPS could not be read; ignored for the decision. */
  unreadable: number;
  /** How many pieces were actually inspected (≤ MAX_PROBED_PIECES). */
  probed: number;
}

/** Evenly-spaced sample of `pieces`, always including the first and last. */
function sample<T>(pieces: T[], limit: number): T[] {
  if (pieces.length <= limit) return pieces;
  const step = (pieces.length - 1) / (limit - 1);
  const out: T[] = [];
  for (let i = 0; i < limit; i++) out.push(pieces[Math.round(i * step)]!);
  return out;
}

/** Read the leading bytes of a piece (a whole file, or a window of a day file). */
async function readPieceHead(piece: ClipPiece): Promise<Uint8Array | null> {
  const available =
    piece.start !== undefined && piece.end !== undefined
      ? piece.end - piece.start + 1
      : SPS_SEARCH_BYTES;
  const length = Math.min(SPS_SEARCH_BYTES, Math.max(0, available));
  if (length === 0) return null;
  let fh;
  try {
    fh = await fsp.open(piece.path, "r");
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, piece.start ?? 0);
    return bytesRead > 0 ? buf.subarray(0, bytesRead) : null;
  } catch {
    // Retention may prune underneath an in-flight export; treat as unknown.
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * Inspect the pieces of a clip and decide copy-vs-re-encode. Pure I/O — never
 * throws; anything unreadable degrades to "unknown" so an export still happens.
 */
export async function planClipEncode(pieces: ClipPiece[]): Promise<ClipEncodePlan> {
  const probedPieces = sample(pieces, MAX_PROBED_PIECES);
  // The SPS bytes are only a parse cache — a range is usually a handful of long
  // runs, so this parses once per encoder run rather than once per segment.
  const dimsBySps = new Map<string, Dimensions | null>();
  // The DECISION keys on the geometry, not the SPS bytes: two encoder runs at
  // the same size may differ cosmetically, and that is not a reason to spend a
  // full transcode re-encoding footage to the resolution it already has.
  const geometries = new Set<string>();
  let unreadable = 0;
  let target: Dimensions | null = null;

  for (const piece of probedPieces) {
    const head = await readPieceHead(piece);
    const sps = head ? findSpsInTs(head) : null;
    if (!sps) {
      unreadable++;
      continue;
    }
    const key = Buffer.from(sps).toString("base64");
    let dims = dimsBySps.get(key);
    if (dims === undefined) {
      dims = spsDimensions(sps);
      dimsBySps.set(key, dims);
    }
    if (!dims) {
      unreadable++;
      continue;
    }
    geometries.add(`${dims.w}x${dims.h}`);
    if (!target || dims.w * dims.h > target.w * target.h) target = dims;
  }

  return {
    uniform: geometries.size <= 1,
    target,
    distinct: geometries.size,
    unreadable,
    probed: probedPieces.length,
  };
}

/**
 * Encode args that flatten a mixed-geometry range onto `target`. ffmpeg
 * reinitializes the filter graph when the decoded frame size changes mid-stream,
 * so one pass normalizes the whole range; letterboxing (rather than stretching)
 * keeps a layer switch that also changed the aspect ratio from distorting.
 * Mirrors the recorder's own scale chain in foresight-recorder/src/media/ffmpeg.ts —
 * the two stay independent by design: the recorder prevents this case, this
 * repairs footage recorded before it did.
 */
function normalizeArgs(target: Dimensions): string[] {
  const { w, h } = target;
  return [
    "-vf",
    [
      `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic`,
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
      "setsar=1",
    ].join(","),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    // Video-only recordings; -an keeps a stray audio PID out of the export.
    "-an",
  ];
}

/**
 * The mux half of the plan: `-c copy` for a uniform range (the fast path every
 * export takes once the footage was recorded at one geometry), otherwise the
 * normalizing re-encode. Kept next to planClipEncode so the decision and its
 * consequence cannot drift apart.
 */
export function clipMuxArgs(plan: ClipEncodePlan): string[] {
  if (plan.uniform || plan.target === null) return ["-c", "copy"];
  return normalizeArgs(plan.target);
}
