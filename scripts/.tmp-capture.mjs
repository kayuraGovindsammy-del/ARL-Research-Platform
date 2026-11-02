import mqtt from "mqtt";
import { writeFileSync } from "node:fs";

const seconds = Number(process.argv[2] ?? 25);
const client = mqtt.connect("mqtt://localhost:1883", {
  clientId: `capture-${Date.now()}`,
  clean: true,
});

const last = new Map();
const counts = new Map();

client.on("connect", () => {
  client.subscribe("arl/#", { qos: 0 }, (err) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`capturing ${seconds}s ...`);
  });
});

client.on("message", (topic, buffer) => {
  counts.set(topic, (counts.get(topic) ?? 0) + 1);
  last.set(topic, buffer.toString());
});

setTimeout(() => {
  const out = {};
  for (const [topic, payload] of [...last.entries()].sort()) {
    out[topic] = { count: counts.get(topic) ?? 0, payload };
  }
  writeFileSync("/tmp/arl-capture.json", JSON.stringify(out, null, 2));
  console.log(`topics: ${last.size}`);
  client.end(true, () => process.exit(0));
}, seconds * 1000);
