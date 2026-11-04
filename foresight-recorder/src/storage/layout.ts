/**
 * On-disk layout for recordings. Shared scheme with foresight-server (which
 * reads this tree back to serve playlists/segments):
 *
 *   <recordingsDir>/<homeId>/<cameraId>/<YYYY>/<MM>/<DD>/seg_<epoch>.ts
 *   <recordingsDir>/<homeId>/<cameraId>/live.m3u8
 *
 * ffmpeg is spawned with TZ=UTC (see media/ffmpeg.ts) so the YYYY/MM/DD buckets
 * are UTC and the server can map a segment's epoch to its bucket deterministically.
 */
import path from "node:path";
import { LIVE_PLAYLIST } from "@foresight/contract";
import { config } from "../config.js";

/** Directory holding a single camera's segments + live playlist. */
export function cameraDir(homeId: string, cameraId: string): string {
  return path.join(config.recordingsDir, homeId, cameraId);
}

/** The rolling live playlist ffmpeg maintains for a camera. */
export function livePlaylistPath(homeId: string, cameraId: string): string {
  return path.join(cameraDir(homeId, cameraId), LIVE_PLAYLIST);
}

/**
 * The `-hls_segment_filename` template passed to ffmpeg. With `-strftime 1`
 * ffmpeg expands %Y/%m/%d to the (UTC) date for the bucket dirs and
 * %Y%m%d%H%M%S to the (UTC) start time in the filename; `-strftime_mkdir 1`
 * creates the date directories itself.
 *
 * NOTE: we deliberately do NOT use %s (epoch seconds). %s is a POSIX strftime
 * extension the Windows C runtime lacks, so ffmpeg fails with "Could not get
 * segment filename with strftime" and writes nothing on Windows. The broken-out
 * UTC fields are standard strftime; @foresight/contract's parseSegmentName
 * converts the stamp back to an epoch.
 */
export function segmentTemplate(homeId: string, cameraId: string): string {
  return path.join(cameraDir(homeId, cameraId), "%Y", "%m", "%d", "seg_%Y%m%d%H%M%S.ts");
}
