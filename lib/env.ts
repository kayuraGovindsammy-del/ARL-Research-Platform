import { z } from "zod";

/**
 * Environment contract for the ARL platform.
 *
 * Validation is lazy: the schema is only evaluated the first time `env()` is
 * called at runtime. This keeps `next build` (which imports route modules for
 * static analysis) independent from the deployment secrets, while still
 * failing fast on the first request when the configuration is incomplete.
 */

const booleanish = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // ARL REST API -----------------------------------------------------------
  ARL_API_ADDRESS: z.string().min(1, "ARL_API_ADDRESS is required"),
  ARL_API_PORT: z.coerce.number().int().positive().max(65535),
  ARL_API_PROTOCOL: z.enum(["http", "https"]).default("https"),
  ARL_API_TLS_VERIFY: booleanish.default("false"),
  ARL_API_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  ARL_API_PATH_METADATA: z.string().startsWith("/").default("/metadata"),
  ARL_API_PATH_PARAMETERS: z.string().startsWith("/").default("/parameters"),
  ARL_API_PATH_TARGETS: z.string().startsWith("/").default("/targets"),

  // MQTT broker ------------------------------------------------------------
  MQTT_BROKER_ADDRESS: z.string().min(1, "MQTT_BROKER_ADDRESS is required"),
  MQTT_BROKER_PORT: z.coerce.number().int().positive().max(65535),
  MQTT_BROKER_USER: z.string().default(""),
  MQTT_BROKER_PASSWORD: z.string().default(""),
  MQTT_BROKER_PROTOCOL: z.enum(["mqtt", "mqtts", "ws", "wss"]).default("mqtt"),
  MQTT_TOPIC_PREFIX: z
    .string()
    .min(1)
    .default("arl")
    .refine((prefix) => !prefix.endsWith("/") && !prefix.startsWith("/"), {
      message: "MQTT_TOPIC_PREFIX must not start or end with '/'",
    }),

  DATABASE_URL: z.string().min(1).default("file:./dev.db?connection_limit=1"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

function parseEnv(): Env {
  const parsed = envSchema.safeParse({
    NODE_ENV: process.env.NODE_ENV,
    ARL_API_ADDRESS: process.env.ARL_API_ADDRESS,
    ARL_API_PORT: process.env.ARL_API_PORT,
    ARL_API_PROTOCOL: process.env.ARL_API_PROTOCOL,
    ARL_API_TLS_VERIFY: process.env.ARL_API_TLS_VERIFY,
    ARL_API_TIMEOUT_MS: process.env.ARL_API_TIMEOUT_MS,
    ARL_API_PATH_METADATA: process.env.ARL_API_PATH_METADATA,
    ARL_API_PATH_PARAMETERS: process.env.ARL_API_PATH_PARAMETERS,
    ARL_API_PATH_TARGETS: process.env.ARL_API_PATH_TARGETS,
    MQTT_BROKER_ADDRESS: process.env.MQTT_BROKER_ADDRESS,
    MQTT_BROKER_PORT: process.env.MQTT_BROKER_PORT,
    MQTT_BROKER_USER: process.env.MQTT_BROKER_USER,
    MQTT_BROKER_PASSWORD: process.env.MQTT_BROKER_PASSWORD,
    MQTT_BROKER_PROTOCOL: process.env.MQTT_BROKER_PROTOCOL,
    MQTT_TOPIC_PREFIX: process.env.MQTT_TOPIC_PREFIX,
    DATABASE_URL: process.env.DATABASE_URL,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid ARL environment configuration:\n${issues}`);
  }

  return parsed.data;
}

/** Validated, cached environment. Throws on first access when invalid. */
export function env(): Env {
  if (!cached) cached = parseEnv();
  return cached;
}

/** Non-throwing check used by `/api/health` and the settings panel. */
export function inspectEnv(): { ok: true } | { ok: false; error: string } {
  try {
    env();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function arlApiBaseUrl(): string {
  const config = env();
  return `${config.ARL_API_PROTOCOL}://${config.ARL_API_ADDRESS}:${config.ARL_API_PORT}`;
}

export function arlApiDocsUrl(): string {
  return `${arlApiBaseUrl()}/docs`;
}

export function mqttBrokerUrl(): string {
  const config = env();
  return `${config.MQTT_BROKER_PROTOCOL}://${config.MQTT_BROKER_ADDRESS}:${config.MQTT_BROKER_PORT}`;
}
