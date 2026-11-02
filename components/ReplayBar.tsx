"use client";

import { formatDateTime, formatDuration, formatTime } from "@/lib/format";
import { THEME } from "@/lib/theme";
import { REPLAY_SPEEDS, STEP_MS, useTelemetry } from "@/lib/telemetry-store";
import { ConnectionBadge } from "./ConnectionBadge";
import { Badge } from "./ui";

function IconRewind() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
      <path d="M11 6v12L2 12l9-6zm11 0v12l-9-6 9-6z" />
    </svg>
  );
}

function IconForward() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
      <path d="M13 6v12l9-6-9-6zM2 6v12l9-6-9-6z" />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
      <path d="M7 4l14 8-14 8V4z" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
      <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
    </svg>
  );
}

/**
 * Replay transport bar.
 *
 * Live mode streams SSE through the dashboard store. Selecting Replay (or
 * pressing play/rewind) swaps the data source to `/api/replay` snapshot
 * queries driven by the scrubber cursor, so every downstream panel renders
 * exactly the same shapes.
 */
export function ReplayBar({ service }: { service?: string }) {
  const {
    mode,
    playing,
    speed,
    cursorMs,
    bounds,
    loading,
    connection,
    lastTelemetryAt,
    setMode,
    setCursorMs,
    setPlaying,
    setSpeed,
    step,
    refreshBounds,
  } = useTelemetry();

  const latestMs = bounds.latest ? Date.parse(bounds.latest) : null;
  const earliestMs = bounds.earliest ? Date.parse(bounds.earliest) : null;
  const hasWindow = Boolean(latestMs && earliestMs && latestMs > earliestMs);
  const sliderMin = earliestMs ?? 0;
  const sliderMax = latestMs ?? cursorMs;
  const windowMs = hasWindow && earliestMs ? latestMs! - earliestMs : 0;

  const enterReplayAt = (targetMs: number) => {
    if (mode !== "replay") setMode("replay");
    setCursorMs(targetMs);
    setPlaying(false);
  };

  const handlePlayPause = () => {
    if (mode === "live") {
      // Playing from a live dashboard means "replay from the start of the window".
      setMode("replay");
      if (earliestMs) setCursorMs(earliestMs);
      setPlaying(true);
      return;
    }
    if (!playing && latestMs && cursorMs >= latestMs - 1000) {
      setCursorMs(earliestMs ?? cursorMs);
    }
    setPlaying(!playing);
  };

  const handleRewind = () => {
    if (mode === "live") {
      enterReplayAt((latestMs ?? Date.now()) - STEP_MS);
      return;
    }
    step(-STEP_MS);
  };

  const handleForward = () => {
    if (mode === "live") return;
    step(STEP_MS);
  };

  // Gold while the dashboard is on the live edge, amber once the cursor is in
  // history — the transport bar changes colour with the data source.
  return (
    <section
      className="panel panel-accent px-4 py-3"
      style={{ "--accent": mode === "replay" ? THEME.warn : THEME.solar } as React.CSSProperties}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex items-center gap-2">
          <span className="panel-title">Replay</span>
          <div className="flex overflow-hidden rounded-md border border-console-edge">
            <button
              type="button"
              onClick={() => setMode("live")}
              className={`px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors ${
                mode === "live" ? "bg-console-signal/20 text-console-signal" : "text-console-muted hover:text-console-ink"
              }`}
              aria-pressed={mode === "live"}
            >
              Live
            </button>
            <button
              type="button"
              onClick={() => setMode("replay")}
              className={`border-l border-console-edge px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors ${
                mode === "replay" ? "bg-console-warn/20 text-console-warn" : "text-console-muted hover:text-console-ink"
              }`}
              aria-pressed={mode === "replay"}
            >
              Replay
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button type="button" className="btn px-2" onClick={handleRewind} title="Rewind 5 minutes" aria-label="Rewind 5 minutes">
            <IconRewind />
          </button>
          <button
            type="button"
            className={`btn px-2 ${playing ? "btn-warn" : "btn-primary"}`}
            onClick={handlePlayPause}
            title={playing ? "Pause replay" : "Play replay"}
            aria-label={playing ? "Pause replay" : "Play replay"}
          >
            {playing ? <IconPause /> : <IconPlay />}
          </button>
          <button
            type="button"
            className="btn px-2"
            onClick={handleForward}
            disabled={mode === "live"}
            title="Fast-forward 5 minutes"
            aria-label="Fast-forward 5 minutes"
          >
            <IconForward />
          </button>
          <div className="ml-1 flex overflow-hidden rounded-md border border-console-edge">
            {REPLAY_SPEEDS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setSpeed(value)}
                className={`px-2 py-1 font-mono text-[10px] transition-colors ${
                  speed === value ? "bg-console-info/20 text-console-info" : "text-console-muted hover:text-console-ink"
                }`}
                aria-pressed={speed === value}
              >
                {value}x
              </button>
            ))}
          </div>
        </div>

        <div className="flex min-w-[260px] flex-1 flex-col gap-1">
          <input
            type="range"
            className="scrubber"
            min={sliderMin}
            max={sliderMax}
            step={1000}
            value={Math.min(Math.max(cursorMs, sliderMin), sliderMax)}
            disabled={!hasWindow}
            onChange={(event) => {
              setPlaying(false);
              if (mode !== "replay") setMode("replay");
              setCursorMs(Number(event.target.value));
            }}
            aria-label="Historical scrubber"
          />
          <div className="flex items-center justify-between font-mono text-[10px] text-console-muted">
            <span>{earliestMs ? formatTime(bounds.earliest) : "--:--:--"}</span>
            <span className="text-console-ink">
              {mode === "replay" ? formatDateTime(new Date(cursorMs).toISOString()) : "live edge"}
            </span>
            <span>{latestMs ? formatTime(bounds.latest) : "--:--:--"}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <ConnectionBadge />
          <Badge tone="neutral">
            {bounds.samples.toLocaleString()} samples
          </Badge>
          {hasWindow && <Badge tone="neutral">window {formatDuration(windowMs)}</Badge>}
          {loading && <Badge tone="info">loading</Badge>}
          {mode === "replay" ? (
            <button type="button" className="btn" onClick={() => setMode("live")}>
              Jump to live
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={() => void refreshBounds()}
              title={`Last telemetry ${lastTelemetryAt ? formatTime(lastTelemetryAt) : "never"}`}
            >
              Sync window
            </button>
          )}
          {connection === "offline" && (
            <Badge tone="alert">broker offline — replay still available</Badge>
          )}
          {service && <span className="text-[10px] uppercase tracking-[0.14em] text-console-muted">{service}</span>}
        </div>
      </div>
    </section>
  );
}
