# foresight-recorder

No-Docker 24/7 recorder for Foresight Security — runs natively on **Linux,
macOS or Windows**. It joins each Home's LiveKit room as a **hidden subscriber**
(`@livekit/rtc-node`), pipes the decoded video frames into **ffmpeg**, and writes
per-camera HLS segments to disk. The `foresight-server` arms/disarms it from the
LiveKit webhook and serves the segments back to the dashboard.

```
 iPhone ──media──▶ LiveKit SFU ──media──▶ foresight-recorder
 (camera:<id>)     home:<homeId>          • hidden rtc-node subscriber
                       ▲                   • per-camera ffmpeg → HLS segments
       webhook         │ arm/disarm        • writes RECORDINGS_DIR/<home>/<cam>/...
 foresight-server ─────┘ (loopback control API :3399 + internal reconcile API :3198)
```

## Run (dev)

1. Have LiveKit + `foresight-server` running.
2. Have ffmpeg available — either a system install (`sudo apt install ffmpeg`,
   `brew install ffmpeg`) or a static build dropped in `bin/` (see
   [`bin/README.md`](./bin/README.md)). With `FFMPEG_PATH` unset the recorder
   prefers `bin/ffmpeg` (`bin/ffmpeg.exe` on Windows) and falls back to `ffmpeg`
   on PATH.
3. `cp .env.example .env` (Windows: `copy .env.example .env`) and set
   `RECORDER_SHARED_SECRET` (must match the server's), `RECORDINGS_DIR` (same
   absolute path as the server's), and the `LIVEKIT_*` values. Secrets must be
   generated (`openssl rand -hex 32`): the recorder refuses to start on the
   template values. `SERVER_URL` points at the server's **internal** listener
   (`http://127.0.0.1:3198`, the server's `INTERNAL_PORT`), not port 3199.
4. From the repo root: `npm run dev:recorder` (or `npm run dev` in this package).

Hit `http://127.0.0.1:3399/status` with the `x-recorder-secret` header to see
armed cameras, each camera's state (`recording`, `reacquiring`, `stalled`,
`encoder_failing`, …), when it last finished a segment (`lastSegmentAt`) and
whether ffmpeg passed its boot check. The dashboard shows the same per-camera
health through the server.

### Console output

On a terminal the recorder prints a coral boot banner and aligned, colored log
lines (see `src/console.ts`). Redirect stdout to a file or a pipe and it reverts
to the original one-JSON-line-per-event format, so shipping and `| grep` are
unaffected. The same renderer backs `foresight-server`.

| Var | Effect |
| --- | --- |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` (default `info`) |
| `LOG_PRETTY` | `1` forces human output, `0` forces JSON; unset = detect a TTY |
| `NO_COLOR` | any value drops all ANSI (no-color.org convention) |
| `FORESIGHT_LOG_COLOR` | `off` / `256` / `full` to pin the color depth |
| `FORESIGHT_LOG_ASCII` | `1` swaps box-drawing and glyphs for ASCII |

## How it behaves

- **Arming** is driven by the server webhook (camera joins + `recordingEnabled`)
  and by a periodic **reconcile** against the server's internal API, so a
  dropped webhook can never silently stop recording.
- **Self-healing rooms**: if a Home's LiveKit room drops for good (LiveKit
  restart, long network partition), the recorder reconnects with capped
  exponential backoff (1 s → 30 s), and every reconcile pass also reconnects any
  armed Home whose room is down — no webhook needed.
- **Timing**: frames are paced onto the `RECORD_FPS` timeline by their real
  timestamps (`src/media/pacer.ts`), repeating frames when the camera sends
  fewer (its 20 fps 480p preset, congestion) and dropping extras. Footage plays
  at true speed and segment durations match their wall-clock names. A new
  encoder only starts after the previous one has exited and in a later
  wall-clock second, so segment names never collide.
- **Track churn is normal**: the iOS app unpublishes/republishes its video track
  on every quality change. The recorder treats that as pause → resume into a
  fresh segment, never a crash or corrupt file.
- **Geometry changes** (the SFU switching layers, or the phone downscaling one)
  finalize the current `ffmpeg` and spawn a new one — a clean segment boundary,
  surfaced as `EXT-X-DISCONTINUITY` in the server's generated range playlists.
  The *output* geometry does **not** change with them: every segment for a camera
  is encoded at one target (the publication's own resolution, capped by
  `RECORD_MAX_HEIGHT`), with the incoming frames scaled and letterboxed onto it.
  That is what keeps the tree remuxable — an MP4 track declares a single
  resolution, so a `clip.mp4` export of mixed-geometry segments would inherit the
  first segment's size for the whole download.
- **Backpressure**: if `ffmpeg` can't keep up, frames are dropped rather than
  buffered unbounded (recording must never OOM the box) — and the timeline stays
  correct. Sustained overload steps that camera's output frame rate down and
  logs a warning (set `RECORD_MAX_HEIGHT` or a hardware `ENCODER`).
- **Failures are loud**: an ffmpeg that exits unexpectedly is logged at error
  level with its last stderr lines; repeated quick exits, or frames flowing with
  no finished segment, put the camera in `encoder_failing`. ffmpeg and the
  configured encoder are checked at boot.
- **Retention** prunes by age (`RETENTION_DAYS`) and by disk budget
  (`RETENTION_MAX_GB` / `MIN_FREE_GB`), whichever bites first. Disk-pressure
  pruning is fair-share by default (`RETENTION_POLICY=fair`: the camera using
  the most space loses its oldest footage first). Abandoned `*.tmp` files older
  than a day are removed.
- **Consolidation**: once a UTC day has fully elapsed (and its newest segment is
  over an hour old), that day's `seg_*.ts` files are concatenated per camera
  into a single `day_<YYYYMMDD>.ts` plus a `day_<YYYYMMDD>.json` byte index in
  the same `<home>/<cam>/YYYY/MM/DD` bucket, and the originals are deleted. The
  server plays byte ranges straight out of the day file (HLS v4
  `EXT-X-BYTERANGE`); retention treats each day file as one unit that expires
  only when the entire day ages out. Passes never overlap, each build writes a
  uniquely named temp file, and a day is skipped (with a warning) when the
  volume lacks room for a full copy of it plus `MIN_FREE_GB`. Controlled by
  `CONSOLIDATE_ENABLED` (default on) and `CONSOLIDATE_INTERVAL_MS` (default hourly).

## Known limitations (by design / preview SDK)

- Decoded frames mean **continuous re-encode** (one H.264 encode per recording
  camera). Fine for a handful of phones per host; use `h264_nvenc` to scale.
- `@livekit/rtc-node` (Developer Preview) wraps no per-subscriber layer pin on a
  `RemoteTrackPublication`, so `RECORD_LAYER` is applied through the FFI request
  the SDK does ship (`SetRemoteTrackPublicationQualityRequest` — see
  `src/livekit/layerPin.ts`). Two rtc-node internals are load-bearing there and
  are covered by `test/layerPin.test.ts`; if a future version breaks them the pin
  degrades to a warning and the recorder is back to whatever layer the SFU picks.
- The phone also scales its **own** layers down under uplink/CPU pressure, which
  the pin cannot prevent — a pinned top layer is still only as good as what the
  publisher manages to send. The fixed encode target absorbs it (soft footage
  rather than a resolution change), but genuinely low-resolution stretches mean
  the phone's uplink, not the recorder.
- Audio is **off in v1** (`RECORD_AUDIO=false`); the capture path exists
  (`media/audioPipe.ts`) for milestone M4 (audio + A/V sync).
