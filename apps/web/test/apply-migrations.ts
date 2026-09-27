import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Runs before each test file. Migrations already applied are skipped, so the
// test database always has the schema in migrations/.
const { DB, TEST_MIGRATIONS } = env as Env & { TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(DB, TEST_MIGRATIONS);
