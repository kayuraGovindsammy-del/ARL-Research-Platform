"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  acknowledgeAlertRequest,
  ApiError,
  getJson,
  resolveAlertRequest,
} from "./api-client";
import { parseSurveyEvent } from "./mhe-selectors";
import type {
  AlertRecord,
  AlertStatus,
  CommandAck,
  CommandResult,
  MheCrewSurvey,
  ReplaySnapshot,
  Service,
  TelemetryEvent,
  TopicState,
} from "./types";

/**
 * Single client-side store per dashboard.
 *
 * Owns exactly one EventSource for the page, merges live telemetry into a
 * topic map, keeps the alert annunciator in sync, and exposes the replay
 * transport (cursor + playback) that ReplayBar drives. Switching to replay
 * swaps the data source from SSE to `/api/replay` snapshots without touching
 * any of the dashboard components.
 */

export type ConnectionState =
  | "connecting"
  | "live"
  | "reconnecting"
  | "offline"
  | "error"
  | "replay";

export interface ReplayBounds {
  earliest: string | null;
  latest: string | null;
  samples: number;
}

export const REPLAY_SPEEDS = [1, 2, 4, 8] as const;
const STEP_MS = 5 * 60 * 1000;
const MAX_ALERTS = 200;
const STREAM_BUFFER = 900;
const EVENT_BUFFER = 400;
const COMMAND_BUFFER = 40;

/** A non-alert service event, mirroring `lib/events.ts` on the server. */
export interface ServiceEvent {
  service: string;
  kind: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface TelemetryStoreValue {
  service: Service | null;
  mode: "live" | "replay";
  playing: boolean;
  speed: number;
  cursorMs: number;
  bounds: ReplayBounds;
  loading: boolean;
  topics: Record<string, TopicState>;
  /** Ring buffer of recent live events, for high-frequency consumers (scan heatmap). */
  stream: TelemetryEvent[];
  /** Non-alert service events: scan lifecycle, surveys, EVA, refuel. */
  events: ServiceEvent[];
  /** Latest wellbeing survey per crew member, folded from `events/survey`. */
  surveys: MheCrewSurvey[];
  /** Acknowledgements received since this page opened, newest first. */
  acks: CommandAck[];
  /** Terminal outcomes of commands this page published, newest first. */
  commands: CommandResult[];
  alerts: AlertRecord[];
  counts: Record<AlertStatus, number>;
  alertsLoading: boolean;
  connection: ConnectionState;
  brokerState: string | null;
  lastTelemetryAt: string | null;
  error: string | null;
  setMode: (mode: "live" | "replay") => void;
  setCursorMs: (value: number) => void;
  setPlaying: (playing: boolean) => void;
  setSpeed: (speed: number) => void;
  step: (deltaMs: number) => void;
  refreshBounds: () => Promise<void>;
  reloadAlerts: () => Promise<void>;
  acknowledge: (id: string, researcher: string, note?: string) => Promise<void>;
  resolve: (id: string, researcher: string, note: string) => Promise<void>;
  clearError: () => void;
}

const TelemetryContext = createContext<TelemetryStoreValue | null>(null);

function serviceQuery(service: Service | null, prefix: "?" | "&" = "?"): string {
  return service ? `${prefix}service=${service}` : "";
}

function upsertAlert(list: AlertRecord[], alert: AlertRecord): AlertRecord[] {
  const next = [alert, ...list.filter((entry) => entry.id !== alert.id)];
  return next
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, MAX_ALERTS);
}

export function TelemetryProvider({
  service,
  children,
}: {
  service: Service | null;
  children: React.ReactNode;
}) {
  const [mode, setModeState] = useState<"live" | "replay">("live");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(2);
  const [cursorMs, setCursorMsState] = useState<number>(() => Date.now());
  const [bounds, setBounds] = useState<ReplayBounds>({
    earliest: null,
    latest: null,
    samples: 0,
  });
  const [topics, setTopics] = useState<Record<string, TopicState>>({});
  const [stream, setStream] = useState<TelemetryEvent[]>([]);
  const [events, setEvents] = useState<ServiceEvent[]>([]);
  const [acks, setAcks] = useState<CommandAck[]>([]);
  const [commands, setCommands] = useState<CommandResult[]>([]);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [counts, setCounts] = useState<Record<AlertStatus, number>>({
    ACTIVE: 0,
    ACKNOWLEDGED: 0,
    RESOLVED: 0,
  });
  const [alertsLoading, setAlertsLoading] = useState(true);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [brokerState, setBrokerState] = useState<string | null>(null);
  const [lastTelemetryAt, setLastTelemetryAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alertRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadAlerts = useCallback(async () => {
    try {
      const response = await getJson<{
        alerts: AlertRecord[];
        counts: Record<AlertStatus, number>;
      }>(`/api/alerts?limit=${MAX_ALERTS}${serviceQuery(service, "&")}`);
      setAlerts(response.alerts);
      setCounts(response.counts);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAlertsLoading(false);
    }
  }, [service]);

  useEffect(() => {
    setAlertsLoading(true);
    void loadAlerts();
  }, [loadAlerts]);

  const scheduleAlertRefresh = useCallback(() => {
    if (alertRefreshTimer.current) clearTimeout(alertRefreshTimer.current);
    alertRefreshTimer.current = setTimeout(() => {
      alertRefreshTimer.current = null;
      void loadAlerts();
    }, 400);
  }, [loadAlerts]);

  useEffect(
    () => () => {
      if (alertRefreshTimer.current) clearTimeout(alertRefreshTimer.current);
    },
    [],
  );

  // --- Live transport: one EventSource per dashboard ----------------------
  useEffect(() => {
    if (mode !== "live") return;

    let cancelled = false;
    setTopics({});
    setStream([]);
    setEvents([]);
    setAcks([]);
    setCommands([]);
    setConnection("connecting");
    setError(null);

    const hydrate = async () => {
      try {
        const snapshot = await getJson<ReplaySnapshot>(
          `/api/telemetry${serviceQuery(service)}`,
        );
        if (cancelled) return;
        // Live samples arriving during hydration win over the snapshot.
        setTopics((previous) => ({ ...snapshot.topics, ...previous }));
        // A transient failure (or a request cancelled by navigation) must not
        // leave a permanent banner once data is flowing again.
        setError(null);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    };
    void hydrate();

    const source = new EventSource(`/api/stream${serviceQuery(service)}`);

    source.addEventListener("open", () => {
      if (!cancelled) setConnection("live");
    });

    source.addEventListener("ready", (event) => {
      if (cancelled) return;
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          brokerConnected: boolean;
          brokerState: string;
        };
        setBrokerState(payload.brokerState);
        setConnection(payload.brokerConnected ? "live" : "offline");
      } catch {
        // ignore malformed handshake
      }
    });

    source.addEventListener("telemetry", (event) => {
      if (cancelled) return;
      try {
        const payload = JSON.parse((event as MessageEvent).data) as TelemetryEvent;
        setTopics((previous) => ({
          ...previous,
          [payload.topic]: {
            topic: payload.topic,
            payload: payload.payload,
            timestamp: payload.timestamp,
          },
        }));
        setLastTelemetryAt(payload.timestamp);
        setConnection("live");
        setStream((previous) => {
          const next = previous.length >= STREAM_BUFFER ? previous.slice(previous.length - STREAM_BUFFER + 1) : previous;
          return [...next, payload];
        });
      } catch {
        // ignore malformed frame
      }
    });

    source.addEventListener("alert", (event) => {
      if (cancelled) return;
      try {
        const payload = JSON.parse((event as MessageEvent).data) as AlertRecord;
        setAlerts((previous) => upsertAlert(previous, payload));
        scheduleAlertRefresh();
      } catch {
        // ignore malformed frame
      }
    });

    source.addEventListener("event", (event) => {
      if (cancelled) return;
      try {
        const payload = JSON.parse((event as MessageEvent).data) as ServiceEvent;
        setEvents((previous) => {
          const next =
            previous.length >= EVENT_BUFFER
              ? previous.slice(previous.length - EVENT_BUFFER + 1)
              : previous;
          return [...next, payload];
        });
      } catch {
        // ignore malformed frame
      }
    });

    source.addEventListener("ack", (event) => {
      if (cancelled) return;
      try {
        const payload = JSON.parse((event as MessageEvent).data) as CommandAck;
        setAcks((previous) => [payload, ...previous].slice(0, COMMAND_BUFFER));
      } catch {
        // ignore malformed frame
      }
    });

    source.addEventListener("command", (event) => {
      if (cancelled) return;
      try {
        const payload = JSON.parse((event as MessageEvent).data) as CommandResult;
        setCommands((previous) => [payload, ...previous].slice(0, COMMAND_BUFFER));
      } catch {
        // ignore malformed frame
      }
    });

    source.addEventListener("worker", (event) => {
      if (cancelled) return;
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { state: string };
        setBrokerState(payload.state);
        if (payload.state === "connected") setConnection("live");
        if (payload.state === "offline" || payload.state === "reconnecting") {
          setConnection("reconnecting");
        }
      } catch {
        // ignore malformed frame
      }
    });

    source.addEventListener("error", () => {
      if (!cancelled) setConnection("reconnecting");
    });

    return () => {
      cancelled = true;
      source.close();
    };
  }, [mode, service, scheduleAlertRefresh]);

  // --- Replay transport: snapshot per cursor position ---------------------
  useEffect(() => {
    if (mode !== "replay") return;

    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setConnection("replay");

    const timer = setTimeout(async () => {
      try {
        const snapshot = await getJson<ReplaySnapshot>(
          `/api/replay?timestamp=${encodeURIComponent(new Date(cursorMs).toISOString())}${serviceQuery(
            service,
            "&",
          )}`,
          controller.signal,
        );
        if (cancelled) return;
        setTopics(snapshot.topics);
        setStream([]);
        setError(null);
      } catch (caught) {
        if (cancelled || (caught as Error)?.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 120);

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [mode, cursorMs, service]);

  const refreshBounds = useCallback(async () => {
    try {
      const response = await getJson<ReplayBounds>(
        `/api/replay?bounds=1${serviceQuery(service, "&")}`,
      );
      setBounds(response);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [service]);

  useEffect(() => {
    void refreshBounds();
  }, [refreshBounds]);

  // Keep the scrubber window aligned with the incoming live data.
  useEffect(() => {
    if (mode !== "live") return;
    const timer = setInterval(() => void refreshBounds(), 60_000);
    return () => clearInterval(timer);
  }, [mode, refreshBounds]);

  const clampCursor = useCallback(
    (value: number) => {
      const earliest = bounds.earliest ? Date.parse(bounds.earliest) : 0;
      const latest = bounds.latest ? Date.parse(bounds.latest) : Date.now();
      return Math.min(Math.max(value, earliest || 0), Math.max(latest, earliest || 0));
    },
    [bounds.earliest, bounds.latest],
  );

  const setCursorMs = useCallback(
    (value: number) => {
      if (!Number.isFinite(value)) return;
      setCursorMsState(clampCursor(value));
    },
    [clampCursor],
  );

  const setMode = useCallback(
    (next: "live" | "replay") => {
      setModeState(next);
      if (next === "replay") {
        setPlaying(false);
        setCursorMsState(bounds.latest ? Date.parse(bounds.latest) : Date.now());
        void refreshBounds();
      } else {
        setPlaying(false);
      }
    },
    [bounds.latest, refreshBounds],
  );

  const step = useCallback(
    (deltaMs: number) => {
      setPlaying(false);
      setCursorMsState((current) => clampCursor(current + deltaMs));
    },
    [clampCursor],
  );

  // Playback clock: advance the cursor at the selected multiplier.
  useEffect(() => {
    if (mode !== "replay" || !playing) return;
    const latestMs = bounds.latest ? Date.parse(bounds.latest) : Date.now();

    const timer = setInterval(() => {
      setCursorMsState((current) => {
        const next = current + 1000 * speed;
        if (next >= latestMs) {
          setPlaying(false);
          return latestMs;
        }
        return next;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [mode, playing, speed, bounds.latest]);

  const reloadAlerts = useCallback(async () => {
    await loadAlerts();
  }, [loadAlerts]);

  const acknowledge = useCallback(
    async (id: string, researcher: string, note?: string) => {
      try {
        const { alert } = await acknowledgeAlertRequest(id, researcher, note);
        setAlerts((previous) => upsertAlert(previous, alert));
        await loadAlerts();
      } catch (caught) {
        throw caught instanceof ApiError
          ? caught
          : new Error(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [loadAlerts],
  );

  const resolve = useCallback(
    async (id: string, researcher: string, note: string) => {
      try {
        const { alert } = await resolveAlertRequest(id, researcher, note);
        setAlerts((previous) => upsertAlert(previous, alert));
        await loadAlerts();
      } catch (caught) {
        throw caught instanceof ApiError
          ? caught
          : new Error(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [loadAlerts],
  );

  // Surveys are events, not retained state: one topic carries every crew
  // member's submission, so the per-crew view is folded here from the buffer.
  const surveys = useMemo<MheCrewSurvey[]>(() => {
    const latest = new Map<string, MheCrewSurvey>();
    for (const event of events) {
      if (event.kind !== "survey") continue;
      const survey = parseSurveyEvent(event.payload, event.timestamp);
      if (!survey) continue;
      const existing = latest.get(survey.crewId);
      if (
        !existing ||
        Date.parse(survey.submittedAt ?? "") >= Date.parse(existing.submittedAt ?? "")
      ) {
        latest.set(survey.crewId, survey);
      }
    }
    return Array.from(latest.values()).sort((a, b) => a.crewId.localeCompare(b.crewId));
  }, [events]);

  const value = useMemo<TelemetryStoreValue>(
    () => ({
      service,
      mode,
      playing,
      speed,
      cursorMs,
      bounds,
      loading,
      topics,
      stream,
      events,
      surveys,
      acks,
      commands,
      alerts,
      counts,
      alertsLoading,
      connection,
      brokerState,
      lastTelemetryAt,
      error,
      setMode,
      setCursorMs,
      setPlaying,
      setSpeed,
      step,
      refreshBounds,
      reloadAlerts,
      acknowledge,
      resolve,
      clearError: () => setError(null),
    }),
    [
      service,
      mode,
      playing,
      speed,
      cursorMs,
      bounds,
      loading,
      topics,
      stream,
      events,
      surveys,
      acks,
      commands,
      alerts,
      counts,
      alertsLoading,
      connection,
      brokerState,
      lastTelemetryAt,
      error,
      setMode,
      setCursorMs,
      step,
      refreshBounds,
      reloadAlerts,
      acknowledge,
      resolve,
    ],
  );

  return <TelemetryContext.Provider value={value}>{children}</TelemetryContext.Provider>;
}

export function useTelemetry(): TelemetryStoreValue {
  const context = useContext(TelemetryContext);
  if (!context) {
    throw new Error("useTelemetry must be used inside <TelemetryProvider>.");
  }
  return context;
}

/** Convenience selector: all topics whose name ends with `/<suffix>`. */
export function selectTopics(
  topics: Record<string, TopicState>,
  suffix: string,
): TopicState[] {
  return Object.values(topics).filter((state) => state.topic.endsWith(`/${suffix}`));
}

export { STEP_MS };
