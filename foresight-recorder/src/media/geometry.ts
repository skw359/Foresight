/**
 * Output-geometry policy: which resolution a camera's segments are ENCODED at,
 * independent of the resolution its frames happen to arrive at.
 *
 * The SFU forwards whichever simulcast layer it likes, and the publisher scales
 * each layer down under uplink/CPU pressure, so the frames arriving for one
 * camera routinely change size mid-recording (observed in one hour on a single
 * phone: 1920x1080 → 1280x720 → 320x180 → 640x360 → 240x135 → 480x270 →
 * 960x540). ffmpeg's rawvideo input geometry is fixed, so the recorder must
 * respawn the encoder on every such change.
 *
 * Without a stable target, segments on disk would carry whatever geometry was
 * live at the time, which breaks `clip.mp4` exports: an MP4 track declares ONE
 * resolution, so a `-c copy` remux of a mixed range inherits the FIRST piece's
 * size — a 320x180 download of footage that ran at 960x540 seconds later. Every
 * segment is therefore encoded at one stable TARGET geometry per camera and the
 * incoming frames are scaled onto it (see buildHlsArgs), so the whole tree
 * remuxes as one continuous stream.
 */

export interface Geometry {
  w: number;
  h: number;
}

/** yuv420p needs even dimensions on both axes; round DOWN so we never invent pixels. */
export function evenGeometry(g: Geometry): Geometry {
  return { w: Math.max(2, g.w - (g.w % 2)), h: Math.max(2, g.h - (g.h % 2)) };
}

/**
 * Clamp a target to `maxHeight`, preserving aspect ratio. `maxHeight <= 0`
 * means "no cap" — the escape hatch for a host that cannot sustain a continuous
 * encode at the camera's full resolution (a 4K publisher on software libx264).
 */
export function capGeometry(g: Geometry, maxHeight: number): Geometry {
  if (maxHeight <= 0 || g.h <= maxHeight || g.h <= 0) return evenGeometry(g);
  return evenGeometry({ w: Math.round((g.w * maxHeight) / g.h), h: maxHeight });
}

/**
 * Pick the encode target for a camera.
 *
 * `declared` is the publication's own geometry from the SFU's TrackInfo — the
 * resolution the phone says it is publishing (the top simulcast layer, or the
 * single layer of the non-simulcast 4K preset). That is the resolution the
 * footage SHOULD be, so it wins whenever the SFU reports it.
 *
 * `largestSeen` is the fallback for a publication that declares nothing: the
 * biggest frame observed so far, which is monotonic and so settles quickly
 * instead of tracking every layer switch.
 */
export function resolveTargetGeometry(opts: {
  declared: Geometry | null;
  largestSeen: Geometry;
  maxHeight: number;
}): Geometry {
  const declared = opts.declared;
  const base = declared && declared.w > 0 && declared.h > 0 ? declared : opts.largestSeen;
  return capGeometry(base, opts.maxHeight);
}

/** True when `candidate` covers more pixels than `current` (used to track largestSeen). */
export function isLarger(candidate: Geometry, current: Geometry | null): boolean {
  if (!current) return true;
  return candidate.w * candidate.h > current.w * current.h;
}
