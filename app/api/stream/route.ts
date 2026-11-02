import { NextRequest } from "next/server";
import { telemetryEmitter } from "@/lib/events";
import type { WorkerStatusEvent } from "@/lib/events";
import { ensureMqttWorker } from "@/lib/mqtt-worker";
import { toService, type AlertRecord, type TelemetryEvent } from "@/lib/types";

/**
 * Live SSE endpoint. Values are pushed straight from the in-process
 * telemetryEmitter that the MQTT worker writes to; no polling, no buffering.
 *
 * Events:
 *   ready      initial handshake (broker state, subscription, server time)
 *   telemetry  one persisted Telemetry row
 *   alert      alert raised or transitioned
 *   worker     broker connectivity state change
 *
 * `?service=RTA|MHE|OPG` narrows the firehose to one instrument.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const HEARTBEAT_MS = 20_000;

export async function GET(request: NextRequest) {
  const worker = ensureMqttWorker();
  const service = toService(request.nextUrl.searchParams.get("service") ?? "");
  const encoder = new TextEncoder();

  let release: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      const send = (event: string, data: unknown) => {
        write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const onTelemetry = (event: TelemetryEvent) => {
        if (service && event.service !== service) return;
        send("telemetry", event);
      };

      const onAlert = (alert: AlertRecord) => {
        if (service && alert.service !== service) return;
        send("alert", alert);
      };

      const onWorker = (status: WorkerStatusEvent) => send("worker", status);

      telemetryEmitter.on("telemetry", onTelemetry);
      telemetryEmitter.on("alert", onAlert);
      telemetryEmitter.on("worker", onWorker);

      const heartbeat = setInterval(() => {
        write(`: keepalive ${Date.now()}\n\n`);
      }, HEARTBEAT_MS);
      heartbeat.unref?.();

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        telemetryEmitter.off("telemetry", onTelemetry);
        telemetryEmitter.off("alert", onAlert);
        telemetryEmitter.off("worker", onWorker);
        try {
          controller.close();
        } catch {
          // already closed by the consumer
        }
      };
      release = cleanup;

      // Reconnection hint for EventSource, then the handshake payload.
      write("retry: 5000\n\n");
      const status = worker.getStatus();
      send("ready", {
        serverTime: new Date().toISOString(),
        service,
        brokerConnected: status.connected,
        brokerState: status.state,
        subscribedTopic: status.subscribedTopic,
      });

      request.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      release?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
