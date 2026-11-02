"use client";

import type { AlertRecord, ArlTarget, PowerSource, Service } from "./types";

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

export interface CommandRequest {
  service: Service;
  action: string;
  issuedBy?: string;
  [key: string]: unknown;
}

export async function sendCommand(request: CommandRequest) {
  return postJson<{ ok: boolean; topic: string; envelope: Record<string, unknown> }>(
    "/api/controls",
    request,
  );
}

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

export interface PowerSample {
  timestamp: string;
  solarOutputKw: number;
  dieselOutputKw: number;
  batteryOutputKw: number;
  demandKw: number;
}

export async function fetchPowerHistory(minutes = 30) {
  return getJson<{ topic: string; samples: Array<{ payload: Record<string, unknown>; timestamp: string }> }>(
    `/api/telemetry/history?topic=arl/opg/power&minutes=${minutes}&limit=360`,
  );
}

export type { PowerSource };
