import { PrismaClient } from "@prisma/client";

/**
 * Prisma client singleton. Next.js hot-reloads modules in development, which
 * would otherwise open a new SQLite connection pool on every reload.
 */
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaTuning?: Promise<void>;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * SQLite hardening.
 *
 * The ingestion worker writes at ~24 samples/second during an RTA scan while
 * dashboards read snapshots concurrently. In the default rollback-journal mode
 * a single write transaction blocks every reader (and vice versa), which
 * surfaces as `P1008: Operations timed out`. WAL lets readers proceed against
 * the last committed snapshot while one writer appends, and a generous busy
 * timeout absorbs the remaining writer/writer collisions.
 *
 * `journal_mode` is persistent in the database file; the other pragmas are
 * per-connection, so this runs once per process (the pool is pinned to a single
 * connection through `connection_limit` in DATABASE_URL).
 */
async function tuneDatabase(client: PrismaClient): Promise<void> {
  try {
    const [journal] = (await client.$queryRawUnsafe("PRAGMA journal_mode=WAL")) as Array<{
      journal_mode: string;
    }>;
    const [busy] = (await client.$queryRawUnsafe("PRAGMA busy_timeout=15000")) as Array<{
      timeout: bigint | number;
    }>;
    await client.$executeRawUnsafe("PRAGMA synchronous=NORMAL");
    console.info(
      `[db] sqlite journal_mode=${journal?.journal_mode ?? "unknown"} busy_timeout=${
        busy ? Number(busy.timeout) : "unknown"
      }`,
    );
  } catch (error) {
    // Tuning is an optimisation: a failure must never stop the platform booting.
    console.error("[db] sqlite tuning failed:", error instanceof Error ? error.message : error);
  }
}

/** Resolves once the pragmas above have been applied (idempotent per process). */
export const dbReady: Promise<void> =
  globalForPrisma.prismaTuning ??
  (globalForPrisma.prismaTuning = tuneDatabase(prisma));

/** SQLite lock contention codes worth retrying rather than dropping data for. */
const RETRYABLE_CODES = new Set(["P1008", "P2024", "P2034"]);

function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === "string" && RETRYABLE_CODES.has(code)) return true;
  return typeof message === "string" && /database is locked|SQLITE_BUSY/i.test(message);
}

export function isDatabaseBusy(error: unknown): boolean {
  return isRetryable(error);
}

/**
 * Retry a write/read that lost the SQLite lock. Batched ingestion keeps lock
 * contention rare, so a short bounded backoff is enough to ride out a prune or
 * an operator-triggered transaction.
 */
export async function withDbRetry<T>(
  operation: () => Promise<T>,
  label: string,
  attempts = 4,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await dbReady;
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts) break;
      const delay = 40 * 2 ** (attempt - 1) + Math.random() * 25;
      console.warn(`[db] ${label} retry ${attempt}/${attempts - 1} in ${Math.round(delay)}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
