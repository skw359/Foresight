/**
 * Just enough MPEG-TS + H.264 to answer one question about a recorded segment:
 * what resolution is it?
 *
 * The clip route needs this because an MP4 track declares ONE resolution. A
 * `-c copy` remux of a range whose segments differ therefore inherits the FIRST
 * piece's size — a 320x180 download of footage that ran at 960x540 a few seconds
 * later. The recorder now encodes every segment for a camera at one geometry, so
 * new footage is uniform, but footage recorded before that (and any range
 * straddling the change) is not, and must be re-encoded onto one geometry
 * instead of silently mislabelled.
 *
 * Reading it here rather than shelling out keeps the check to one small file read
 * per piece — no ffprobe dependency, no process per segment on a 600-piece range.
 * The recorder writes with `-hls_flags independent_segments`, so every segment
 * opens with PAT/PMT + SPS/PPS + IDR and the SPS is always in the first few KB.
 */

/**
 * How much of a piece to read when looking for its SPS. Every segment in the
 * tree (verified over the whole recordings tree against ffprobe) resolves inside
 * 8 KiB; 16 KiB is margin for a segment with a fatter leading PMT.
 */
export const SPS_SEARCH_BYTES = 16 * 1024;

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;
const PID_PAT = 0x0000;
const PID_NULL = 0x1fff;
const NAL_TYPE_SPS = 7;

export interface Dimensions {
  w: number;
  h: number;
}

/**
 * Reassemble TS payloads per PID. Concatenating a PID's payloads in order is
 * what makes a NAL that straddles a 188-byte packet boundary readable — an SPS
 * is only ~25 bytes, so scanning the raw file would corrupt it roughly one time
 * in eight.
 */
function payloadsByPid(ts: Uint8Array): Map<number, Uint8Array[]> {
  const byPid = new Map<number, Uint8Array[]>();
  for (let i = 0; i + TS_PACKET_SIZE <= ts.length; i += TS_PACKET_SIZE) {
    if (ts[i] !== TS_SYNC_BYTE) break; // not (or no longer) packet-aligned
    const pid = ((ts[i + 1]! & 0x1f) << 8) | ts[i + 2]!;
    if (pid === PID_PAT || pid === PID_NULL) continue;
    const adaptation = (ts[i + 3]! >> 4) & 0x3;
    if (adaptation === 0 || adaptation === 2) continue; // no payload
    let start = i + 4;
    if (adaptation === 3) start += 1 + ts[i + 4]!; // skip the adaptation field
    if (start >= i + TS_PACKET_SIZE) continue;
    const list = byPid.get(pid) ?? [];
    list.push(ts.subarray(start, i + TS_PACKET_SIZE));
    byPid.set(pid, list);
  }
  return byPid;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Find the first SPS NAL in an Annex-B byte stream and return it WITH its header
 * byte (so the bytes can double as an identity fingerprint). A PES header also
 * opens with 00 00 01, but its stream_id (0xE0 for video) has nal_unit_type 0,
 * so it cannot be mistaken for an SPS.
 */
function findSpsNal(stream: Uint8Array): Uint8Array | null {
  for (let i = 0; i + 3 < stream.length; i++) {
    if (stream[i] !== 0 || stream[i + 1] !== 0 || stream[i + 2] !== 1) continue;
    const header = stream[i + 3]!;
    if ((header & 0x80) !== 0) continue; // forbidden_zero_bit must be 0
    if ((header & 0x1f) !== NAL_TYPE_SPS) continue;
    // Run to the next start code — that is where this NAL ends.
    let end = stream.length;
    for (let j = i + 4; j + 2 < stream.length; j++) {
      if (stream[j] === 0 && stream[j + 1] === 0 && (stream[j + 2] === 1 || stream[j + 2] === 0)) {
        end = j;
        break;
      }
    }
    return stream.subarray(i + 3, end);
  }
  return null;
}

/** The SPS NAL of the first video-ish PID that has one, or null. */
export function findSpsInTs(ts: Uint8Array): Uint8Array | null {
  for (const chunks of payloadsByPid(ts).values()) {
    const sps = findSpsNal(concat(chunks));
    if (sps) return sps;
  }
  return null;
}

/** Strip emulation-prevention bytes: 00 00 03 → 00 00 (H.264 §7.4.1). */
function toRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let n = 0;
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 0x03 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out[n++] = nal[i]!;
  }
  return out.subarray(0, n);
}

/** Bit reader with the exp-Golomb codes the SPS syntax is written in. */
class BitReader {
  private pos = 0; // in bits

  constructor(private readonly buf: Uint8Array) {}

  private bit(): number {
    const byte = this.buf[this.pos >> 3];
    if (byte === undefined) throw new Error("SPS truncated");
    const b = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }

  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v;
  }

  /** ue(v): unsigned exp-Golomb. */
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      zeros++;
      if (zeros > 31) throw new Error("SPS exp-Golomb overrun");
    }
    if (zeros === 0) return 0;
    return (1 << zeros) - 1 + this.u(zeros);
  }

  /** se(v): signed exp-Golomb. */
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) >> 1 : -(k >> 1);
  }
}

/** Profiles that carry the chroma_format_idc block (H.264 §7.3.2.1.1). */
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function skipScalingList(r: BitReader, size: number): void {
  let lastScale = 8;
  let nextScale = 8;
  for (let i = 0; i < size; i++) {
    if (nextScale !== 0) nextScale = (lastScale + r.se() + 256) % 256;
    if (nextScale !== 0) lastScale = nextScale;
  }
}

/**
 * Decode the coded frame size from an SPS NAL (header byte included, as
 * findSpsInTs returns it). Returns null on anything malformed — callers treat
 * that as "unknown" rather than failing the export.
 */
export function spsDimensions(spsNal: Uint8Array): Dimensions | null {
  try {
    const rbsp = toRbsp(spsNal);
    const r = new BitReader(rbsp.subarray(1)); // drop the NAL header byte
    const profileIdc = r.u(8);
    r.u(8); // constraint flags + reserved
    r.u(8); // level_idc
    r.ue(); // seq_parameter_set_id

    let chromaFormatIdc = 1; // 4:2:0 unless a high profile says otherwise
    let separateColourPlane = 0;
    if (HIGH_PROFILES.has(profileIdc)) {
      chromaFormatIdc = r.ue();
      if (chromaFormatIdc === 3) separateColourPlane = r.u(1);
      r.ue(); // bit_depth_luma_minus8
      r.ue(); // bit_depth_chroma_minus8
      r.u(1); // qpprime_y_zero_transform_bypass_flag
      if (r.u(1) === 1) {
        const lists = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < lists; i++) {
          if (r.u(1) === 1) skipScalingList(r, i < 6 ? 16 : 64);
        }
      }
    }

    r.ue(); // log2_max_frame_num_minus4
    const picOrderCntType = r.ue();
    if (picOrderCntType === 0) {
      r.ue(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (picOrderCntType === 1) {
      r.u(1); // delta_pic_order_always_zero_flag
      r.se(); // offset_for_non_ref_pic
      r.se(); // offset_for_top_to_bottom_field
      const cycle = r.ue();
      for (let i = 0; i < cycle; i++) r.se();
    }
    r.ue(); // max_num_ref_frames
    r.u(1); // gaps_in_frame_num_value_allowed_flag

    const widthInMbs = r.ue() + 1;
    const heightInMapUnits = r.ue() + 1;
    const frameMbsOnly = r.u(1);
    if (frameMbsOnly === 0) r.u(1); // mb_adaptive_frame_field_flag
    r.u(1); // direct_8x8_inference_flag

    let w = widthInMbs * 16;
    let h = (2 - frameMbsOnly) * heightInMapUnits * 16;

    if (r.u(1) === 1) {
      // frame_cropping_flag: the crop is how 1080 comes out of 68 macroblocks.
      const left = r.ue();
      const right = r.ue();
      const top = r.ue();
      const bottom = r.ue();
      const chroma = separateColourPlane === 1 ? 0 : chromaFormatIdc;
      const subWidthC = chroma === 3 ? 1 : 2;
      const subHeightC = chroma === 1 ? 2 : 1;
      const cropUnitX = chroma === 0 ? 1 : subWidthC;
      const cropUnitY = (chroma === 0 ? 1 : subHeightC) * (2 - frameMbsOnly);
      w -= cropUnitX * (left + right);
      h -= cropUnitY * (top + bottom);
    }

    return w > 0 && h > 0 ? { w, h } : null;
  } catch {
    return null;
  }
}

/** Convenience: TS bytes → coded frame size, or null when neither step works. */
export function tsDimensions(ts: Uint8Array): Dimensions | null {
  const sps = findSpsInTs(ts);
  return sps ? spsDimensions(sps) : null;
}
