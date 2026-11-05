/**
 * Process-wide health facts surfaced on /status (and, via the server, on the
 * dashboard): is the configured ffmpeg usable at all?
 */
export const health = {
  ffmpeg: {
    path: "",
    ok: false as boolean,
    /** `ffmpeg -version` first line, or the reason the probe failed. */
    detail: "not checked yet",
  },
};
