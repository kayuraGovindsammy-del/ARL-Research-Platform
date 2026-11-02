/**
 * Next.js instrumentation hook: runs once when the Node.js server boots.
 * This is where the single in-memory MQTT ingestion worker is started so the
 * broker connection survives route handler re-evaluation.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    // Apply the SQLite pragmas (WAL, busy timeout) before ingestion starts.
    const { dbReady } = await import("./lib/prisma");
    await dbReady;

    const { ensureMqttWorker } = await import("./lib/mqtt-worker");
    ensureMqttWorker();
  } catch (error) {
    console.error("[instrumentation] MQTT worker bootstrap failed:", error);
  }
}
