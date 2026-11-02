"use client";

import { useEffect, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fetchTopicHistory, type TopicWindow } from "@/lib/api-client";
import { formatDateTime, formatNumber, formatTime } from "@/lib/format";
import { useTelemetry } from "@/lib/telemetry-store";
import { Badge, EmptyState, Panel } from "../ui";

interface TempPoint {
  t: number;
  tempC: number | null;
  powerW: number | null;
}

const KELVIN_OFFSET = 273.15;

function toTempPoint(payload: Record<string, unknown>, timestamp: string): TempPoint {
  const t = Date.parse(timestamp);
  const kelvin = typeof payload.temperature_k === "number" ? payload.temperature_k : null;
  const power = typeof payload.power_w === "number" ? payload.power_w : null;
  return {
    t: Number.isFinite(t) ? t : NaN,
    tempC: kelvin === null ? null : kelvin - KELVIN_OFFSET,
    powerW: power,
  };
}

/**
 * Dish temperature over the replay window.
 *
 * This is the panel a researcher reaches for after a storm: pick the dish (or
 * leave the default), set the replay window to three hours, jump the cursor to
 * when the front arrived and the whole change is in one chart — with the alert
 * and event context of the same window beside it. In live mode the window ends
 * at the platform clock instead of the cursor, so the same chart answers "what
 * has it been doing lately".
 */
export function DishTrendPanel({
  dishId,
  topic,
  warnC,
  className = "",
}: {
  dishId: string;
  topic: string | null;
  warnC: number;
  className?: string;
}) {
  const { mode, cursorMs, windowMinutes } = useTelemetry();
  const anchorMs = mode === "replay" ? cursorMs : null;
  const [points, setPoints] = useState<TempPoint[]>([]);
  const [available, setAvailable] = useState<TopicWindow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!topic) {
      setPoints([]);
      setAvailable(null);
      return;
    }
    let cancelled = false;
    // Debounced and re-anchored on every cursor move, so scrubbing repaints the
    // chart a moment behind the instrument panels rather than on every tick.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetchTopicHistory(topic, {
            minutes: windowMinutes,
            until: anchorMs,
            limit: 720,
          });
          if (cancelled) return;
          setPoints(
            response.samples
              .map((sample) => toTempPoint(sample.payload, sample.timestamp))
              .filter((point) => Number.isFinite(point.t))
              .sort((a, b) => a.t - b.t),
          );
          setAvailable(response.available);
          setError(null);
        } catch (caught) {
          if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [topic, windowMinutes, anchorMs]);

  const measured = points.filter((point) => point.tempC !== null) as Array<
    TempPoint & { tempC: number }
  >;
  const first = measured[0]?.tempC ?? null;
  const last = measured[measured.length - 1]?.tempC ?? null;
  const delta = first !== null && last !== null ? last - first : null;
  const peak = measured.reduce<number | null>(
    (max, point) => (max === null || point.tempC > max ? point.tempC : max),
    null,
  );
  const windowLabel = windowMinutes >= 60 ? `${windowMinutes / 60} h` : `${windowMinutes} min`;
  /**
   * An empty window is usually a window older than the recording, not a silent
   * dish, so the hint points at the first sample the platform actually holds.
   */
  const emptyHint =
    error ??
    (available && available.samples > 0
      ? `${dishId} has been recorded from ${formatDateTime(available.earliest)} to ${formatDateTime(
          available.latest,
        )} — this window ends before the first sample.`
      : "No dish telemetry has been recorded for this topic yet; it arrives once every two minutes.");

  return (
    <Panel
      className={className}
      title={`${dishId} temperature`}
      subtitle={
        mode === "replay"
          ? `${windowLabel} ending at the replay cursor (${formatTime(new Date(cursorMs).toISOString())}).`
          : `${windowLabel} ending at the live edge.`
      }
      actions={
        <div className="flex items-center gap-2">
          <Badge tone="neutral">{windowLabel} window</Badge>
          {delta !== null && (
            <Badge tone={Math.abs(delta) < 0.5 ? "neutral" : delta > 0 ? "warn" : "info"}>
              Δ {delta > 0 ? "+" : ""}
              {formatNumber(delta, 1)} °C
            </Badge>
          )}
        </div>
      }
    >
      <div className="h-48 w-full">
        {measured.length === 0 ? (
          <EmptyState
            message="No temperature samples in this window."
            hint={emptyHint}
          />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={measured} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
              <CartesianGrid stroke="#33231d" strokeDasharray="3 3" />
              <XAxis
                dataKey="t"
                type="number"
                domain={["dataMin", "dataMax"]}
                scale="time"
                tickFormatter={(value) => formatTime(new Date(Number(value)).toISOString())}
                stroke="#a89285"
                tick={{ fontSize: 10, fontFamily: "JetBrains Mono, ui-monospace, monospace" }}
                minTickGap={28}
              />
              <YAxis
                stroke="#a89285"
                tick={{ fontSize: 10, fontFamily: "JetBrains Mono, ui-monospace, monospace" }}
                width={48}
                unit=" °C"
                domain={["auto", "auto"]}
              />
              <Tooltip
                contentStyle={{
                  background: "#140f0d",
                  border: "1px solid #33231d",
                  borderRadius: 8,
                  fontSize: 11,
                }}
                labelFormatter={(value) => formatTime(new Date(Number(value)).toISOString())}
                formatter={(value) => [`${formatNumber(Number(value), 1)} °C`, "Temperature"]}
              />
              <Area
                type="monotone"
                dataKey="tempC"
                name="Temperature"
                stroke="#ffc978"
                fill="#ffc978"
                fillOpacity={0.16}
                strokeWidth={1.6}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] uppercase tracking-[0.12em] text-console-muted">
        <span>{measured.length} samples</span>
        <span>
          {formatNumber(first, 1)} → {formatNumber(last, 1)} °C
        </span>
        <span>peak {formatNumber(peak, 1)} °C</span>
        <span className={peak !== null && peak >= warnC ? "text-console-alert" : ""}>
          warn {warnC.toFixed(1)} °C
        </span>
        <span>power {formatNumber(measured[measured.length - 1]?.powerW ?? null, 0)} W</span>
      </p>
    </Panel>
  );
}
