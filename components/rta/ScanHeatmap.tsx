"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  addSample,
  createScanImage,
  deserializeImage,
  type ScanImage,
  type SerializedScanImage,
} from "@/lib/scan-image";
import { useTelemetry } from "@/lib/telemetry-store";
import type { RtaScanContext, RtaScanSample } from "@/lib/types";

/**
 * The RTA scan image (spec §3), rendered as an N×N pixel canvas.
 *
 * Each 1 Hz sample lands on exactly one pixel — `(x, y) = (⌊N(Δα/θ + ½)⌋,
 * ⌊N(½ − Δδ/θ)⌋)` — and the pixel shows the mean brightness of the (up to
 * `overlap`) samples that hit it. Pixels that never receive a sample stay holes,
 * so the image builds up visibly as the dishes sweep the field.
 *
 * The grid geometry and the pixels that arrived before this page loaded come
 * from `GET /api/rta/scan`; everything after that is folded in from the live SSE
 * stream without a round trip.
 */

export interface ScanSamplePoint {
  sample: RtaScanSample;
  timestamp: string;
}

const CANVAS_W = 640;
const CANVAS_H = 640;
const PAD = { left: 44, right: 96, top: 12, bottom: 28 };

/** Void → cold regolith → rust → ember → sunlit sand: Mars, at night to noon. */
const STOPS: Array<[number, [number, number, number]]> = [
  [0, [12, 10, 13]],
  [0.25, [58, 34, 30]],
  [0.5, [148, 58, 34]],
  [0.75, [255, 122, 69]],
  [1, [255, 224, 178]],
];

function colorAt(t: number): [number, number, number] {
  const clamped = Math.min(Math.max(t, 0), 1);
  let lower = STOPS[0];
  let upper = STOPS[STOPS.length - 1];
  for (let index = 0; index < STOPS.length - 1; index += 1) {
    if (clamped >= STOPS[index][0] && clamped <= STOPS[index + 1][0]) {
      lower = STOPS[index];
      upper = STOPS[index + 1];
      break;
    }
  }
  const span = upper[0] - lower[0] || 1;
  const ratio = (clamped - lower[0]) / span;
  return [
    Math.round(lower[1][0] + (upper[1][0] - lower[1][0]) * ratio),
    Math.round(lower[1][1] + (upper[1][1] - lower[1][1]) * ratio),
    Math.round(lower[1][2] + (upper[1][2] - lower[1][2]) * ratio),
  ];
}

function cssColor(t: number): string {
  const [r, g, b] = colorAt(t);
  return `rgb(${r}, ${g}, ${b})`;
}

interface ImageStats {
  filled: number;
  pixels: number;
  min: number;
  max: number;
  samples: number;
  skipped: number;
  outside: number;
}

/** A scan the server rebuilt from stored events and samples. */
interface RecoveredScan {
  context: RtaScanContext;
  image: SerializedScanImage | null;
  storedSamples: number;
}

function measure(image: ScanImage): ImageStats {
  let filled = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < image.samples.length; index += 1) {
    if (image.samples[index] === 0) continue;
    filled += 1;
    const value = image.intensity[index];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return {
    filled,
    pixels: image.samples.length,
    min: filled ? min : 0,
    max: filled ? max : 0,
    samples: image.total,
    skipped: image.skipped,
    outside: image.outside,
  };
}

function drawImage(
  canvas: HTMLCanvasElement,
  image: ScanImage,
  stats: ImageStats,
  scanning: boolean,
): void {
  const context = canvas.getContext("2d");
  if (!context) return;

  const plotW = CANVAS_W - PAD.left - PAD.right;
  const plotH = CANVAS_H - PAD.top - PAD.bottom;

  context.clearRect(0, 0, CANVAS_W, CANVAS_H);
  context.fillStyle = "#07060c";
  context.fillRect(0, 0, CANVAS_W, CANVAS_H);
  context.fillStyle = "#0f0b0c";
  context.fillRect(PAD.left, PAD.top, plotW, plotH);

  const { size } = image.geometry;

  // Paint the N×N grid into an offscreen canvas, then scale it up with nearest
  // neighbour so each grid cell is a crisp square.
  if (stats.filled > 0) {
    const offscreen = document.createElement("canvas");
    offscreen.width = size;
    offscreen.height = size;
    const offContext = offscreen.getContext("2d");
    if (offContext) {
      const frame = offContext.createImageData(size, size);
      const span = stats.max - stats.min || 1;
      for (let index = 0; index < image.samples.length; index += 1) {
        const offset = index * 4;
        if (image.samples[index] === 0) {
          // Hole: leave the plot background visible.
          frame.data[offset] = 12;
          frame.data[offset + 1] = 18;
          frame.data[offset + 2] = 28;
          frame.data[offset + 3] = 255;
          continue;
        }
        const [r, g, b] = colorAt((image.intensity[index] - stats.min) / span);
        frame.data[offset] = r;
        frame.data[offset + 1] = g;
        frame.data[offset + 2] = b;
        frame.data[offset + 3] = 255;
      }
      offContext.putImageData(frame, 0, 0);
      context.imageSmoothingEnabled = false;
      context.drawImage(offscreen, PAD.left, PAD.top, plotW, plotH);
      context.imageSmoothingEnabled = true;
    }
  }

  // Grid + frame.
  context.strokeStyle = "rgba(232, 200, 164, 0.10)";
  context.lineWidth = 1;
  for (let index = 0; index <= 4; index += 1) {
    const x = PAD.left + (plotW / 4) * index;
    context.beginPath();
    context.moveTo(x, PAD.top);
    context.lineTo(x, PAD.top + plotH);
    context.stroke();
    const y = PAD.top + (plotH / 4) * index;
    context.beginPath();
    context.moveTo(PAD.left, y);
    context.lineTo(PAD.left + plotW, y);
    context.stroke();
  }
  context.strokeStyle = "rgba(232, 200, 164, 0.28)";
  context.strokeRect(PAD.left, PAD.top, plotW, plotH);

  // Axis labels: offsets in degrees, north at the top.
  const halfDeg = (image.geometry.fovRad / 2) * (180 / Math.PI);
  context.fillStyle = "#a89285";
  context.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  context.textBaseline = "middle";
  context.textAlign = "right";
  context.fillText(`+${halfDeg.toFixed(2)}°`, PAD.left - 6, PAD.top + 4);
  context.fillText("0°", PAD.left - 6, PAD.top + plotH / 2);
  context.fillText(`−${halfDeg.toFixed(2)}°`, PAD.left - 6, PAD.top + plotH - 4);
  context.textAlign = "center";
  context.textBaseline = "top";
  context.fillText("−", PAD.left + 4, PAD.top + plotH + 6);
  context.fillText("Δ Dec", PAD.left + plotW / 2, PAD.top + plotH + 6);
  context.fillText("+", PAD.left + plotW - 4, PAD.top + plotH + 6);

  // Colour legend.
  const legendX = PAD.left + plotW + 18;
  const legendY = PAD.top + 8;
  const legendW = 12;
  const legendH = plotH - 40;
  const gradient = context.createLinearGradient(0, legendY + legendH, 0, legendY);
  gradient.addColorStop(0, cssColor(0));
  gradient.addColorStop(0.5, cssColor(0.5));
  gradient.addColorStop(1, cssColor(1));
  context.fillStyle = gradient;
  context.fillRect(legendX, legendY, legendW, legendH);
  context.strokeStyle = "rgba(232, 200, 164, 0.35)";
  context.strokeRect(legendX, legendY, legendW, legendH);
  context.fillStyle = "#a89285";
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(stats.max.toFixed(2), legendX + legendW + 6, legendY);
  context.fillText(stats.min.toFixed(2), legendX + legendW + 6, legendY + legendH);

  if (stats.filled === 0) {
    context.fillStyle = "rgba(246, 236, 225, 0.55)";
    context.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(
      scanning ? "Awaiting scan samples…" : "No scan image — start a scan",
      PAD.left + plotW / 2,
      PAD.top + plotH / 2,
    );
  }
}

export function ScanHeatmap({
  samples,
  scanning,
  context: scanContext,
}: {
  samples: ScanSamplePoint[];
  scanning: boolean;
  /** Geometry of the current scan, from its `started` event. */
  context: RtaScanContext | null;
}) {
  const { mode } = useTelemetry();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<ScanImage | null>(null);
  const cursorRef = useRef<{ timestamp: string; folded: number }>({ timestamp: "", folded: 0 });
  const samplesRef = useRef<ScanSamplePoint[]>(samples);
  samplesRef.current = samples;

  const [stats, setStats] = useState<ImageStats | null>(null);
  const [hydrating, setHydrating] = useState(false);
  const [hydrateNote, setHydrateNote] = useState<string | null>(null);
  const [recovered, setRecovered] = useState<RecoveredScan | null>(null);

  // A `started` event is published once, so a page opened after the scan
  // finished has no live context to size the grid with. Ask the server, which
  // rebuilds it from the stored event.
  useEffect(() => {
    if (scanContext || mode !== "live") return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/rta/scan", { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as {
          context: RtaScanContext | null;
          image: SerializedScanImage | null;
          storedSamples?: number;
        };
        if (cancelled || !body.context) return;
        setRecovered({
          context: body.context,
          image: body.image,
          storedSamples: body.storedSamples ?? 0,
        });
      } catch {
        // Leave the canvas empty; the live stream can still build it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scanContext, mode]);

  const activeContext = scanContext ?? recovered?.context ?? null;
  const scanId = activeContext?.scanId ?? null;

  // Reset + hydrate whenever the scan changes: the grid geometry is fixed for
  // the life of a scan, and the pixels that predate this page must be rebuilt
  // from the database rather than lost.
  useEffect(() => {
    cursorRef.current = { timestamp: "", folded: 0 };
    setHydrateNote(null);

    if (!activeContext) {
      imageRef.current = null;
      setStats(null);
      return;
    }

    let cancelled = false;

    const seed = createScanImage({
      scanId: activeContext.scanId,
      size: activeContext.gridSize,
      overlap: activeContext.overlap,
      fovRad: activeContext.fovRad,
    });
    imageRef.current = seed;
    setStats(measure(seed));

    if (mode !== "live") return;

    /**
     * Adopt a rebuilt image. Samples the store already buffered must not be
     * folded twice, so the cursor moves to the newest one.
     */
    const adopt = (image: ScanImage, note: string | null) => {
      imageRef.current = image;
      const buffered = samplesRef.current;
      const last = buffered.length ? buffered[buffered.length - 1] : null;
      cursorRef.current = last
        ? { timestamp: last.timestamp, folded: countAt(buffered, last.timestamp) }
        : { timestamp: "", folded: 0 };
      setStats(measure(image));
      setHydrateNote(note);
    };

    // The recovery fetch already returned the rebuilt image.
    if (recovered && recovered.context.scanId === activeContext.scanId && recovered.image) {
      adopt(
        deserializeImage(recovered.image),
        recovered.storedSamples ? `${recovered.storedSamples} stored samples` : null,
      );
      return;
    }

    setHydrating(true);
    void (async () => {
      try {
        const response = await fetch(
          `/api/rta/scan?scanId=${encodeURIComponent(activeContext.scanId)}`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as {
          image: SerializedScanImage | null;
          storedSamples?: number;
        };
        if (cancelled || !body.image) return;
        if (body.image.geometry.scanId !== activeContext.scanId) return;

        adopt(
          deserializeImage(body.image),
          body.storedSamples ? `${body.storedSamples} stored samples` : null,
        );
      } catch (error) {
        if (!cancelled) {
          setHydrateNote(error instanceof Error ? `history unavailable: ${error.message}` : null);
        }
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeContext, recovered, mode]);

  // Fold every sample that arrived since the last render into the accumulator.
  useEffect(() => {
    const image = imageRef.current;
    if (!image) return;

    const cursor = cursorRef.current;
    let folded = 0;
    for (const point of samples) {
      if (point.timestamp < cursor.timestamp) continue;
      if (point.timestamp === cursor.timestamp) {
        // Timestamps have millisecond resolution, so several dishes can share
        // one: skip exactly the ones a previous pass already folded.
        folded += 1;
        if (folded <= cursor.folded) continue;
      }
      const { sample } = point;
      if (sample.scanId && sample.scanId !== image.geometry.scanId) continue;
      addSample(image, sample.raOffsetRad, sample.decOffsetRad, sample.signalStrength);
    }

    const last = samples.length ? samples[samples.length - 1] : null;
    if (last) {
      cursorRef.current =
        last.timestamp === cursor.timestamp
          ? { timestamp: cursor.timestamp, folded: Math.max(cursor.folded, folded) }
          : { timestamp: last.timestamp, folded: countAt(samples, last.timestamp) };
    }

    setStats(measure(image));
  }, [samples]);

  // Redraw whenever the accumulator or the scan state changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas) return;
    if (!image || !stats) {
      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, CANVAS_W, CANVAS_H);
      context.fillStyle = "#07060c";
      context.fillRect(0, 0, CANVAS_W, CANVAS_H);
      context.fillStyle = "rgba(246, 236, 225, 0.55)";
      context.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("No active scan", CANVAS_W / 2, CANVAS_H / 2);
      return;
    }
    drawImage(canvas, image, stats, scanning);
  }, [stats, scanning, scanId]);

  const coverage = useMemo(
    () => (stats && stats.pixels ? (stats.filled / stats.pixels) * 100 : 0),
    [stats],
  );
  const bandLabel = formatBand(activeContext?.bandHz);

  return (
    <div className="space-y-2">
      <div className="flex justify-center">
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          className="max-h-[560px] w-full max-w-[560px] rounded-lg border border-console-edge/70 bg-console-void"
          aria-label="Scan image built from pointing offsets and signal strength"
          role="img"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-[0.12em] text-console-muted">
        <span>{stats ? `${stats.filled}/${stats.pixels} pixels` : "no grid"}</span>
        <span>{coverage.toFixed(0)}% coverage</span>
        <span>{stats?.samples ?? 0} samples</span>
        {stats && stats.skipped > 0 && <span>{stats.skipped} no-signal</span>}
        {activeContext && (
          <span>
            N={activeContext.gridSize} · overlap {activeContext.overlap} ·
            {" "}
            {(activeContext.fovRad * (180 / Math.PI)).toFixed(2)}° fov
          </span>
        )}
        {bandLabel && <span className="text-console-info">band {bandLabel}</span>}
        <span>scan {scanId ?? "—"}</span>
        {hydrating && <span className="text-console-signal">rebuilding…</span>}
        {!hydrating && hydrateNote && <span>{hydrateNote}</span>}
      </div>
    </div>
  );
}

/** How many buffered samples share the given timestamp. */
function countAt(samples: ScanSamplePoint[], timestamp: string): number {
  let count = 0;
  for (const point of samples) {
    if (point.timestamp === timestamp) count += 1;
  }
  return count;
}

/**
 * Each scan is imaged at one frequency band, and different bands show different
 * features of the same target — so the image has to say which band it is, or two
 * scans of one target become indistinguishable pictures.
 */
function formatBand(hz: number | null | undefined): string | null {
  if (typeof hz !== "number" || !Number.isFinite(hz) || hz <= 0) return null;
  return hz >= 1e9 ? `${(hz / 1e9).toFixed(2)} GHz` : `${(hz / 1e6).toFixed(0)} MHz`;
}
