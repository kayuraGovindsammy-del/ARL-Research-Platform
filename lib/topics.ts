import { SERVICES, toService, type Service } from "./types";

/**
 * Topic taxonomy used across the platform:
 *
 *   arl/rta/array/status                  array + scan state
 *   arl/rta/dish/<dishId>/metrics         per-dish metrics (2 min cadence)
 *   arl/rta/scan/<scanId>/sample          high frequency scan sample (1 Hz)
 *   arl/mhe/habitat/status                habitat mode / airlock / lighting
 *   arl/mhe/room/<roomId>/telemetry       per-room environment (5 min cadence)
 *   arl/mhe/crew/<crewId>/health          crew vitals (1 min cadence)
 *   arl/mhe/crew/<crewId>/survey          daily survey submission
 *   arl/opg/power                         aggregated power state
 *   arl/opg/source/<source>/status        per-source status
 *   arl/<service>/cmd/<action>            commands published by this platform
 *
 * Parsing is prefix agnostic: the first segment matching a known service name
 * anchors the topic, so a custom MQTT_TOPIC_PREFIX requires no client changes.
 */

export type TopicKind =
  | "rta.array.status"
  | "rta.dish.metrics"
  | "rta.scan.sample"
  | "mhe.habitat.status"
  | "mhe.room.telemetry"
  | "mhe.crew.health"
  | "mhe.crew.survey"
  | "opg.power"
  | "opg.source.status"
  | "command"
  | "unknown";

export interface ParsedTopic {
  service: Service | null;
  kind: TopicKind;
  /** Entity identifier (dish id, room id, crew id, source name, scan id). */
  entityId: string | null;
  segments: string[];
}

export function parseTopic(topic: string): ParsedTopic {
  const segments = topic.split("/").filter(Boolean);
  const anchor = segments.findIndex((segment) => toService(segment) !== null);

  if (anchor === -1) {
    return { service: null, kind: "unknown", entityId: null, segments };
  }

  const service = toService(segments[anchor])!;
  const rest = segments.slice(anchor + 1);

  if (rest[0] === "cmd") {
    return { service, kind: "command", entityId: rest.slice(1).join("/"), segments };
  }

  switch (service) {
    case "RTA":
      if (rest[0] === "array" && rest[1] === "status") {
        return { service, kind: "rta.array.status", entityId: null, segments };
      }
      if (rest[0] === "dish" && rest[2] === "metrics") {
        return { service, kind: "rta.dish.metrics", entityId: rest[1] ?? null, segments };
      }
      if (rest[0] === "scan" && (rest[2] === "sample" || rest[1] === "sample")) {
        return {
          service,
          kind: "rta.scan.sample",
          entityId: rest[1] === "sample" ? "" : (rest[1] ?? null),
          segments,
        };
      }
      return { service, kind: "unknown", entityId: null, segments };

    case "MHE":
      if (rest[0] === "habitat" && rest[1] === "status") {
        return { service, kind: "mhe.habitat.status", entityId: null, segments };
      }
      if (rest[0] === "room" && rest[2] === "telemetry") {
        return { service, kind: "mhe.room.telemetry", entityId: rest[1] ?? null, segments };
      }
      if (rest[0] === "crew" && rest[2] === "health") {
        return { service, kind: "mhe.crew.health", entityId: rest[1] ?? null, segments };
      }
      if (rest[0] === "crew" && rest[2] === "survey") {
        return { service, kind: "mhe.crew.survey", entityId: rest[1] ?? null, segments };
      }
      return { service, kind: "unknown", entityId: null, segments };

    case "OPG":
      if (rest[0] === "power") {
        return { service, kind: "opg.power", entityId: null, segments };
      }
      if (rest[0] === "source" && rest[2] === "status") {
        return { service, kind: "opg.source.status", entityId: rest[1] ?? null, segments };
      }
      return { service, kind: "unknown", entityId: null, segments };

    default:
      return { service: null, kind: "unknown", entityId: null, segments };
  }
}

/** True when `topic` ends with the given slash-delimited suffix. */
export function topicEndsWith(topic: string, suffix: string): boolean {
  const normalized = suffix.startsWith("/") ? suffix.slice(1) : suffix;
  return topic === normalized || topic.endsWith(`/${normalized}`);
}

/** Extract the trailing entity id for `prefix/<id>/rest` shaped topics. */
export function topicEntityId(topic: string, marker: string): string | null {
  const segments = topic.split("/");
  const index = segments.indexOf(marker);
  if (index === -1 || index + 1 >= segments.length) return null;
  return segments[index + 1] || null;
}

export function commandTopic(
  prefix: string,
  service: Service,
  action: string,
): string {
  return `${prefix}/${service.toLowerCase()}/cmd/${action}`;
}

export function telemetryWildcard(prefix: string): string {
  return `${prefix}/#`;
}

export const SERVICE_VALUES = SERVICES;

export function dishTopic(prefix: string, dishId: string): string {
  return `${prefix}/rta/dish/${dishId}/metrics`;
}

export function roomTopic(prefix: string, roomId: string): string {
  return `${prefix}/mhe/room/${roomId}/telemetry`;
}

export function crewHealthTopic(prefix: string, crewId: string): string {
  return `${prefix}/mhe/crew/${crewId}/health`;
}
