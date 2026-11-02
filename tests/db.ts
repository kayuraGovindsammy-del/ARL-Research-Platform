import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * The persistence suite runs against a throwaway SQLite file so a test run can
 * never touch the developer's `prisma/dev.db` (which holds captured lab data).
 *
 * The path is absolute: Prisma resolves a relative `file:` URL against the
 * schema directory, which would silently land inside `prisma/` again.
 */
export const TEST_DB_PATH = join(tmpdir(), "arl-platform-tests.db");

/** `connection_limit=1` mirrors production: SQLite has a single writer. */
export const TEST_DATABASE_URL = `file:${TEST_DB_PATH}?connection_limit=1`;
