import mqtt from "mqtt";
const client = mqtt.connect("mqtt://127.0.0.1:1883", { protocolVersion: 4, reconnectPeriod: 0 });
client.on("connect", () => {
  const waiting = [];
  for (let i = 1; i <= 100; i += 1) {
    const id = `dish-${String(i).padStart(3, "0")}`;
    waiting.push(new Promise((resolve, reject) =>
      client.publish(`arl/rta/cmd/${id}/enable_dish`,
        JSON.stringify({ command_id: `cmd-en-${i}`, researcher: "arl-as3", value: true }),
        { qos: 1 }, (e) => (e ? reject(e) : resolve()))));
  }
  Promise.all(waiting).then(() => { console.log("published 100"); client.end(true, {}, () => process.exit(0)); });
});
client.on("error", (e) => { console.error(e.message); process.exit(1); });
