import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { env } from "./env";
import type { AlertLimit, ArlResearcher, ArlTarget, NewTarget } from "./types";

/**
 * Thin, dependency-free client for the ARL `/v1` REST API
 * (`${ARL_API_PROTOCOL}://${ARL_API_ADDRESS}:${ARL_API_PORT}/docs`).
 *
 * Endpoints used by the platform:
 *   GET    /v1/targets                 target catalogue
 *   POST   /v1/targets                 register a custom target
 *   DELETE /v1/targets/{id}            remove a custom target
 *   GET    /v1/alert-limits/{service}  thresholds the services alert on
 *   GET    /v1/researchers/{code}      researcher identity + experiments
 *   POST   /v1/researchers/verify      validate a researcher code
 *
 * Responses are cached briefly because the dashboards poll the catalogues
 * while the operator works.
 */

export class ArlApiError extends Error {
  status: number | null;
  endpoint: string;

  constructor(message: string, endpoint: string, status: number | null = null) {
    super(message);
    this.name = "ArlApiError";
    this.endpoint = endpoint;
    this.status = status;
  }
}

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

const cache = new Map<string, CacheEntry>();

const CACHE_TTL_MS = {
  targets: 60 * 1000,
  alertLimits: 5 * 60 * 1000,
  researcher: 10 * 60 * 1000,
};

function buildUrl(path: string, query?: Record<string, unknown>): URL {
  const config = env();
  const url = new URL(`${config.ARL_API_PROTOCOL}://${config.ARL_API_ADDRESS}:${config.ARL_API_PORT}`);
  const [pathname, search] = path.split("?");
  url.pathname = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (search) url.search = search;
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function requestJsonOnce(
  url: URL,
  method: "GET" | "POST" | "DELETE",
  body?: unknown,
): Promise<unknown> {
  const config = env();
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? httpsRequest : httpRequest;
  const payload = body === undefined ? null : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      method,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers: {
        accept: "application/json",
        "user-agent": "arl-platform/1.0",
        ...(payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : {}),
      },
      // Self-signed lab controller certificate.
      ...(isHttps ? { rejectUnauthorized: config.ARL_API_TLS_VERIFY } : {}),
    };

    const request = transport(options, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
      });
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          let detail = text.trim();
          try {
            const parsed = JSON.parse(text) as Record<string, unknown>;
            detail = String(parsed.detail ?? parsed.error ?? detail);
          } catch {
            // keep the raw body
          }
          reject(
            new ArlApiError(
              `ARL API responded ${status} for ${method} ${url.pathname}${detail ? `: ${detail}` : ""}`,
              url.toString(),
              status,
            ),
          );
          return;
        }
        if (!text.trim()) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(
            new ArlApiError(
              `ARL API returned a non-JSON payload for ${url.pathname}`,
              url.toString(),
              status,
            ),
          );
        }
      });
    });

    request.setTimeout(config.ARL_API_TIMEOUT_MS, () => {
      request.destroy(
        new ArlApiError(
          `ARL API request timed out after ${config.ARL_API_TIMEOUT_MS}ms`,
          url.toString(),
        ),
      );
    });

    request.on("error", (error: Error) => {
      reject(
        error instanceof ArlApiError
          ? error
          : new ArlApiError(`ARL API unreachable: ${error.message}`, url.toString()),
      );
    });

    if (payload) request.write(payload);
    request.end();
  });
}

async function requestJson<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "DELETE";
    body?: unknown;
    query?: Record<string, unknown>;
    ttlMs?: number;
    retries?: number;
  } = {},
): Promise<T> {
  const {
    method = "GET",
    body,
    query,
    ttlMs = CACHE_TTL_MS.alertLimits,
    retries = 1,
  } = options;
  const url = buildUrl(path, query);
  const cacheKey = `${method} ${url.toString()}`;

  if (method === "GET") {
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value as T;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const value = (await requestJsonOnce(url, method, body)) as T;
      if (method === "GET") cache.set(cacheKey, { expiresAt: Date.now() + ttlMs, value });
      else cache.clear();
      return value;
    } catch (error) {
      lastError = error;
      // Only transport failures are retried; 4xx responses are deterministic.
      if (error instanceof ArlApiError && error.status !== null && error.status < 500) break;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new ArlApiError("Unknown ARL API failure", url.toString());
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeTarget(item: unknown, index: number): ArlTarget | null {
  const record = asRecord(item);
  if (!record) return null;
  const id = String(record.id ?? "").trim();
  const name = String(record.name ?? id ?? `Target ${index + 1}`).trim();
  if (!id && !name) return null;
  return {
    id: id || name,
    name: name || id,
    ra_rad: toNumber(record.ra_rad) ?? 0,
    dec_rad: toNumber(record.dec_rad) ?? 0,
    fov_rad: toNumber(record.fov_rad) ?? 0.01,
    category: typeof record.category === "string" ? record.category : "",
  };
}

/** Pre-programmed observation targets (`tgt-xxx`). */
export async function getTargets(): Promise<ArlTarget[]> {
  const raw = await requestJson<unknown>(env().ARL_API_PATH_TARGETS, {
    ttlMs: CACHE_TTL_MS.targets,
  });
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map(normalizeTarget)
    .filter((target): target is ArlTarget => target !== null);
}

export async function getTarget(id: string): Promise<ArlTarget | null> {
  try {
    const raw = await requestJson<unknown>(
      `${env().ARL_API_PATH_TARGETS}/${encodeURIComponent(id)}`,
      { ttlMs: CACHE_TTL_MS.targets, retries: 0 },
    );
    return normalizeTarget(raw, 0);
  } catch (error) {
    if (error instanceof ArlApiError && error.status === 404) return null;
    throw error;
  }
}

/** Register a custom position so it can be observed like a catalogue target. */
export async function createTarget(input: NewTarget): Promise<ArlTarget> {
  const raw = await requestJson<unknown>(env().ARL_API_PATH_TARGETS, {
    method: "POST",
    body: input,
    retries: 0,
  });
  const target = normalizeTarget(raw, 0);
  if (!target) throw new ArlApiError("ARL API returned an invalid target", "POST /v1/targets");
  return target;
}

export async function deleteTarget(id: string): Promise<void> {
  await requestJson<unknown>(`${env().ARL_API_PATH_TARGETS}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    retries: 0,
  });
}

/**
 * Thresholds a service alerts on, e.g. `rta.dish_temperature.warn_k`.
 * Returned as a lookup keyed by limit name.
 */
export async function getAlertLimits(service: string): Promise<Record<string, AlertLimit>> {
  const base = env().ARL_API_PATH_ALERT_LIMITS.replace(/\/+$/, "");
  const raw = await requestJson<unknown>(`${base}/${encodeURIComponent(service.toLowerCase())}`, {
    ttlMs: CACHE_TTL_MS.alertLimits,
  });
  const list = Array.isArray(raw) ? raw : [];
  const limits: Record<string, AlertLimit> = {};
  for (const item of list) {
    const record = asRecord(item);
    if (!record) continue;
    const key = String(record.key ?? "").trim();
    const value = toNumber(record.value);
    if (!key || value === undefined) continue;
    limits[key] = {
      key,
      value,
      unit: typeof record.unit === "string" ? record.unit : null,
    };
  }
  return limits;
}

/** Researcher identity; throws `ArlApiError` with status 404 when unknown. */
export async function getResearcher(code: string): Promise<ArlResearcher> {
  const base = env().ARL_API_PATH_RESEARCHER.replace(/\/+$/, "");
  const raw = await requestJson<unknown>(`${base}/${encodeURIComponent(code)}`, {
    ttlMs: CACHE_TTL_MS.researcher,
    retries: 0,
  });
  const record = asRecord(raw);
  if (!record) throw new ArlApiError("ARL API returned an invalid researcher", "GET researcher");
  return {
    code: String(record.code ?? code),
    name: String(record.name ?? code),
    experiments: Array.isArray(record.experiments)
      ? record.experiments.map((entry) => String(entry).toLowerCase())
      : [],
    status: String(record.status ?? "unknown").toLowerCase(),
  };
}

/** Validate a researcher code before allowing a command to be published. */
export async function verifyResearcher(
  code: string,
  service: "rta" | "mhe" | "lwm" | "opg" | "owt" = "rta",
): Promise<{
  valid: boolean;
  researcher: ArlResearcher | null;
  reason?: string;
}> {
  try {
    const raw = await requestJson<unknown>(env().ARL_API_PATH_VERIFY, {
      method: "POST",
      body: { code, service },
      retries: 0,
    });
    const record = asRecord(raw);
    const researcher = record ? asRecord(record.researcher) : null;
    const valid =
      record?.valid === true ||
      record?.ok === true ||
      record?.status === "active" ||
      (record?.status === undefined && researcher !== null);
    return {
      valid,
      researcher: researcher
        ? {
            code: String(researcher.code ?? code),
            name: String(researcher.name ?? code),
            experiments: Array.isArray(researcher.experiments)
              ? researcher.experiments.map((entry) => String(entry).toLowerCase())
              : [],
            status: String(researcher.status ?? "active").toLowerCase(),
          }
        : null,
      reason: typeof record?.reason === "string" ? record.reason : undefined,
    };
  } catch (error) {
    if (error instanceof ArlApiError && error.status === 404) {
      return { valid: false, researcher: null, reason: "unknown researcher" };
    }
    throw error;
  }
}

export function invalidateArlCache(): void {
  cache.clear();
}
