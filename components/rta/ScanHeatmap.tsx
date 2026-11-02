"use client";

import { useEffect, useMemo, useRef } from "react";
import type { RtaScanSample } from "@/lib/types";

/**
 * HTML5 Canvas heatmap for the RTA scan stream.
 *
 * Each 1 Hz sample is binned into a (dish offset × frequency) grid; the cell
 * intensity is the averaged sample value. The canvas is redrawn on every batch
 * of new samples so the operator sees the composite image build in real time.
 */

export interface ScanSamplePoint {
  sample: RtaScanSample;
  timestamp: string;
}

const COLS = 160;
const ROWS = 72;
const CANVAS_W = 960;
const CANVAS_H = 420;
const PAD = { left: 84, right: 14, top: 14, bottom: 30 };

/** Deep-space → teal → signal → solar gradient. */
function colorFor(value: number): string {
  const t = Math.min(Math.max(value, 0), 1);
  const stops: Array<[number, [number, number, number]]> = [
    [0, [10, 20, 32]],
    [0.25, [14, 68, 94]],
    [0.5, [14, 124, 102]],
    [0.75, [56, 242, 195]],
    [1, [255, 209, 102]],
  ];
  let lower = stops[0];
  let upper = stops[stops.length - 1];
  for (let index = 0; index < stops.length - 1; index += 1) {
    if (t >= stops[index][0] && t <= stops[index + 1][0]) {
      lower = stops[index];
      upper = stops[index + 1];
      break;
    }
  }
  const span = upper[0] - lower[0] || 1;
  const ratio = (t - lower[0]) / span;
  const channel = (a: number, b: number) => Math.round(a + (b - a) * ratio);
  return `rgb(${channel(lower[1][0], upper[1][0])}, ${channel(lower[1][1], upper[1][1])}, ${channel(
    lower[1][2],
    upper[1][2],
  )})`;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function ScanHeatmap({
  samples,
  scanning,
  activeScanId,
}: {
  samples: ScanSamplePoint[];
  scanning: boolean;
  activeScanId?: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const model = useMemo(() => {
    const cells = new Float32Array(COLS * ROWS);
    const counts = new Uint16Array(COLS * ROWS);

    let maxOffset = 0.25;
    let fMin = Number.POSITIVE_INFINITY;
    let fMax = Number.NEGATIVE_INFINITY;
    let vMin = Number.POSITIVE_INFINITY;
    let vMax = Number.NEGATIVE_INFINITY;
    let used = 0;

    for (const point of samples) {
      const az = finite(point.sample.offsetAzDeg) ?? 0;
      const el = finite(point.sample.offsetElDeg) ?? 0;
      const frequency = finite(point.sample.frequencyMhz);
      const value = finite(point.sample.value);
      if (frequency === null || value === null) continue;

      const offset = Math.hypot(az, el);
      if (offset > maxOffset) maxOffset = offset;
      if (frequency < fMin) fMin = frequency;
      if (frequency > fMax) fMax = frequency;
      if (value < vMin) vMin = value;
      if (value > vMax) vMax = value;
      used += 1;

      const column = Math.min(COLS - 1, Math.floor((offset / Math.max(maxOffset, 1e-6)) * COLS));
      // Frequency increases upward on screen.
      const rowSeed = fMax > fMin ? (frequency - fMin) / (fMax - fMin) : 0.5;
      const row = Math.min(ROWS - 1, Math.floor((1 - rowSeed) * ROWS));
      const index = row * COLS + column;
      cells[index] += value;
      counts[index] += 1;
    }

    if (!Number.isFinite(fMin)) {
      fMin = 0;
      fMax = 0;
    }
    if (!Number.isFinite(vMin)) {
      vMin = 0;
      vMax = 0;
    }

    const valueSpan = vMax - vMin || 1;
    for (let index = 0; index < cells.length; index += 1) {
      if (counts[index] === 0) continue;
      const average = cells[index] / counts[index];
      cells[index] = (average - vMin) / valueSpan;
    }

    return {
      cells,
      counts,
      used,
      maxOffset,
      fMin,
      fMax,
      vMin,
      vMax: vMax || 1,
    };
  }, [samples]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const plotW = CANVAS_W - PAD.left - PAD.right;
    const plotH = CANVAS_H - PAD.top - PAD.bottom;
    const cellW = plotW / COLS;
    const cellH = plotH / ROWS;

    context.clearRect(0, 0, CANVAS_W, CANVAS_H);
    context.fillStyle = "#070b13";
    context.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Plot background + subtle grid.
    context.fillStyle = "#0a101a";
    context.fillRect(PAD.left, PAD.top, plotW, plotH);

    for (let index = 0; index < model.cells.length; index += 1) {
      if (model.counts[index] === 0) continue;
      const row = Math.floor(index / COLS);
      const column = index % COLS;
      context.fillStyle = colorFor(model.cells[index]);
      context.fillRect(
        PAD.left + column * cellW,
        PAD.top + row * cellH,
        Math.ceil(cellW) + 0.5,
        Math.ceil(cellH) + 0.5,
      );
    }

    context.strokeStyle = "rgba(124, 140, 163, 0.14)";
    context.lineWidth = 1;
    const columns = 8;
    for (let index = 0; index <= columns; index += 1) {
      const x = PAD.left + (plotW / columns) * index;
      context.beginPath();
      context.moveTo(x, PAD.top);
      context.lineTo(x, PAD.top + plotH);
      context.stroke();
    }
    const rows = 4;
    for (let index = 0; index <= rows; index += 1) {
      const y = PAD.top + (plotH / rows) * index;
      context.beginPath();
      context.moveTo(PAD.left, y);
      context.lineTo(PAD.left + plotW, y);
      context.stroke();
    }

    context.strokeStyle = "rgba(124, 140, 163, 0.35)";
    context.strokeRect(PAD.left, PAD.top, plotW, plotH);

    context.fillStyle = "#7d8ca3";
    context.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.textBaseline = "middle";

    // Y axis: frequency band.
    if (model.fMax > 0) {
      context.textAlign = "right";
      context.fillText(`${model.fMax.toFixed(0)} MHz`, PAD.left - 8, PAD.top + 6);
      context.fillText(
        `${((model.fMax + model.fMin) / 2).toFixed(0)}`,
        PAD.left - 8,
        PAD.top + plotH / 2,
      );
      context.fillText(`${model.fMin.toFixed(0)} MHz`, PAD.left - 8, PAD.top + plotH - 6);
    }

    // X axis: dish offset.
    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillText("0.00°", PAD.left + 2, PAD.top + plotH + 8);
    context.fillText(
      `${(model.maxOffset / 2).toFixed(2)}°`,
      PAD.left + plotW / 2,
      PAD.top + plotH + 8,
    );
    context.fillText(
      `${model.maxOffset.toFixed(2)}° dish offset`,
      PAD.left + plotW - 40,
      PAD.top + plotH + 8,
    );

    // Intensity legend.
    const legendW = 110;
    const legendX = CANVAS_W - PAD.right - legendW;
    const legendY = PAD.top + 10;
    const gradient = context.createLinearGradient(legendX, 0, legendX + legendW, 0);
    gradient.addColorStop(0, colorFor(0));
    gradient.addColorStop(0.5, colorFor(0.5));
    gradient.addColorStop(1, colorFor(1));
    context.fillStyle = gradient;
    context.fillRect(legendX, legendY, legendW, 6);
    context.strokeStyle = "rgba(124, 140, 163, 0.4)";
    context.strokeRect(legendX, legendY, legendW, 6);
    context.fillStyle = "#7d8ca3";
    context.textAlign = "left";
    context.textBaseline = "top";
    context.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.fillText(
      `${model.vMin.toFixed(1)} → ${model.vMax.toFixed(1)}`,
      legendX,
      legendY + 10,
    );

    if (model.used === 0) {
      context.fillStyle = "rgba(230, 237, 247, 0.5)";
      context.font = "13px ui-monospace, SFMono-Regular, Menlo, monospace";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(
        scanning ? "Awaiting scan samples…" : "No scan samples — start a scan to build the map",
        PAD.left + plotW / 2,
        PAD.top + plotH / 2,
      );
    }
  }, [model, scanning]);

  return (
    <div className="space-y-2">
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        className="w-full rounded-lg border border-console-edge/70 bg-console-void"
        aria-label="Scan composite heatmap of dish offsets against frequency samples"
        role="img"
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-[0.12em] text-console-muted">
        <span>{model.used} samples in buffer</span>
        <span>offset 0 – {model.maxOffset.toFixed(2)}°</span>
        <span>
          band {model.fMin.toFixed(0)} – {model.fMax.toFixed(0)} MHz
        </span>
        <span>scan {activeScanId ?? "—"}</span>
      </div>
    </div>
  );
}
