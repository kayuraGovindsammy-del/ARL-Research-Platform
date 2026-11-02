import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimal .env loader for the standalone dev scripts.
 *
 * The Next.js server loads `.env` itself; these scripts run outside Next, so
 * they parse the same files (`.env` then `.env.local`, which wins) without
 * pulling in a dotenv dependency. Values already present in process.env win
 * over file values, so `MQTT_BROKER_PORT=1884 npm run broker` still works.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseEnvFile(path) {
  const content = readFileSync(path, "utf8");
  const out = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(" #");
      if (comment !== -1) value = value.slice(0, comment).trim();
    }

    out[key] = value;
  }

  return out;
}

export function loadEnvFiles() {
  const merged = {};
  for (const name of [".env", ".env.local"]) {
    const path = resolve(ROOT, name);
    if (existsSync(path)) Object.assign(merged, parseEnvFile(path));
  }
  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return merged;
}

function int(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig() {
  loadEnvFiles();

  return {
    root: ROOT,
    brokerAddress: process.env.MQTT_BROKER_ADDRESS || "127.0.0.1",
    brokerPort: int(process.env.MQTT_BROKER_PORT, 1883),
    brokerUser: process.env.MQTT_BROKER_USER || "",
    brokerPassword: process.env.MQTT_BROKER_PASSWORD || "",
    brokerProtocol: (process.env.MQTT_BROKER_PROTOCOL || "mqtt").toLowerCase(),
    topicPrefix: (process.env.MQTT_TOPIC_PREFIX || "arl").replace(/^\/+|\/+$/g, ""),
  };
}
