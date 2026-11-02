import { EventEmitter } from "node:events";
import type { AlertRecord, TelemetryEvent } from "./types";

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
  on(event: "telemetry", listener: (payload: TelemetryEvent) => void): this;
  on(event: "alert", listener: (payload: AlertRecord) => void): this;
  on(event: "worker", listener: (payload: WorkerStatusEvent) => void): this;
  off(event: "telemetry", listener: (payload: TelemetryEvent) => void): this;
  off(event: "alert", listener: (payload: AlertRecord) => void): this;
  off(event: "worker", listener: (payload: WorkerStatusEvent) => void): this;
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
