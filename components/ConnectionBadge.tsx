"use client";

import { useTelemetry } from "@/lib/telemetry-store";
import { Badge, StatusDot, type Tone } from "./ui";

const STATE_META: Record<string, { label: string; tone: Tone; pulse: boolean }> = {
  live: { label: "Live", tone: "ok", pulse: true },
  connecting: { label: "Connecting", tone: "info", pulse: true },
  reconnecting: { label: "Reconnecting", tone: "warn", pulse: true },
  offline: { label: "Broker offline", tone: "alert", pulse: true },
  error: { label: "Stream error", tone: "alert", pulse: false },
  replay: { label: "Replay", tone: "warn", pulse: false },
};

/** Compact transport indicator shared by the dashboards and the replay bar. */
export function ConnectionBadge() {
  const { connection, brokerState } = useTelemetry();
  const meta = STATE_META[connection] ?? STATE_META.connecting;
  const showBroker = connection !== "replay" && brokerState && brokerState !== "connected";

  return (
    <span className="flex items-center gap-2">
      <Badge tone={meta.tone}>
        <StatusDot tone={meta.tone} pulse={meta.pulse} />
        {meta.label}
      </Badge>
      {showBroker && <span className="text-[10px] uppercase tracking-[0.14em] text-console-muted">mqtt: {brokerState}</span>}
    </span>
  );
}
