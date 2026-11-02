"use client";

import { formatNumber, timeAgo, titleCase } from "@/lib/format";
import type { RoomEntry } from "@/lib/mhe-selectors";
import { MHE_CO2_LIMIT_PPM } from "@/lib/types";
import { Badge, StatusDot } from "../ui";

/**
 * The 9-room habitat floorplan supplied as
 * `mars-habitation-experiment-room-layout.svg` (720 × 560), redrawn as a live
 * SVG: each room tile is flood-filled by condition and clickable, and carries
 * its current temperature, CO₂ and lighting.
 */

type Tone = "ok" | "warn" | "alert" | "neutral";

interface RoomBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Room rectangles, in the coordinate space of the supplied floorplan. */
const ROOMS: RoomBox[] = [
  { id: "quarters-1", x: 40, y: 40, w: 120, h: 120 },
  { id: "quarters-2", x: 170, y: 40, w: 120, h: 120 },
  { id: "quarters-3", x: 300, y: 40, w: 120, h: 120 },
  { id: "quarters-4", x: 430, y: 40, w: 120, h: 120 },
  { id: "quarters-5", x: 560, y: 40, w: 120, h: 120 },
  { id: "common", x: 40, y: 160, w: 380, h: 200 },
  { id: "lab", x: 420, y: 160, w: 260, h: 200 },
  { id: "hydroponics", x: 40, y: 360, w: 490, h: 160 },
  { id: "airlock", x: 530, y: 360, w: 150, h: 160 },
];

const DOORS: Array<[number, number, number, number]> = [
  [85, 160, 115, 160],
  [215, 160, 245, 160],
  [345, 160, 375, 160],
  [475, 160, 505, 160],
  [605, 160, 635, 160],
  [420, 255, 420, 285],
  [215, 360, 245, 360],
  [590, 360, 620, 360],
  [680, 435, 680, 465],
];

/* Habitat deck colours: warm basalt rooms, ember for anything off-nominal. */
const TONE_FILL: Record<Tone, string> = {
  ok: "rgba(255, 201, 120, 0.05)",
  warn: "rgba(255, 161, 75, 0.12)",
  alert: "rgba(255, 75, 62, 0.14)",
  neutral: "rgba(168, 146, 133, 0.04)",
};

const TONE_STROKE: Record<Tone, string> = {
  ok: "#4a3427",
  warn: "#ffa14b",
  alert: "#ff4b3e",
  neutral: "#33231d",
};

const TONE_INK: Record<Tone, string> = {
  ok: "#f6ece1",
  warn: "#ffd9a8",
  alert: "#ffc2c2",
  neutral: "#a89285",
};

function roomTone(room: RoomEntry | undefined): Tone {
  const telemetry = room?.telemetry;
  if (!room || !telemetry) return "neutral";
  const co2 = telemetry.co2Ppm;
  if (typeof co2 === "number" && co2 >= MHE_CO2_LIMIT_PPM) return "alert";
  if (room.id === "airlock" && telemetry.pressurized === false) return "alert";
  if (room.id === "airlock" && telemetry.airlockState === "cycling") return "warn";
  return "ok";
}

function airlockLabel(room: RoomEntry | undefined): string | null {
  const telemetry = room?.telemetry;
  if (!telemetry) return null;
  if (telemetry.airlockState) return String(telemetry.airlockState);
  if (telemetry.pressurized !== undefined) return telemetry.pressurized ? "pressurised" : "depressurised";
  return null;
}

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
  const byId = new Map(rooms.map((room) => [room.id, room]));

  return (
    <div className="space-y-2">
      <svg
        viewBox="0 0 720 560"
        className="w-full rounded-lg border border-console-edge/70 bg-console-void"
        role="group"
        aria-label="Mars Habitation Experiment floorplan"
      >
        <rect x={30} y={30} width={660} height={500} rx={12} fill="none" stroke="#4a3427" strokeWidth={4} />

        {ROOMS.map((box) => {
          const room = byId.get(box.id);
          const tone = roomTone(room);
          const selected = box.id === selectedId;
          const telemetry = room?.telemetry;
          const airlock = box.id === "airlock" ? airlockLabel(room) : null;
          const label = titleCase(box.id);
          const compact = box.h <= 130;

          return (
            <g
              key={box.id}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={`${label}${telemetry?.temperatureC !== undefined ? `, ${formatNumber(telemetry?.temperatureC, 1)} °C` : ""}`}
              onClick={() => onSelect(box.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(box.id);
                }
              }}
              className="cursor-pointer focus:outline-none"
            >
              <rect
                x={box.x}
                y={box.y}
                width={box.w}
                height={box.h}
                rx={4}
                fill={TONE_FILL[tone]}
                stroke={selected ? "#ffc978" : TONE_STROKE[tone]}
                strokeWidth={selected ? 3 : 1.5}
                strokeDasharray={tone === "neutral" && !room ? "5 4" : undefined}
              />

              <text
                x={box.x + 10}
                y={box.y + 22}
                fontSize={compact ? 10 : 11}
                fill="#a89285"
                letterSpacing={0.8}
                className="font-mono uppercase"
              >
                {label}
              </text>

              <circle cx={box.x + box.w - 14} cy={box.y + 18} r={3.5} fill={
                tone === "alert" ? "#ff4b3e" : tone === "warn" ? "#ffa14b" : tone === "ok" ? "#5fd39b" : "#5a4033"
              } />

              <text
                x={box.x + 12}
                y={box.y + (compact ? 54 : 72)}
                fontSize={compact ? 22 : 34}
                fill={TONE_INK[tone]}
                className="font-mono"
              >
                {typeof telemetry?.temperatureC === "number"
                  ? formatNumber(telemetry.temperatureC, 1)
                  : "—"}
                <tspan fontSize={compact ? 11 : 14} fill="#a89285">
                  {" °C"}
                </tspan>
              </text>

              <text
                x={box.x + 12}
                y={box.y + (compact ? 76 : 104)}
                fontSize={10}
                fill="#a89285"
                className="font-mono"
              >
                {`co₂ ${typeof telemetry?.co2Ppm === "number" ? Math.round(telemetry.co2Ppm) : "—"} ppm`}
              </text>
              <text
                x={box.x + 12}
                y={box.y + (compact ? 92 : 120)}
                fontSize={10}
                fill="#a89285"
                className="font-mono"
              >
                {`o₂ ${formatNumber(telemetry?.o2Pct, 1)} % · ${typeof telemetry?.lightingLux === "number" ? Math.round(telemetry.lightingLux) : "—"} lx`}
              </text>

              {(!compact || airlock) && (
                <text
                  x={box.x + 12}
                  y={box.y + (compact ? 108 : box.h - 44)}
                  fontSize={10}
                  fill="#a89285"
                  className="font-mono"
                >
                  {airlock ?? `${telemetry?.crewCount ?? 0} crew`}
                  {room ? ` · ${timeAgo(room.timestamp, now)}` : " · no telemetry"}
                </text>
              )}
              {!compact && !airlock && (
                <text
                  x={box.x + 12}
                  y={box.y + box.h - 26}
                  fontSize={10}
                  fill="#a89285"
                  className="font-mono"
                >
                  {telemetry ? `${formatNumber(telemetry.humidityPct, 0)} % rh · ${formatNumber(telemetry.pressureKpa, 1)} kPa` : ""}
                </text>
              )}
            </g>
          );
        })}

        {DOORS.map(([x1, y1, x2, y2]) => (
          <line
            key={`${x1}-${y1}-${x2}-${y2}`}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke="#120d0c"
            strokeWidth={6}
            pointerEvents="none"
          />
        ))}
      </svg>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] uppercase tracking-[0.12em] text-console-muted">
        <span className="flex items-center gap-1.5">
          <Badge tone="ok">nominal</Badge>
        </span>
        <span className="flex items-center gap-1.5">
          <Badge tone="warn">cycling</Badge>
        </span>
        <span className="flex items-center gap-1.5">
          <Badge tone="alert">co₂ / airlock</Badge>
        </span>
        <span className="flex items-center gap-1.5">
          <StatusDot tone="neutral" />
          no telemetry
        </span>
      </div>
    </div>
  );
}
