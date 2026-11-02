import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { TEST_DB_PATH, TEST_DATABASE_URL } from "./db";

/**
 * Prepare the throwaway database before any suite runs.
 *
 * `prisma db push` is used instead of migrations on purpose: the exam lab
 * expects the schema to be created from `prisma/schema.prisma`, and this keeps
 * the test database and the runtime database identical by construction.
 */
export default function setup(): () => void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }

  execFileSync(join(process.cwd(), "node_modules", ".bin", "prisma"), ["db", "push", "--skip-generate"], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });

  return () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
    }
  };
}
