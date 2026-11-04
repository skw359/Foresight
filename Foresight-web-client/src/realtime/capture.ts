/**
 * Viewer-side snapshot + recording (per PROTOCOL.md §4: snapshot/record are
 * viewer-side in v1). Operates on the live <video> element / its MediaStream.
 */

/** Capture the current video frame to a PNG and trigger a download. */
export function snapshotToPng(video: HTMLVideoElement, baseName: string): void {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) throw new Error("No video frame available yet.");

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable.");
  ctx.drawImage(video, 0, 0, w, h);

  canvas.toBlob((blob) => {
    if (!blob) return;
    downloadBlob(blob, `${baseName}-${timestamp()}.png`);
  }, "image/png");
}

/**
 * Records the media playing in a <video> element to a .webm file. Pulls a
 * MediaStream from the element (captureStream) so it follows the live track.
 */
export class VideoRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private baseName: string;

  constructor(baseName: string) {
    this.baseName = baseName;
  }

  get active(): boolean {
    return this.recorder !== null && this.recorder.state === "recording";
  }

  start(video: HTMLVideoElement): void {
    if (this.active) return;
    const stream = captureStream(video);
    if (!stream) throw new Error("This browser can't capture the video stream.");

    const mimeType = pickMimeType();
    const rec = new MediaRecorder(
      stream,
      mimeType ? { mimeType } : undefined,
    );
    this.chunks = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(this.chunks, {
        type: this.chunks[0]?.type || "video/webm",
      });
      if (blob.size > 0) {
        downloadBlob(blob, `${this.baseName}-${timestamp()}.webm`);
      }
      this.chunks = [];
    };
    rec.start(1000); // gather data each second
    this.recorder = rec;
  }

  stop(): void {
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.stop();
    }
    this.recorder = null;
  }
}

/* ---------------------------------------------------------------- helpers */

interface CaptureableVideo extends HTMLVideoElement {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
}

function captureStream(video: HTMLVideoElement): MediaStream | null {
  const v = video as CaptureableVideo;
  if (typeof v.captureStream === "function") return v.captureStream();
  if (typeof v.mozCaptureStream === "function") return v.mozCaptureStream();
  return null;
}

function pickMimeType(): string | null {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  if (typeof MediaRecorder === "undefined") return null;
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return null;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
