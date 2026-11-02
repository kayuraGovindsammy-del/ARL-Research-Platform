import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import { AlertRuleEngine, extractPayloadAlertFlags } from "./alert-rules";
import { raiseAlerts } from "./alerts";
import { env, mqttBrokerUrl } from "./env";
import { publishTelemetry, publishWorkerStatus } from "./events";
import { prisma, withDbRetry } from "./prisma";
import { commandTopic, parseTopic, telemetryWildcard } from "./topics";
import type { AlertFlag, CommandEnvelope, Service, TelemetryEvent } from "./types";

/**
 * In-memory MQTT ingestion worker.
 *
 * Responsibilities:
 *  - one persistent client per server process (pinned on `globalThis`)
 *  - subscribe to the whole `arl/#` tree and fan messages into SQLite
 *  - emit every persisted sample on the global telemetryEmitter (SSE source)
 *  - evaluate alert threshold rules and persist new alerts
 *  - publish operator commands on `arl/<service>/cmd/<action>`
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
const RULE_TICK_MS = 60_000;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 15 * 60 * 1000;

/** Samples are persisted in batches rather than one transaction per message. */
const FLUSH_INTERVAL_MS = 250;
const MAX_PENDING_SAMPLES = 20_000;

interface PendingSample {
  id: string;
  service: Service;
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
 * Prefer a device-supplied timestamp so replay reflects the lab clock, while
 * rejecting obviously bogus values (far future or older than the retention).
 */
function resolveTimestamp(payload: Record<string, unknown>, now: Date): Date {
  const candidates = [
    payload.timestamp,
    payload.ts,
    payload.recordedAt,
    payload.updatedAt,
    payload.submittedAt,
    payload.time,
  ];
  for (const candidate of candidates) {
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
  }
  return now;
}

function serviceFromAlertType(alertType: string): Service | null {
  if (alertType.startsWith("RTA_")) return "RTA";
  if (alertType.startsWith("MHE_")) return "MHE";
  if (alertType.startsWith("OPG_")) return "OPG";
  return null;
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
  private rules = new AlertRuleEngine();
  private clientId: string | null = null;

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
   * flush window instead of one transaction per sample (a scan publishes 24
   * samples per second).
   */
  private ingest(topic: string, buffer: Buffer): void {
    const parsed = parseTopic(topic);
    if (!parsed.service || parsed.kind === "command") return;

    const payload = parsePayload(buffer);
    if (!payload) {
      this.status.droppedMessages += 1;
      return;
    }

    const now = new Date();
    const timestamp = resolveTimestamp(payload, now);

    const event: TelemetryEvent = {
      // The id is minted here (not by Prisma) so the sample can be streamed to
      // SSE clients before the batched insert lands.
      id: globalThis.crypto.randomUUID(),
      service: parsed.service,
      topic,
      payload,
      timestamp: timestamp.toISOString(),
    };

    this.status.messagesIngested += 1;
    this.status.lastMessageAt = now.toISOString();
    publishTelemetry(event);

    this.queueSample({
      id: event.id,
      service: parsed.service,
      topic,
      payload: JSON.stringify(payload),
      timestamp,
    });

    const flags = [
      ...extractPayloadAlertFlags(payload, topic),
      ...this.rules.observe(parsed, payload, timestamp),
    ];
    if (flags.length === 0) return;

    const service = parsed.service;
    this.enqueue("alert escalation", () => this.raiseForFlags(service, flags, timestamp));
  }

  /** Serialise database work so SQLite never sees concurrent writers. */
  private enqueue(label: string, task: () => Promise<void>): void {
    this.writeChain = this.writeChain.then(task).catch((error) => {
      console.error(`[mqtt] ${label} failure:`, error);
      this.status.lastError = error instanceof Error ? error.message : String(error);
    });
  }

  private async raiseForFlags(
    service: Service,
    flags: AlertFlag[],
    timestamp?: Date,
  ): Promise<void> {
    const created = await raiseAlerts(service, flags, timestamp);
    this.status.alertsRaised += created.length;
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
      this.tickTimer = setInterval(() => {
        this.enqueue("rule tick", () => this.runTimeBasedRules());
      }, RULE_TICK_MS);
      this.tickTimer.unref?.();
    }

    if (!this.pruneTimer) {
      this.pruneTimer = setInterval(() => {
        this.enqueue("telemetry prune", () => this.pruneTelemetry());
      }, PRUNE_INTERVAL_MS);
      this.pruneTimer.unref?.();
    }
  }

  private async runTimeBasedRules(): Promise<void> {
    const flags = this.rules.tick();
    for (const flag of flags) {
      const service = serviceFromAlertType(flag.type);
      if (!service) continue;
      await this.raiseForFlags(service, [flag]);
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

  /** Publish an operator command. Throws when the broker is unavailable. */
  async publishCommand(
    service: Service,
    action: string,
    params: Record<string, unknown>,
    issuedBy: string,
  ): Promise<{ topic: string; envelope: CommandEnvelope }> {
    const client = this.client;
    if (!client || !this.status.connected) {
      throw new Error("MQTT broker is not connected; command was not delivered.");
    }

    const topic = commandTopic(env().MQTT_TOPIC_PREFIX, service, action);
    const envelope: CommandEnvelope = {
      action,
      issuedBy,
      issuedAt: new Date().toISOString(),
      params,
    };

    await new Promise<void>((resolve, reject) => {
      client.publish(topic, JSON.stringify(envelope), { qos: 1, retain: false }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    return { topic, envelope };
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
