"use client";

const TONE_HEX = {
  signal: "#38f2c3",
  ok: "#4ade80",
  warn: "#ffab4a",
  alert: "#ff5d5d",
  info: "#67b6ff",
  solar: "#ffd166",
} as const;

/** 270° SVG gauge used for battery reserve and plant load factor. */
export function Gauge({
  value,
  max = 100,
  label,
  unit = "%",
  tone = "signal",
  caption,
  digits = 1,
}: {
  value: number | null;
  max?: number;
  label: string;
  unit?: string;
  tone?: keyof typeof TONE_HEX;
  caption?: string;
  digits?: number;
}) {
  const safe = value === null || !Number.isFinite(value) ? 0 : value;
  const ratio = Math.min(Math.max(safe / max, 0), 1);
  const radius = 56;
  const circumference = 2 * Math.PI * radius;
  const arc = circumference * 0.75;
  const color = TONE_HEX[tone] ?? TONE_HEX.signal;

  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 160 150" className="h-32 w-32" role="img" aria-label={`${label}: ${value ?? "no data"} ${unit}`}>
        <circle
          cx="80"
          cy="76"
          r={radius}
          fill="none"
          stroke="#1c2533"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${arc} ${circumference}`}
          transform="rotate(135 80 76)"
        />
        <circle
          cx="80"
          cy="76"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${arc * ratio} ${circumference}`}
          transform="rotate(135 80 76)"
          style={{ filter: `drop-shadow(0 0 6px ${color}66)`, transition: "stroke-dasharray 400ms ease" }}
        />
        <text x="80" y="74" textAnchor="middle" className="fill-console-ink" style={{ fontSize: 24, fontFamily: "ui-monospace, monospace" }}>
          {value === null || !Number.isFinite(value) ? "—" : safe.toFixed(digits)}
        </text>
        <text x="80" y="94" textAnchor="middle" className="fill-console-muted" style={{ fontSize: 10, letterSpacing: 1.5 }}>
          {unit}
        </text>
        <text x="80" y="132" textAnchor="middle" className="fill-console-muted" style={{ fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase" }}>
          {label}
        </text>
      </svg>
      {caption && <p className="-mt-1 text-[10px] uppercase tracking-[0.12em] text-console-muted">{caption}</p>}
    </div>
  );
}
