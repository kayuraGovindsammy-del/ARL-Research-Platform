import mqtt from "mqtt";
import { loadConfig } from "./env.mjs";

/**
 * Topic inspector for the ARL broker.
 *
 *   npm run topics                # inventory of everything under arl/#
 *   npm run topics -- --seconds 20
 *   npm run topics -- --topic arl/rta/dish-001/telemetry/normal
 *   npm run topics -- --topology rta        # print a service's $topology document
 *   npm run topics -- --json > topics.json
 *
 * Retained messages arrive on subscribe (they are the service's state +
 * $topology contract); the rest are live samples collected for a window.
 */

const args = process.argv.slice(2);
function flag(name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const next = args[index + 1];
  return next && !next.startsWith("--") ? next : true;
}

const config = loadConfig();
const seconds = Number(flag("seconds", 10));
const onlyTopic = flag("topic");
const topologyOf = flag("topology");
const asJson = Boolean(flag("json", false));
const root = onlyTopic && typeof onlyTopic === "string" ? onlyTopic : `${config.topicPrefix}/#`;

const url = `${config.brokerProtocol}://${config.brokerAddress}:${config.brokerPort}`;
const client = mqtt.connect(url, {
  clientId: `arl-inspect-${Math.random().toString(36).slice(2, 8)}`,
  protocolVersion: 4,
  username: config.brokerUser || undefined,
  password: config.brokerPassword || undefined,
  reconnectPeriod: 0,
});

/** topic -> { count, retained, last, sample } */
const inventory = new Map();
const live = [];
const topologies = new Map();

function record(topic, payload, retained) {
  let entry = inventory.get(topic);
  if (!entry) {
    entry = { topic, count: 0, retained: false, last: 0, sample: null };
    inventory.set(topic, entry);
  }
  entry.count += 1;
  entry.retained = entry.retained || retained;
  entry.last = Date.now();
  entry.sample = payload;
}

client.on("connect", () => {
  console.error(`[topics] subscribing to ${root} on ${url}`);
  client.subscribe(root, { qos: 0 });
});

client.on("message", (topic, buffer, packet) => {
  let payload = buffer.toString("utf8");
  try {
    payload = JSON.parse(payload);
  } catch {
    // keep as raw text
  }
  record(topic, payload, Boolean(packet?.retain));
  if (topic.endsWith("/$topology")) topologies.set(topic, payload);
  if (asJson) live.push({ topic, payload, retained: Boolean(packet?.retain) });
});

client.on("error", (error) => {
  console.error(`[topics] broker error: ${error.message}`);
  process.exit(1);
});

function printTopology() {
  const wanted = typeof topologyOf === "string" ? topologyOf : null;
  const entries = [...topologies.entries()].filter(([topic]) =>
    wanted ? topic.split("/").includes(wanted) : true,
  );
  if (entries.length === 0) {
    console.error("[topics] no $topology document received yet");
    return;
  }
  console.log(JSON.stringify(Object.fromEntries(entries), null, 2));
}

setTimeout(() => {
  client.end(true);

  if (asJson) {
    process.stdout.write(JSON.stringify(live, null, 2));
    process.exit(0);
  }
  if (topologyOf !== null) {
    printTopology();
    process.exit(0);
  }

  const rows = [...inventory.values()].sort((a, b) => a.topic.localeCompare(b.topic));
  const summary = new Map();
  for (const row of rows) {
    const kind = row.retained ? "retained" : "live";
    const parts = row.topic.split("/");
    // arl/<service>/<entity>/<kind>/<stream>
    const key = `${parts[1] ?? "?"} · ${parts[2] ?? "?"} · ${kind}`;
    summary.set(key, (summary.get(key) ?? 0) + 1);
  }

  console.log(`\n${rows.length} topics in ${seconds}s\n`);
  for (const [key, count] of [...summary.entries()].sort()) {
    console.log(`  ${count.toString().padStart(4)}  ${key}`);
  }

  console.log("\nsample payloads");
  const shown = new Set();
  for (const row of rows) {
    const shape = row.topic
      .split("/")
      .map((part) => (/^(dish|crew|room|quarters|scan|tgt|site)/.test(part) ? "*" : part))
      .join("/");
    if (shown.has(shape) || shown.size >= 24) continue;
    shown.add(shape);
    console.log(`\n  ${row.topic}${row.retained ? "  (retained)" : ""}`);
    console.log(`  ${JSON.stringify(row.sample).slice(0, 300)}`);
  }
  process.exit(0);
}, seconds * 1000);
