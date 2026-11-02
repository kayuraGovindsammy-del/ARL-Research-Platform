import { NextResponse } from "next/server";
import { arlApiBaseUrl, arlApiDocsUrl, env, inspectEnv, mqttBrokerUrl } from "@/lib/env";
import { ensureMqttWorker } from "@/lib/mqtt-worker";
import { INGEST_SERVICES } from "@/lib/types";

/**
 * GET /api/arl/metadata
 *
 * What the console is currently wired to: the validated configuration (without
 * secrets), the broker state, and the contract version each service advertises
 * in its `$topology` document. Nothing here is required for a dashboard to
 * render — it exists so the operator can confirm the platform is pointed at the
 * right simulator without opening a terminal.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const config = inspectEnv();
  const worker = ensureMqttWorker();
  const status = worker.getStatus();

  const services = INGEST_SERVICES.map((code) => {
    const topology = worker.getTopology(code);
    return {
      code,
      version: topology?.version ?? null,
      entities: topology?.entities.length ?? 0,
      streams: topology?.streams.length ?? 0,
      controls: topology?.controls.length ?? 0,
    };
  });

  return NextResponse.json(
    {
      config: config.ok
        ? {
            api: arlApiBaseUrl(),
            broker: mqttBrokerUrl(),
            topicPrefix: env().MQTT_TOPIC_PREFIX,
            researcherCode: env().ARL_RESEARCHER_CODE,
            researcherName: env().ARL_RESEARCHER_NAME,
            apiAuthenticated: Boolean(env().MQTT_BROKER_USER),
            envFile: true,
          }
        : null,
      configError: config.ok ? null : config.error,
      worker: {
        state: status.state,
        connected: status.connected,
        subscribedTopic: status.subscribedTopic,
        messagesIngested: status.messagesIngested,
        lastMessageAt: status.lastMessageAt,
      },
      services,
      docsUrl: config.ok ? arlApiDocsUrl() : null,
      fetchedAt: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
