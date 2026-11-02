"use client";

import type {
  AlertLimits,
  AlertRecord,
  ArlTarget,
  CommandResult,
  NewTarget,
  PowerSource,
  Service,
  Topology,
} from "./types";

/** Browser-side fetch helpers with uniform error handling. */

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text };
    }
  }

  if (!response.ok) {
    const record = body as Record<string, unknown> | null;
    const message =
      (record && (record.error as string)) || `Request failed with status ${response.status}`;
    throw new ApiError(message, response.status, record);
  }

  return body as T;
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  return parseResponse<T>(response);
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseResponse<T>(response);
}

export async function deleteJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { method: "DELETE" });
  return parseResponse<T>(response);
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/** Mirror of the POST /api/controls body. */
export interface CommandRequest {
  service: Service;
  /** Dish / room / crew id, sub-array name, or the fixed entity of a global control. */
  entity?: string;
  control: string;
  value: unknown;
  researcher?: string;
}

export interface CommandResponse {
  ok: boolean;
  result: CommandResult;
}

export async function sendControl(request: CommandRequest): Promise<CommandResponse> {
  return postJson<CommandResponse>("/api/controls", request);
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export async function acknowledgeAlertRequest(id: string, researcher: string, note?: string) {
  return postJson<{ alert: AlertRecord }>(`/api/alerts/${id}/acknowledge`, {
    researcher,
    note,
  });
}

export async function resolveAlertRequest(
  id: string,
  researcher: string,
  resolutionNote: string,
) {
  return postJson<{ alert: AlertRecord }>(`/api/alerts/${id}/resolve`, {
    researcher,
    resolutionNote,
  });
}

// ---------------------------------------------------------------------------
// ARL REST API proxies
// ---------------------------------------------------------------------------

export interface TargetsResponse {
  targets: ArlTarget[];
  source: "arl" | "unavailable";
  error?: string;
  docsUrl?: string;
}

export async function fetchTargets(refresh = false): Promise<TargetsResponse> {
  try {
    return await getJson<TargetsResponse>(`/api/arl/targets${refresh ? "?refresh=1" : ""}`);
  } catch (error) {
    if (error instanceof ApiError) {
      const details = error.details as TargetsResponse | undefined;
      return {
        targets: details?.targets ?? [],
        source: "unavailable",
        error: error.message,
        docsUrl: details?.docsUrl,
      };
    }
    return { targets: [], source: "unavailable", error: String(error) };
  }
}

/** Register a sky position so it can be observed with `set_target`. */
export async function createTargetRequest(input: NewTarget): Promise<ArlTarget> {
  const { target } = await postJson<{ target: ArlTarget }>("/api/arl/targets", input);
  return target;
}

export async function deleteTargetRequest(id: string): Promise<void> {
  await deleteJson<{ ok: boolean }>(`/api/arl/targets?id=${encodeURIComponent(id)}`);
}

export interface AlertLimitsResponse {
  service: Service;
  limits: AlertLimits;
  source: "arl" | "fallback";
  error?: string;
  docsUrl?: string;
}

export async function fetchAlertLimits(service: Service): Promise<AlertLimitsResponse> {
  return getJson<AlertLimitsResponse>(`/api/arl/alert-limits/${service.toLowerCase()}`);
}

export async function fetchTopology(service: Service): Promise<Topology | null> {
  try {
    const { topology } = await getJson<{ service: Service; topology: Topology }>(
      `/api/arl/topology?service=${service.toLowerCase()}`,
    );
    return topology;
  } catch {
    return null;
  }
}

export interface ResearcherVerification {
  valid: boolean;
  researcher: { code: string; name: string; experiments: string[]; status: string } | null;
  reason?: string;
}

/**
 * Check a researcher code against one experiment. Permission is per experiment,
 * so a code that may command RTA is not necessarily allowed to touch OPG.
 */
export async function verifyResearcherRequest(
  code: string,
  service?: Service,
): Promise<ResearcherVerification> {
  return postJson<ResearcherVerification>("/api/arl/researcher", {
    code,
    service: service?.toLowerCase(),
  });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface PowerSample {
  timestamp: string;
  solarOutputKw: number;
  dieselOutputKw: number;
  batteryOutputKw: number;
  demandKw: number;
}

/** `arl/opg/global/telemetry/power` is OPG's aggregated plant sample. */
export const OPG_POWER_TOPIC = "arl/opg/global/telemetry/power";

export async function fetchPowerHistory(minutes = 30) {
  return getJson<{
    topic: string;
    samples: Array<{ payload: Record<string, unknown>; timestamp: string }>;
  }>(`/api/telemetry/history?topic=${OPG_POWER_TOPIC}&minutes=${minutes}&limit=360`);
}

export type { PowerSource };
