import mqtt from "mqtt";
import { loadConfig } from "./env.mjs";

/**
 * Publish a single ARL message, for wiring and fault-injection experiments.
 *
 *   npm run pub -- arl/rta/cmd/dish-007/enable_dish '{"value":false,"researcher":"arl-as3"}'
 *   npm run pub -- arl/rta/cmd/main/start_scan '{"value":true}' --researcher arl-as3
 *
 * A `command_id` and `researcher` are filled in when the topic is a command and
 * the payload does not carry them, so the simulator always accepts the message.
 */

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const positional = args.filter((arg) => !arg.startsWith("--"));
const [topic, rawPayload = "{}"] = positional;

if (!topic) {
  console.error("usage: npm run pub -- <topic> [json-payload]");
  process.exit(1);
}

function flagValue(name) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return null;
  const next = args[index + 1];
  return next && !next.startsWith("--") ? next : true;
}

let payload;
try {
  payload = JSON.parse(rawPayload);
} catch {
  console.error("[pub] payload must be JSON");
  process.exit(1);
}

if (topic.includes("/cmd/")) {
  payload.command_id ??= `cmd-${Math.random().toString(36).slice(2, 10)}`;
  payload.researcher ??= flagValue("researcher") || "arl-as3";
  payload.value ??= true;
}

const config = loadConfig();
const url = `${config.brokerProtocol}://${config.brokerAddress}:${config.brokerPort}`;
const client = mqtt.connect(url, {
  clientId: `arl-pub-${Math.random().toString(36).slice(2, 8)}`,
  protocolVersion: 4,
  username: config.brokerUser || undefined,
  password: config.brokerPassword || undefined,
  reconnectPeriod: 0,
});

const retain = flags.has("--retain");

client.on("connect", () => {
  client.publish(topic, JSON.stringify(payload), { qos: 1, retain }, (error) => {
    if (error) {
      console.error(`[pub] failed: ${error.message}`);
      process.exit(1);
    }
    console.log(`${topic} <- ${JSON.stringify(payload)}`);
    if (payload.command_id && topic.includes("/cmd/")) {
      const service = topic.split("/")[1];
      const ackTopic = `arl/${service}/ack/${payload.command_id}`;
      client.subscribe(ackTopic, { qos: 1 });
      setTimeout(() => client.end(true, {}, () => process.exit(0)), 4000);
      return;
    }
    client.end(true, {}, () => process.exit(0));
  });
});

client.on("message", (ackTopic, buffer) => {
  console.log(`${ackTopic} -> ${buffer.toString("utf8")}`);
});

client.on("error", (error) => {
  console.error(`[pub] broker error: ${error.message}`);
  process.exit(1);
});
