import net from "node:net";
import aedesFactory from "aedes";
import { loadConfig } from "./env.mjs";

/**
 * Local MQTT broker for development.
 *
 * Mirrors the lab broker contract closely enough for the platform: TCP
 * listener, optional username/password authentication taken from the same
 * MQTT_BROKER_* variables the Next.js worker uses, no persistence (the
 * platform's own SQLite database is the system of record) and a periodic
 * throughput summary so the ingestion path is visible while testing.
 */

const config = loadConfig();
const broker = aedesFactory({ id: "arl-dev-broker" });

let published = 0;
let connectedClients = 0;
const topicStats = new Map();

if (config.brokerUser || config.brokerPassword) {
  broker.authenticate = (client, username, password, done) => {
    const user = username ? username.toString() : "";
    const secret = password ? password.toString() : "";
    const ok = user === config.brokerUser && secret === config.brokerPassword;
    if (!ok) {
      console.warn(`[broker] rejected ${client?.id ?? "client"} (bad credentials)`);
      done(new Error("Invalid credentials"), false);
      return;
    }
    done(null, true);
  };
}

broker.on("client", (client) => {
  connectedClients += 1;
  console.log(`[broker] + ${client.id} (${connectedClients} connected)`);
});

broker.on("clientDisconnect", (client) => {
  connectedClients = Math.max(0, connectedClients - 1);
  console.log(`[broker] - ${client.id} (${connectedClients} connected)`);
});

broker.on("clientError", (client, error) => {
  console.warn(`[broker] client error ${client?.id ?? "?"}: ${error.message}`);
});

broker.on("publish", (packet, client) => {
  if (!client) return; // internal $SYS style packets
  published += 1;
  const topic = packet.topic;
  topicStats.set(topic, (topicStats.get(topic) ?? 0) + 1);
});

const server = net.createServer(broker.handle);

server.on("error", (error) => {
  console.error(`[broker] listen failed on ${config.brokerAddress}:${config.brokerPort}: ${error.message}`);
  process.exitCode = 1;
});

server.listen(config.brokerPort, config.brokerAddress, () => {
  console.log(
    `[broker] aedes listening on mqtt://${config.brokerAddress}:${config.brokerPort} ` +
      `(auth ${config.brokerUser ? "required" : "open"}, prefix "${config.topicPrefix}/#")`,
  );
});

// 30s throughput summary: top five topics keep the console readable under load.
const statsTimer = setInterval(() => {
  const top = [...topicStats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const detail = top.map(([topic, count]) => `${topic} ×${count}`).join(", ") || "no traffic";
  console.log(`[broker] ${published} messages published · ${connectedClients} clients · ${detail}`);
  topicStats.clear();
}, 30_000);
statsTimer.unref();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[broker] ${signal} received, closing…`);
  clearInterval(statsTimer);
  server.close(() => {
    broker.close(() => {
      console.log("[broker] stopped");
      process.exit(0);
    });
  });
  // Do not hang forever on stubborn sockets.
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
