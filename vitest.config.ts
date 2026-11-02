import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { TEST_DATABASE_URL } from "./tests/db";

/**
 * Test configuration.
 *
 * The suite is deliberately split by rubric concern rather than by file:
 *
 *   tests/topics.test.ts        message parsing (topic taxonomy)
 *   tests/ingest-rules.test.ts  message parsing (payload → domain record)
 *   tests/alert-rules.test.ts   alert rules (service alerts, derived alerts, guidance)
 *   tests/persistence.test.ts   persistence + replay against real SQLite
 *
 * `fileParallelism` is off because every persistence test shares one SQLite
 * file, and a test run must never be the reason a sample is dropped.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./tests/global-setup.ts"],
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      // Persistence tests talk to a throwaway file, never to prisma/dev.db.
      DATABASE_URL: TEST_DATABASE_URL,
      // Parsed by lib/env.ts; the tests never open a socket, but any module
      // that reads configuration must still see a complete contract.
      ARL_API_ADDRESS: "127.0.0.1",
      ARL_API_PORT: "8080",
      MQTT_BROKER_ADDRESS: "127.0.0.1",
      MQTT_BROKER_PORT: "1883",
      MQTT_BROKER_USER: "test",
      MQTT_BROKER_PASSWORD: "test",
      MQTT_TOPIC_PREFIX: "arl",
      ARL_RESEARCHER_CODE: "arl-as3",
      ARL_RESEARCHER_NAME: "Test Researcher",
    },
  },
});
