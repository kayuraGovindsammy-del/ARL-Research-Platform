import { toIngestService, type IngestService } from "./types";

/**
 * Topic taxonomy published by the ARL services:
 *
 *   arl/<svc>/$topology                          retained capability document
 *   arl/<svc>/<entity>/telemetry/<stream>        periodic samples
 *   arl/<svc>/<entity>/state/<item>              retained latest state
 *   arl/<svc>/events/<kind>                      one-off events (alert, scan, …)
 *   arl/<svc>/cmd/<entity>/<control>             commands published by us
 *   arl/<svc>/ack/<command_id>                   command acknowledgements
 *
 * Parsing is prefix agnostic: the first segment matching a known service name
 * anchors the topic, so a custom MQTT_TOPIC_PREFIX requires no client changes.
 */

export type TopicKind =
  | "topology"
  | "telemetry"
  | "state"
  | "event"
  | "command"
  | "ack"
  | "unknown";

export interface ParsedTopic {
  service: IngestService | null;
  kind: TopicKind;
  /** Dish / room / crew / sub-array / site id, or "global". */
  entity: string | null;
  /** Telemetry stream, state item, event kind, control name or command id. */
  name: string | null;
  topic: string;
  segments: string[];
}

const EMPTY = (topic: string, segments: string[]): ParsedTopic => ({
  service: null,
  kind: "unknown",
  entity: null,
  name: null,
  topic,
  segments,
});

export function parseTopic(topic: string): ParsedTopic {
  const segments = topic.split("/").filter(Boolean);
  const anchor = segments.findIndex((segment) => toIngestService(segment) !== null);
  if (anchor === -1) return EMPTY(topic, segments);

  const service = toIngestService(segments[anchor])!;
  const rest = segments.slice(anchor + 1);

  if (rest[0] === "$topology") {
    return { service, kind: "topology", entity: null, name: "$topology", topic, segments };
  }
  if (rest[0] === "events") {
    return { service, kind: "event", entity: null, name: rest[1] ?? null, topic, segments };
  }
  if (rest[0] === "cmd") {
    return { service, kind: "command", entity: rest[1] ?? null, name: rest[2] ?? null, topic, segments };
  }
  if (rest[0] === "ack") {
    return { service, kind: "ack", entity: null, name: rest[1] ?? null, topic, segments };
  }
  if (rest.length >= 3 && rest[1] === "telemetry") {
    return { service, kind: "telemetry", entity: rest[0], name: rest[2], topic, segments };
  }
  if (rest.length >= 3 && rest[1] === "state") {
    return { service, kind: "state", entity: rest[0], name: rest[2], topic, segments };
  }

  return { service, kind: "unknown", entity: rest[0] ?? null, name: null, topic, segments };
}

/** True when `topic` matches an `arl/…/+/…` style pattern. */
export function topicMatches(topic: string, pattern: string): boolean {
  const topicParts = topic.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);
  if (topicParts.length !== patternParts.length) return false;
  return patternParts.every((part, index) => part === "+" || part === topicParts[index]);
}

/**
 * Find the value of a retained state item, e.g.
 * `stateValue(topics, "rta", "main", "scan_state")`.
 */
export function stateValue(
  topics: Record<string, { payload: Record<string, unknown> }>,
  service: string,
  entity: string,
  item: string,
): unknown {
  const suffix = `/${service}/${entity}/state/${item}`;
  for (const [topic, state] of Object.entries(topics)) {
    if (topic.endsWith(suffix)) return state.payload.value;
  }
  return undefined;
}

/** Topic timestamp for a retained state item (ISO) when present. */
export function stateAt(
  topics: Record<string, { timestamp: string }>,
  service: string,
  entity: string,
  item: string,
): string | null {
  const suffix = `/${service}/${entity}/state/${item}`;
  for (const [topic, state] of Object.entries(topics)) {
    if (topic.endsWith(suffix)) return state.timestamp;
  }
  return null;
}

export function commandTopic(
  prefix: string,
  service: IngestService,
  entity: string,
  control: string,
): string {
  return `${prefix}/${service.toLowerCase()}/cmd/${entity}/${control}`;
}

export function ackTopic(prefix: string, service: IngestService, commandId: string): string {
  return `${prefix}/${service.toLowerCase()}/ack/${commandId}`;
}

export function telemetryWildcard(prefix: string): string {
  return `${prefix}/#`;
}

/** Convenience builders used by selectors and tests. */
export function telemetryTopic(
  prefix: string,
  service: IngestService,
  entity: string,
  stream: string,
): string {
  return `${prefix}/${service.toLowerCase()}/${entity}/telemetry/${stream}`;
}

export function eventTopic(prefix: string, service: IngestService, kind: string): string {
  return `${prefix}/${service.toLowerCase()}/events/${kind}`;
}

export const SERVICE_VALUES = ["RTA", "MHE", "OPG"] as const;
