import { EventEmitter } from "node:events";
import type {
  AlertRecord,
  CommandAck,
  CommandResult,
  IngestService,
  TelemetryEvent,
} from "./types";

/** A non-alert service event (scan lifecycle, survey, EVA, refuel). */
export interface ServiceEvent {
  service: IngestService;
  kind: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

/**
 * Single in-process fan-out point between the MQTT ingestion worker and the
 * SSE route handlers. In development Next.js re-evaluates module scopes on
 * hot reload, so the emitter is pinned on `globalThis` to keep a single
 * instance for the lifetime of the server process.
 */
export interface TelemetryEmitter extends EventEmitter {
  emit(event: "telemetry", payload: TelemetryEvent): boolean;
  emit(event: "alert", payload: AlertRecord): boolean;
  emit(event: "worker", payload: WorkerStatusEvent): boolean;
  emit(event: "event", payload: ServiceEvent): boolean;
  emit(event: "ack", payload: CommandAck): boolean;
  emit(event: "command", payload: CommandResult): boolean;
  on(event: "telemetry", listener: (payload: TelemetryEvent) => void): this;
  on(event: "alert", listener: (payload: AlertRecord) => void): this;
  on(event: "worker", listener: (payload: WorkerStatusEvent) => void): this;
  on(event: "event", listener: (payload: ServiceEvent) => void): this;
  on(event: "ack", listener: (payload: CommandAck) => void): this;
  on(event: "command", listener: (payload: CommandResult) => void): this;
  off(event: "telemetry", listener: (payload: TelemetryEvent) => void): this;
  off(event: "alert", listener: (payload: AlertRecord) => void): this;
  off(event: "worker", listener: (payload: WorkerStatusEvent) => void): this;
  off(event: "event", listener: (payload: ServiceEvent) => void): this;
  off(event: "ack", listener: (payload: CommandAck) => void): this;
  off(event: "command", listener: (payload: CommandResult) => void): this;
}

export interface WorkerStatusEvent {
  state: "idle" | "connecting" | "connected" | "reconnecting" | "offline" | "error";
  detail?: string;
  at: string;
}

const globalForEvents = globalThis as unknown as {
  telemetryEmitter?: TelemetryEmitter;
};

export const telemetryEmitter: TelemetryEmitter =
  globalForEvents.telemetryEmitter ?? (new EventEmitter() as TelemetryEmitter);

// SSE fan-out plus long-lived replay consumers exceed the default limit of 10.
telemetryEmitter.setMaxListeners(0);

globalForEvents.telemetryEmitter = telemetryEmitter;

export function publishTelemetry(event: TelemetryEvent): void {
  telemetryEmitter.emit("telemetry", event);
}

export function publishAlert(alert: AlertRecord): void {
  telemetryEmitter.emit("alert", alert);
}

export function publishWorkerStatus(status: WorkerStatusEvent): void {
  telemetryEmitter.emit("worker", status);
}

/** Non-alert service event (scan lifecycle, survey, EVA, refuel). */
export function publishServiceEvent(event: ServiceEvent): void {
  telemetryEmitter.emit("event", event);
}

/** Every ack received for a command this platform published. */
export function publishAck(ack: CommandAck): void {
  telemetryEmitter.emit("ack", ack);
}

/** Terminal outcome of a command (ack completed/rejected/failed, or timeout). */
export function publishCommandResult(result: CommandResult): void {
  telemetryEmitter.emit("command", result);
}
