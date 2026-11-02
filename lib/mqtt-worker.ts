import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import { clearServiceAlert, raiseServiceAlert, type ServiceAlertEvent } from "./alerts";
import { env, mqttBrokerUrl } from "./env";
import {
  publishAck,
  publishCommandResult,
  publishServiceEvent,
  publishTelemetry,
  publishWorkerStatus,
} from "./events";
import { prisma, withDbRetry } from "./prisma";
import { scanTargetLabel } from "./rta-selectors";
import { commandTopic, parseTopic, telemetryWildcard } from "./topics";
import type {
  CommandAck,
  CommandOutcome,
  CommandResult,
  IngestService,
  RtaScanContext,
  TelemetryEvent,
  Topology,
} from "./types";

/**
 * In-memory MQTT ingestion worker.
 *
 * Responsibilities:
 *  - one persistent client per server process (pinned on `globalThis`)
 *  - subscribe to the whole `arl/#` tree
 *  - remember the retained `$topology` document of every service
 *  - fan telemetry/state/events out to SSE and persist them in batches
 *  - turn `arl/<svc>/events/alert` into Alert rows (raised/cleared)
 *  - publish operator commands and correlate the `ack/<command_id>` reply
 *
 * Reconnection is implemented explicitly (exponential backoff capped at 30s)
 * instead of relying on the library's fixed reconnectPeriod, so a broker
 * restart does not produce a reconnect stampede.
 */

export type WorkerState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "error";

export interface WorkerStatus {
  state: WorkerState;
  brokerUrl: string | null;
  clientId: string | null;
  subscribedTopic: string | null;
  connected: boolean;
  lastMessageAt: string | null;
  lastError: string | null;
  messagesIngested: number;
  alertsRaised: number;
  droppedMessages: number;
  pendingWrites: number;
  reconnectAttempts: number;
  startedAt: string | null;
}

const MAX_PAYLOAD_BYTES = 256 * 1024;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const STALE_TICK_MS = 60_000;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 15 * 60 * 1000;

/** A service that has published nothing for this long is considered silent. */
const SERVICE_SILENCE_MS = 5 * 60 * 1000;

/** Samples are persisted in batches rather than one transaction per message. */
const FLUSH_INTERVAL_MS = 250;
const MAX_PENDING_SAMPLES = 20_000;

/** Commands that legitimately take longer before reaching a terminal ack. */
const COMMAND_TIMEOUT_MS: Record<string, number> = {
  start_generator: 45_000,
  stop_generator: 75_000,
  request_recalibration: 20_000,
  cycle_airlock: 30_000,
};
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

interface PendingSample {
  id: string;
  service: IngestService;
  topic: string;
  payload: string;
  timestamp: Date;
}

function parsePayload(buffer: Buffer): Record<string, unknown> | null {
  if (buffer.length > MAX_PAYLOAD_BYTES) return null;
  const text = buffer.toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    // Non-JSON telemetry is still valuable for replay: keep the raw text.
    return { raw: text };
  }
}

/**
 * The services stamp `ts` (ms since epoch). Keeping it makes replay reflect the
 * lab clock instead of our receive time, but bogus values are rejected.
 */
function resolveTimestamp(payload: Record<string, unknown>, now: Date): Date {
  const candidate = payload.ts ?? payload.timestamp;
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    const value = candidate > 1e12 ? candidate : candidate * 1000;
    const date = new Date(value);
    if (Math.abs(date.getTime() - now.getTime()) < RETENTION_MS) return date;
  }
  if (typeof candidate === "string" && candidate.trim()) {
    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime()) && Math.abs(date.getTime() - now.getTime()) < RETENTION_MS) {
      return date;
    }
  }
  return now;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toAlertEvent(payload: Record<string, unknown>): ServiceAlertEvent | null {
  const alertId = str(payload.alert_id);
  const type = str(payload.type);
  const state = str(payload.state);
  if (!alertId || !type || !state) return null;
  return {
    alertId,
    type,
    state,
    severity: str(payload.severity) ?? "warning",
    value: num(payload.value),
    limit: num(payload.limit),
    unit: str(payload.unit),
    message: str(payload.message),
    entity: str(payload.entity),
    metadata:
      payload.metadata && typeof payload.metadata === "object"
        ? (payload.metadata as Record<string, unknown>)
        : undefined,
  };
}

function toScanContext(payload: Record<string, unknown>, at: Date): RtaScanContext | null {
  if (str(payload.event) !== "started") return null;
  const scanId = str(payload.scan_id);
  const ra = num(payload.ra_rad);
  const dec = num(payload.dec_rad);
  const fov = num(payload.fov_rad);
  if (!scanId || ra === null || dec === null || fov === null) return null;
  return {
    scanId,
    target: scanTargetLabel(payload),
    raRad: ra,
    decRad: dec,
    fovRad: fov,
    bandHz: num(payload.band_hz) ?? 0,
    gridSize: num(payload.grid_size) ?? 128,
    overlap: num(payload.overlap) ?? 3,
    dishes: Array.isArray(payload.dishes) ? payload.dishes.map((id) => String(id)) : [],
    expectedDurationS: num(payload.expected_duration_s) ?? 0,
    origin: str(payload.origin) ?? "command",
    startedAt: at.toISOString(),
  };
}

class MqttWorker {
  private client: MqttClient | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private reconnectAttempts = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private pending: PendingSample[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private clientId: string | null = null;

  /** Retained capability documents, keyed by upper-case service code. */
  private topologies = new Map<IngestService, Topology>();
  /** Scan contexts keyed by scan id (started events only). */
  private scans = new Map<string, RtaScanContext>();
  /** Last telemetry timestamp per service, for the silence rule. */
  private lastSeen = new Map<IngestService, number>();
  private silentSince = new Map<IngestService, number>();
  /** Waiters for terminal acks, keyed by command id. */
  private ackWaiters = new Map<
    string,
    { resolve: (ack: CommandAck | null) => void; seen: CommandAck | null }
  >();

  private status: WorkerStatus = {
    state: "idle",
    brokerUrl: null,
    clientId: null,
    subscribedTopic: null,
    connected: false,
    lastMessageAt: null,
    lastError: null,
    messagesIngested: 0,
    alertsRaised: 0,
    droppedMessages: 0,
    pendingWrites: 0,
    reconnectAttempts: 0,
    startedAt: null,
  };

  /** Idempotent bootstrap; safe to call from instrumentation and route handlers. */
  start(): void {
    if (this.client || this.reconnectTimer || this.stopping) return;

    try {
      const config = env();
      this.status.brokerUrl = mqttBrokerUrl();
      this.status.subscribedTopic = telemetryWildcard(config.MQTT_TOPIC_PREFIX);
      this.status.startedAt = new Date().toISOString();
      this.clientId = `arl-platform-${process.pid.toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      this.status.clientId = this.clientId;

      this.startTimers();
      this.connect();
    } catch (error) {
      this.fail(error);
    }
  }

  private connect(): void {
    if (this.stopping) return;
    const config = env();
    this.reconnectAttempts += 1;
    this.status.reconnectAttempts = this.reconnectAttempts;
    this.setStatus(this.reconnectAttempts === 1 ? "connecting" : "reconnecting");

    const options: IClientOptions = {
      clientId: this.clientId ?? undefined,
      protocolVersion: 4,
      clean: true,
      reconnectPeriod: 0, // reconnection is handled by scheduleReconnect()
      connectTimeout: 15_000,
      keepalive: 30,
      username: config.MQTT_BROKER_USER || undefined,
      password: config.MQTT_BROKER_PASSWORD || undefined,
      resubscribe: true,
    };

    const client = mqtt.connect(mqttBrokerUrl(), options);
    this.client = client;

    client.on("connect", () => {
      const wildcard = telemetryWildcard(config.MQTT_TOPIC_PREFIX);
      this.setStatus("connected", undefined, true);
      this.reconnectAttempts = 0;
      this.status.reconnectAttempts = 0;
      this.silentSince.clear();

      client.subscribe(wildcard, { qos: 1 }, (error) => {
        if (error) {
          console.error(`[mqtt] subscription to ${wildcard} failed:`, error.message);
          this.status.lastError = `Subscribe failed: ${error.message}`;
          return;
        }
        console.info(`[mqtt] connected to ${mqttBrokerUrl()} and subscribed to ${wildcard}`);
      });
    });

    client.on("message", (topic, buffer) => {
      // Parsing and fan-out are synchronous: the live SSE stream must never wait
      // on SQLite. Persistence is batched separately (see flushTelemetry).
      try {
        this.ingest(topic, buffer);
      } catch (error) {
        console.error("[mqtt] ingestion failure:", error);
        this.status.lastError = error instanceof Error ? error.message : String(error);
      }
    });

    client.on("error", (error) => {
      this.status.lastError = error.message;
      if (this.status.state !== "connected") {
        this.setStatus("error", error.message);
      } else {
        console.error("[mqtt] client error:", error.message);
      }
    });

    client.on("offline", () => {
      if (this.status.connected) this.setStatus("reconnecting", "Broker went offline", false);
    });

    client.on("close", () => {
      this.status.connected = false;
      if (this.stopping) {
        this.setStatus("offline");
        return;
      }
      this.setStatus("reconnecting", "Connection closed");
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopping) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempts, 5),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.teardownClient();
      this.connect();
    }, delay);
    // Do not keep the process alive solely for a reconnect timer.
    this.reconnectTimer.unref?.();
  }

  /**
   * Fan a broker message out to live consumers and queue it for persistence.
   *
   * The sample is emitted on `telemetryEmitter` immediately so SSE clients see
   * it without a database round trip; SQLite then receives one `createMany` per
   * flush window instead of one transaction per sample.
   */
  private ingest(topic: string, buffer: Buffer): void {
    const parsed = parseTopic(topic);
    if (!parsed.service || parsed.kind === "command" || parsed.kind === "unknown") return;

    const payload = parsePayload(buffer);
    if (!payload) {
      this.status.droppedMessages += 1;
      return;
    }

    const now = new Date();
    const timestamp = resolveTimestamp(payload, now);
    const service = parsed.service;

    this.status.messagesIngested += 1;
    this.status.lastMessageAt = now.toISOString();
    this.silentSince.delete(service);
    if (parsed.kind === "telemetry") this.lastSeen.set(service, now.getTime());

    if (parsed.kind === "topology") {
      this.topologies.set(service, payload as unknown as Topology);
    }

    // Acks correlate a published command with its outcome; they are not part of
    // the replay model, so they only reach the live command channel + audit row.
    if (parsed.kind === "ack") {
      this.handleAck(payload);
      this.queueSample({
        id: globalThis.crypto.randomUUID(),
        service,
        topic,
        payload: JSON.stringify(payload),
        timestamp,
      });
      return;
    }

    const event: TelemetryEvent = {
      id: globalThis.crypto.randomUUID(),
      service,
      topic,
      payload,
      timestamp: timestamp.toISOString(),
    };
    publishTelemetry(event);

    this.queueSample({
      id: event.id,
      service,
      topic,
      payload: JSON.stringify(payload),
      timestamp,
    });

    if (parsed.kind === "event") {
      this.handleEvent(service, parsed.name ?? "unknown", payload, event.timestamp);
    }
  }

  private handleEvent(
    service: IngestService,
    kind: string,
    payload: Record<string, unknown>,
    timestamp: string,
  ): void {
    publishServiceEvent({ service, kind, payload, timestamp });

    if (kind === "alert") {
      const alertEvent = toAlertEvent(payload);
      if (!alertEvent) return;
      this.enqueue("alert event", async () => {
        if (alertEvent.state === "cleared") {
          const cleared = await clearServiceAlert(service, alertEvent);
          if (cleared) this.status.alertsRaised += 0;
          return;
        }
        const raised = await raiseServiceAlert(service, alertEvent, new Date(timestamp));
        if (raised) this.status.alertsRaised += 1;
      });
      return;
    }

    if (kind === "scan" && service === "RTA") {
      const context = toScanContext(payload, new Date(timestamp));
      if (context) {
        this.scans.set(context.scanId, context);
        if (this.scans.size > 50) {
          const oldest = this.scans.keys().next().value;
          if (oldest) this.scans.delete(oldest);
        }
      }
    }
  }

  private handleAck(payload: Record<string, unknown>): void {
    const ack: CommandAck = {
      ...(payload as unknown as CommandAck),
      command_id: str(payload.command_id) ?? "",
    };
    if (!ack.command_id) return;
    publishAck(ack);

    const waiter = this.ackWaiters.get(ack.command_id);
    if (!waiter) return;
    waiter.seen = ack;
    if (ack.state === "completed" || ack.state === "rejected" || ack.state === "failed") {
      this.ackWaiters.delete(ack.command_id);
      waiter.resolve(ack);
    }
  }

  /** Serialise database work so SQLite never sees concurrent writers. */
  private enqueue(label: string, task: () => Promise<void>): void {
    this.writeChain = this.writeChain.then(task).catch((error) => {
      console.error(`[mqtt] ${label} failure:`, error);
      this.status.lastError = error instanceof Error ? error.message : String(error);
    });
  }

  private queueSample(sample: PendingSample): void {
    if (this.pending.length >= MAX_PENDING_SAMPLES) {
      // The live stream already delivered it; dropping the durable copy beats
      // unbounded memory growth while the database is unreachable.
      this.status.droppedMessages += 1;
      return;
    }
    this.pending.push(sample);
    this.status.pendingWrites = this.pending.length;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.stopping) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.enqueue("telemetry flush", () => this.flushTelemetry());
    }, FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
  }

  private async flushTelemetry(): Promise<void> {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.status.pendingWrites = 0;

    try {
      await withDbRetry(() => prisma.telemetry.createMany({ data: batch }), "telemetry batch");
    } catch (error) {
      this.status.droppedMessages += batch.length;
      this.status.lastError = error instanceof Error ? error.message : String(error);
      console.error(`[mqtt] dropped ${batch.length} telemetry samples:`, error);
    }

    // Samples that arrived while the batch was in flight get their own window.
    this.status.pendingWrites = this.pending.length;
    if (this.pending.length > 0) this.scheduleFlush();
  }

  private startTimers(): void {
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => this.enqueue("stale check", () => this.checkSilence()), STALE_TICK_MS);
      this.tickTimer.unref?.();
    }

    if (!this.pruneTimer) {
      this.pruneTimer = setInterval(() => {
        this.enqueue("telemetry prune", () => this.pruneTelemetry());
      }, PRUNE_INTERVAL_MS);
      this.pruneTimer.unref?.();
    }
  }

  /**
   * A service that stops publishing is the one failure the services cannot
   * report themselves, so it is the only threshold rule evaluated locally.
   */
  private async checkSilence(): Promise<void> {
    const now = Date.now();
    for (const [service, last] of this.lastSeen) {
      if (service === "LWM") continue;
      if (now - last < SERVICE_SILENCE_MS) {
        this.silentSince.delete(service);
        continue;
      }
      if (this.silentSince.has(service)) continue;
      this.silentSince.set(service, now);
      const minutes = Math.round((now - last) / 60000);
      const created = await raiseServiceAlert(
        service,
        {
          alertId: `${service.toLowerCase()}-silent`,
          type: "service_telemetry_lost",
          severity: "critical",
          state: "raised",
          value: minutes,
          limit: Math.round(SERVICE_SILENCE_MS / 60000),
          unit: "min",
          message: `No telemetry from ${service} for ${minutes} minutes`,
          entity: "global",
        },
        new Date(now),
      );
      if (created) this.status.alertsRaised += 1;
    }
  }

  private async pruneTelemetry(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_MS);
    const { count } = await withDbRetry<{ count: number }>(
      () => prisma.telemetry.deleteMany({ where: { timestamp: { lt: cutoff } } }),
      "telemetry prune",
    );
    if (count > 0) {
      console.info(`[mqtt] pruned ${count} telemetry rows older than ${cutoff.toISOString()}`);
    }
  }

  /**
   * Publish a control and wait for the service's ack.
   *
   * Commands are `{command_id, researcher, value}` on
   * `arl/<svc>/cmd/<entity>/<control>`; the service answers on
   * `arl/<svc>/ack/<command_id>` with accepted → completed, or rejected/failed
   * plus a `reason`.
   */
  async executeControl(input: {
    service: IngestService;
    entity: string;
    control: string;
    value: unknown;
    researcher: string;
    timeoutMs?: number;
  }): Promise<CommandResult> {
    const client = this.client;
    if (!client || !this.status.connected) {
      throw new Error("MQTT broker is not connected; command was not delivered.");
    }

    const topic = commandTopic(
      env().MQTT_TOPIC_PREFIX,
      input.service,
      input.entity,
      input.control,
    );
    const commandId = `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const envelope = { command_id: commandId, researcher: input.researcher, value: input.value };

    const timeoutMs =
      input.timeoutMs ?? COMMAND_TIMEOUT_MS[input.control] ?? DEFAULT_COMMAND_TIMEOUT_MS;

    const waiter = new Promise<CommandAck | null>((resolve) => {
      this.ackWaiters.set(commandId, { resolve, seen: null });
      setTimeout(() => {
        const pending = this.ackWaiters.get(commandId);
        if (!pending) return;
        this.ackWaiters.delete(commandId);
        pending.resolve(pending.seen);
      }, timeoutMs).unref?.();
    });

    await new Promise<void>((resolve, reject) => {
      client.publish(topic, JSON.stringify(envelope), { qos: 1, retain: false }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    const ack = await waiter;
    const outcome: CommandOutcome =
      ack?.state === "completed"
        ? "completed"
        : ack?.state === "rejected"
          ? "rejected"
          : ack?.state === "failed"
            ? "failed"
            : "timeout";

    const message =
      outcome === "timeout"
        ? ack
          ? `Service accepted the command (${ack.state}); no terminal ack within ${Math.round(
              timeoutMs / 1000,
            )}s.`
          : `No ack from ${input.service} within ${Math.round(timeoutMs / 1000)}s.`
        : ack?.reason
          ? `${outcome}: ${ack.reason}${ack.detail ? ` (${ack.detail})` : ""}`
          : `${outcome}${ack?.detail ? `: ${ack.detail}` : ""}`;

    const result: CommandResult = {
      commandId,
      topic,
      control: input.control,
      entity: input.entity,
      value: input.value,
      outcome,
      ack,
      message,
    };
    publishCommandResult(result);
    return result;
  }

  /** Retained capability document for a service, once it has been received. */
  getTopology(service: IngestService): Topology | null {
    return this.topologies.get(service) ?? null;
  }

  /** Known scan contexts, newest last. */
  getScanContext(scanId?: string | null): RtaScanContext | null {
    if (scanId) return this.scans.get(scanId) ?? null;
    let latest: RtaScanContext | null = null;
    for (const context of this.scans.values()) latest = context;
    return latest;
  }

  getStatus(): WorkerStatus {
    return { ...this.status };
  }

  private setStatus(state: WorkerState, detail?: string, connected = false): void {
    this.status.state = state;
    this.status.connected = connected;
    if (detail !== undefined) this.status.lastError = detail;
    publishWorkerStatus({ state, detail, at: new Date().toISOString() });
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.status.lastError = message;
    this.setStatus("error", message);
    console.error("[mqtt] worker failed to start:", message);
  }

  private teardownClient(): void {
    if (!this.client) return;
    try {
      this.client.removeAllListeners();
      this.client.end(true);
    } catch {
      // ignore teardown failures
    }
    this.client = null;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Drain samples buffered in the current flush window before going offline.
    try {
      await this.writeChain;
      await this.flushTelemetry();
    } catch (error) {
      console.error("[mqtt] shutdown flush failed:", error);
    }

    for (const [commandId, waiter] of this.ackWaiters) {
      this.ackWaiters.delete(commandId);
      waiter.resolve(waiter.seen);
    }

    const client = this.client;
    this.client = null;
    if (client) {
      await new Promise<void>((resolve) => {
        client.end(false, {}, () => resolve());
        setTimeout(resolve, 2000);
      });
    }
    this.setStatus("offline");
  }
}

const globalForWorker = globalThis as unknown as {
  arlMqttWorker?: MqttWorker;
};

export function getMqttWorker(): MqttWorker {
  if (!globalForWorker.arlMqttWorker) {
    globalForWorker.arlMqttWorker = new MqttWorker();
  }
  return globalForWorker.arlMqttWorker;
}

/** Convenience bootstrap used by instrumentation and API route handlers. */
export function ensureMqttWorker(): MqttWorker {
  const worker = getMqttWorker();
  worker.start();
  return worker;
}

export type { MqttWorker };
