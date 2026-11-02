/**
 * Scan image construction (ARL RTA spec §3).
 *
 * A scan divides the target's field of view into an N×N grid; each dish sample
 * carries its offset from the target centre in radians and the brightness it
 * measured, and lands on exactly one pixel:
 *
 *   x = ⌊N (Δα/θ + ½)⌋        y = ⌊N (½ − Δδ/θ)⌋        I(x,y) = (1/n)Σsᵢ, n ≤ k
 *
 * with θ = `fov_rad`, k = `overlap`. Samples whose offsets or signal are null
 * (dish still slewing, scan paused) carry no pixel and are skipped, so a pixel
 * that never gets a sample stays a hole.
 *
 * The accumulator is deliberately a plain typed-array structure: the same code
 * folds the live SSE stream in the browser and rebuilds an in-flight scan from
 * the database on the server.
 */

export interface ScanGeometry {
  scanId: string;
  /** N — pixels per side. */
  size: number;
  /** k — how many samples each pixel receives. */
  overlap: number;
  /** θ — field of view in radians. */
  fovRad: number;
}

export interface ScanImage {
  geometry: ScanGeometry;
  /** Running mean brightness per pixel, row-major. Meaningful where samples > 0. */
  intensity: Float32Array;
  /** Number of samples folded into each pixel (≤ overlap). 0 means "hole". */
  samples: Uint8Array;
  /** Ring of raw sample values, `overlap` slots per pixel. */
  values: Float32Array;
  /** Next ring slot to overwrite, per pixel. */
  cursors: Uint8Array;
  /** Current sum per pixel, so the mean can be updated in O(1). */
  sums: Float32Array;
  /** Samples that produced a pixel. */
  total: number;
  /** Samples skipped because offsets or signal were null. */
  skipped: number;
  /** Samples skipped because they fell outside the field. */
  outside: number;
}

export interface SerializedScanImage {
  geometry: ScanGeometry;
  /** Row-major pixel means; 0 marks a hole (see `filled`). */
  intensity: number[];
  /** 1 where the pixel received at least one sample. */
  filled: number[];
  total: number;
  skipped: number;
  outside: number;
  min: number | null;
  max: number | null;
}

const DEFAULT_SIZE = 128;
const DEFAULT_OVERLAP = 3;

export function createScanImage(input: Partial<ScanGeometry> & { scanId: string }): ScanImage {
  const size = clampInt(input.size ?? DEFAULT_SIZE, 8, 1024, DEFAULT_SIZE);
  const overlap = clampInt(input.overlap ?? DEFAULT_OVERLAP, 1, 10, DEFAULT_OVERLAP);
  const fovRad =
    typeof input.fovRad === "number" && Number.isFinite(input.fovRad) && input.fovRad > 0
      ? input.fovRad
      : 0.01;
  const pixels = size * size;

  return {
    geometry: { scanId: input.scanId, size, overlap, fovRad },
    intensity: new Float32Array(pixels),
    samples: new Uint8Array(pixels),
    values: new Float32Array(pixels * overlap),
    cursors: new Uint8Array(pixels),
    sums: new Float32Array(pixels),
    total: 0,
    skipped: 0,
    outside: 0,
  };
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

/**
 * Pixel index for an offset, or null when the sample falls outside the field.
 * Out-of-range values are clamped by one pixel rather than dropped when they
 * land exactly on the field edge (Δα/θ = ±½), which the floor would push to N.
 */
export function pixelIndex(image: ScanImage, offsetRaRad: number, offsetDecRad: number): number | null {
  const { size, fovRad } = image.geometry;
  if (!Number.isFinite(offsetRaRad) || !Number.isFinite(offsetDecRad)) return null;

  const rawX = Math.floor(size * (offsetRaRad / fovRad + 0.5));
  const rawY = Math.floor(size * (0.5 - offsetDecRad / fovRad));
  if (rawX < -1 || rawX > size || rawY < -1 || rawY > size) return null;

  const x = Math.min(Math.max(rawX, 0), size - 1);
  const y = Math.min(Math.max(rawY, 0), size - 1);
  return y * size + x;
}

/**
 * Fold one sample into the image. Returns true when it produced a pixel.
 * `n ≤ overlap` is enforced by the per-pixel ring, so folding the same sample
 * twice (a reload, a duplicated live frame) cannot skew the mean.
 */
export function addSample(
  image: ScanImage,
  offsetRaRad: number | null | undefined,
  offsetDecRad: number | null | undefined,
  signal: number | null | undefined,
): boolean {
  if (
    typeof offsetRaRad !== "number" ||
    typeof offsetDecRad !== "number" ||
    typeof signal !== "number" ||
    !Number.isFinite(offsetRaRad) ||
    !Number.isFinite(offsetDecRad) ||
    !Number.isFinite(signal)
  ) {
    image.skipped += 1;
    return false;
  }

  const index = pixelIndex(image, offsetRaRad, offsetDecRad);
  if (index === null) {
    image.outside += 1;
    return false;
  }

  const { overlap } = image.geometry;
  const slot = index * overlap + image.cursors[index];
  const previous = image.values[slot];

  // Replace the oldest value in this pixel's window.
  image.sums[index] += signal - previous;
  image.values[slot] = signal;

  const count = image.samples[index];
  if (count < overlap) image.samples[index] = count + 1;
  image.cursors[index] = (image.cursors[index] + 1) % overlap;

  image.intensity[index] = image.sums[index] / image.samples[index];
  image.total += 1;
  return true;
}

/** Fold a raw `telemetry/scan` payload; ignores samples from another scan. */
export function addScanPayload(image: ScanImage, payload: Record<string, unknown>): boolean {
  if (payload.scan_id !== undefined && payload.scan_id !== image.geometry.scanId) return false;
  return addSample(
    image,
    asNumber(payload.pointing_offset_ra_rad),
    asNumber(payload.pointing_offset_dec_rad),
    asNumber(payload.signal_strength),
  );
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Flatten to a transport-friendly shape (typed arrays are not JSON). */
export function serializeImage(image: ScanImage): SerializedScanImage {
  const filled = new Array<number>(image.samples.length);
  let min: number | null = null;
  let max: number | null = null;

  for (let index = 0; index < image.samples.length; index += 1) {
    if (image.samples[index] === 0) {
      filled[index] = 0;
      continue;
    }
    filled[index] = 1;
    const value = image.intensity[index];
    if (min === null || value < min) min = value;
    if (max === null || value > max) max = value;
  }

  return {
    geometry: image.geometry,
    intensity: Array.from(image.intensity),
    filled,
    total: image.total,
    skipped: image.skipped,
    outside: image.outside,
    min,
    max,
  };
}

/** Rebuild an accumulator from a serialized image (used by the canvas on hydrate). */
export function deserializeImage(serialized: SerializedScanImage): ScanImage {
  const image = createScanImage(serialized.geometry);
  const { overlap } = image.geometry;
  image.intensity.set(serialized.intensity);

  for (let index = 0; index < serialized.filled.length; index += 1) {
    if (!serialized.filled[index]) continue;
    // A hydrated pixel holds one folded value: its mean. Later live samples
    // then blend into that window instead of restarting the count from zero.
    const mean = serialized.intensity[index];
    image.samples[index] = 1;
    image.sums[index] = mean;
    image.values[index * overlap] = mean;
    image.cursors[index] = overlap === 1 ? 0 : 1;
  }

  image.total = serialized.total;
  image.skipped = serialized.skipped;
  image.outside = serialized.outside;
  return image;
}
