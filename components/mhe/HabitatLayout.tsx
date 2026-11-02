"use client";

import { formatNumber, timeAgo, titleCase } from "@/lib/format";
import type { RoomEntry } from "@/lib/mhe-selectors";
import { MHE_CO2_LIMIT_PPM } from "@/lib/types";
import { Badge, StatusDot } from "../ui";

function roomTone(room: RoomEntry): "ok" | "warn" | "alert" | "neutral" {
  if (!room.telemetry) return "neutral";
  const co2 = room.telemetry.co2Ppm;
  if (typeof co2 === "number" && co2 >= MHE_CO2_LIMIT_PPM) return "alert";
  if (room.id === "airlock" && room.telemetry.pressurized === false) return "alert";
  if (room.id === "airlock" && room.telemetry.airlockState === "CYCLING") return "warn";
  return "ok";
}

const TILE_TONES: Record<string, string> = {
  ok: "border-console-edge bg-console-panel/70 hover:border-console-ok/60",
  warn: "border-console-warn/50 bg-console-warn/5 hover:border-console-warn",
  alert: "border-console-alert/60 bg-console-alert/10 hover:border-console-alert",
  neutral: "border-dashed border-console-edge/70 bg-console-panel/40 hover:border-console-muted",
};

/** Interactive 9-room habitat: five quarters plus common, lab, hydroponics, airlock. */
export function HabitatLayout({
  rooms,
  selectedId,
  onSelect,
  now,
}: {
  rooms: RoomEntry[];
  selectedId: string | null;
  onSelect: (roomId: string) => void;
  now: number;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {rooms.map((room) => {
        const tone = roomTone(room);
        const telemetry = room.telemetry;
        const selected = room.id === selectedId;
        return (
          <button
            key={room.id}
            type="button"
            onClick={() => onSelect(room.id)}
            aria-pressed={selected}
            className={`flex flex-col gap-1.5 rounded-lg border p-2.5 text-left transition-colors ${TILE_TONES[tone]} ${
              selected ? "ring-2 ring-console-signal/70" : ""
            }`}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="truncate text-[10px] font-semibold uppercase tracking-[0.12em] text-console-muted">
                {titleCase(room.id)}
              </span>
              <StatusDot tone={tone} pulse={tone === "alert"} />
            </div>

            <div className="font-mono text-lg leading-none text-console-ink">
              {formatNumber(telemetry?.temperatureC, 1)}
              <span className="ml-0.5 text-[10px] text-console-muted">°C</span>
            </div>

            <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[10px] text-console-muted">
              <div className="flex justify-between">
                <dt>crew</dt>
                <dd className="text-console-ink">{telemetry?.crewCount ?? "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt>O₂</dt>
                <dd className="text-console-ink">{formatNumber(telemetry?.o2Pct, 1)}</dd>
              </div>
              <div className="col-span-2 flex justify-between">
                <dt>CO₂</dt>
                <dd
                  className={
                    typeof telemetry?.co2Ppm === "number" && telemetry.co2Ppm >= MHE_CO2_LIMIT_PPM
                      ? "text-console-alert"
                      : "text-console-ink"
                  }
                >
                  {telemetry?.co2Ppm !== undefined ? `${Math.round(telemetry.co2Ppm)} ppm` : "—"}
                </dd>
              </div>
            </dl>

            <div className="mt-auto flex items-center justify-between gap-1">
              {room.id === "airlock" ? (
                <Badge tone={telemetry?.pressurized === false ? "alert" : "info"}>
                  {telemetry?.airlockState ?? (telemetry?.pressurized ? "pressurized" : "unknown")}
                </Badge>
              ) : (
                <span className="text-[9px] uppercase tracking-[0.12em] text-console-muted">
                  {telemetry ? timeAgo(room.timestamp, now) : "no telemetry"}
                </span>
              )}
              {typeof telemetry?.lightLevelPct === "number" && (
                <span className="font-mono text-[9px] text-console-muted">lux {Math.round(telemetry.lightLevelPct)}%</span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
