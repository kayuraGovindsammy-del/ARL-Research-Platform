import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { env } from "./env";
import type { ArlLabMetadata, ArlParameter, ArlTarget } from "./types";

/**
 * Thin, dependency-free client for the ARL REST API
 * (`${ARL_API_PROTOCOL}://${ARL_API_ADDRESS}:${ARL_API_PORT}/docs`).
 *
 * The lab controller presents a self-signed certificate, so TLS verification is
 * configurable (`ARL_API_TLS_VERIFY`). Responses are cached briefly because the
 * dashboards poll target/metadata catalogues while the operator works.
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
  metadata: 5 * 60 * 1000,
  parameters: 60 * 1000,
  targets: 60 * 1000,
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

async function requestJsonOnce(url: URL): Promise<unknown> {
  const config = env();
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const request = transport(
      {
        method: "GET",
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: {
          accept: "application/json",
          "user-agent": "arl-platform/1.0",
        },
        // Self-signed lab controller certificate.
        ...(isHttps ? { rejectUnauthorized: config.ARL_API_TLS_VERIFY } : {}),
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(
              new ArlApiError(
                `ARL API responded ${status} for ${url.pathname}${url.search}`,
                url.toString(),
                status,
              ),
            );
            return;
          }
          if (!body.trim()) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(body));
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
      },
    );

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

    request.end();
  });
}

async function requestJson<T>(
  path: string,
  options: { query?: Record<string, unknown>; ttlMs?: number; retries?: number } = {},
): Promise<T> {
  const { query, ttlMs = CACHE_TTL_MS.parameters, retries = 1 } = options;
  const url = buildUrl(path, query);
  const cacheKey = url.toString();

  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value as T;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const value = (await requestJsonOnce(url)) as T;
      cache.set(cacheKey, { expiresAt: Date.now() + ttlMs, value });
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

function unwrapCollection(raw: unknown, keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  const record = asRecord(raw);
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  for (const key of ["data", "items", "results", "values"]) {
    const nested = record[key];
    if (Array.isArray(nested)) return nested;
    const nestedRecord = asRecord(nested);
    if (nestedRecord) {
      for (const innerKey of keys) {
        if (Array.isArray(nestedRecord[innerKey])) return nestedRecord[innerKey] as unknown[];
      }
    }
  }
  return [];
}

function normalizeTarget(item: unknown, index: number): ArlTarget | null {
  const record = asRecord(item);
  if (!record) return null;
  const id = String(record.id ?? record.targetId ?? record.target_id ?? "").trim();
  const name = String(record.name ?? record.label ?? id ?? `Target ${index + 1}`).trim();
  if (!id && !name) return null;
  return {
    id: id || name,
    name: name || id,
    ra: typeof record.ra === "number" ? record.ra : undefined,
    dec: typeof record.dec === "number" ? record.dec : undefined,
    frequencyMhz:
      typeof record.frequencyMhz === "number"
        ? record.frequencyMhz
        : typeof record.frequency_mhz === "number"
          ? record.frequency_mhz
          : undefined,
    description: typeof record.description === "string" ? record.description : undefined,
  };
}

function normalizeParameter(item: unknown): ArlParameter | null {
  const record = asRecord(item);
  if (!record) return null;
  const name = String(record.name ?? record.key ?? record.id ?? "").trim();
  if (!name) return null;
  const rawValue = record.value ?? record.current ?? record.default;
  const value =
    typeof rawValue === "number" || typeof rawValue === "string" || typeof rawValue === "boolean"
      ? rawValue
      : undefined;
  return {
    ...record,
    id: record.id ? String(record.id) : undefined,
    name,
    value,
    unit: typeof record.unit === "string" ? record.unit : undefined,
    description: typeof record.description === "string" ? record.description : undefined,
  };
}

/** Lab metadata (identity, location, hosted services). */
export async function getMetadata(): Promise<ArlLabMetadata> {
  const raw = await requestJson<unknown>(env().ARL_API_PATH_METADATA, {
    ttlMs: CACHE_TTL_MS.metadata,
  });
  const record = asRecord(raw);
  if (!record) {
    throw new ArlApiError("ARL API metadata payload was not an object", env().ARL_API_PATH_METADATA);
  }
  return record as ArlLabMetadata;
}

/** Tunable parameters exposed by the lab controller. */
export async function getParameters(
  query?: Record<string, unknown>,
): Promise<ArlParameter[]> {
  const raw = await requestJson<unknown>(env().ARL_API_PATH_PARAMETERS, {
    query,
    ttlMs: CACHE_TTL_MS.parameters,
  });
  return unwrapCollection(raw, ["parameters", "params"])
    .map(normalizeParameter)
    .filter((parameter): parameter is ArlParameter => parameter !== null);
}

/** Pre-programmed observation targets (`tgt-xxx`). */
export async function getTargets(): Promise<ArlTarget[]> {
  const raw = await requestJson<unknown>(env().ARL_API_PATH_TARGETS, {
    ttlMs: CACHE_TTL_MS.targets,
  });
  return unwrapCollection(raw, ["targets", "observations"])
    .map(normalizeTarget)
    .filter((target): target is ArlTarget => target !== null);
}

export async function getTarget(id: string): Promise<ArlTarget | null> {
  const targets = await getTargets();
  return targets.find((target) => target.id === id) ?? null;
}

export function invalidateArlCache(): void {
  cache.clear();
}
