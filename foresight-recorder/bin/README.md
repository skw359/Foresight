# `bin/` — bundled ffmpeg

The recorder shells out to ffmpeg to encode decoded LiveKit frames into HLS
segments, and the server uses the same binary to remux clip downloads.

With `FFMPEG_PATH` unset the recorder looks here first — `ffmpeg.exe` on
Windows, `ffmpeg` everywhere else — and falls back to `ffmpeg` on your PATH.
So you have two options:

**1. A system install (simplest on Linux/macOS)** — leave this folder empty:

```bash
sudo apt install ffmpeg      # Debian/Ubuntu
brew install ffmpeg          # macOS
```

**2. A static build dropped in here** — no root, and pins one known-good
version. Unzip so one of these paths exists:

```
foresight-recorder/bin/ffmpeg        # Linux / macOS
foresight-recorder/bin/ffmpeg.exe    # Windows
```

Recent static builds: [johnvansickle.com](https://johnvansickle.com/ffmpeg/)

> **Smoke-test any static build before trusting it.** The johnvansickle 7.0.2
> amd64 build previously in this directory segfaults on any *demux* on the
> Ubuntu host (kernel 7.x) — `ffprobe <anyfile>` and `ffmpeg -f mpegts -i pipe:0`
> both die with SIGSEGV — while encoding from a raw pipe works normally. That
> combination is nasty: recording keeps working, so the fault stays invisible
> until a clip download silently returns 0 bytes. Check the read path, not just
> `-encoders`.
(Linux) or [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) / [BtbN](https://github.com/BtbN/FFmpeg-Builds/releases)
(Windows). The binaries are intentionally **not** committed — they are large and
platform-specific, and `.gitignore` excludes them.

Whichever you choose, verify it has the encoder you configured:

- `libx264` (default) — present in essentially all builds.
- `h264_nvenc` — only in builds with NVIDIA NVENC enabled; requires an NVIDIA GPU.

```bash
./bin/ffmpeg -hide_banner -encoders | grep 264      # Linux / macOS
.\bin\ffmpeg.exe -hide_banner -encoders | findstr "264"
```

The recorder also needs the `hls` muxer and the `rawvideo` demuxer; every
general-purpose build has both.
