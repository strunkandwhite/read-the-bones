/**
 * Database migration script.
 * Runs schema.sql against the Turso database.
 *
 * Usage:
 *   pnpm db:migrate
 *
 * Requires environment variables:
 *   TURSO_DATABASE_URL - libsql://your-database.turso.io
 *   TURSO_AUTH_TOKEN - your-auth-token
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@libsql/client";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load environment variables from .env files.
 * Checks .env.local first, then .env.
 */
function loadEnv(): void {
  dotenv.config({ path: join(process.cwd(), ".env.local") });
  dotenv.config({ path: join(process.cwd(), ".env") });
}

/**
 * Run the schema migration.
 */
async function migrate(): Promise<void> {
  loadEnv();

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    console.error("[db:migrate] Error: TURSO_DATABASE_URL not set");
    console.error("  Set it in .env.local or as an environment variable");
    process.exit(1);
  }

  if (!authToken) {
    console.error("[db:migrate] Error: TURSO_AUTH_TOKEN not set");
    console.error("  Set it in .env.local or as an environment variable");
    process.exit(1);
  }

  // Read schema file
  const schemaPath = join(__dirname, "schema.sql");
  if (!existsSync(schemaPath)) {
    console.error(`[db:migrate] Error: Schema file not found: ${schemaPath}`);
    process.exit(1);
  }

  const schema = readFileSync(schemaPath, "utf-8");

  // Split into individual statements
  // Note: This simple parser assumes statements don't contain embedded `;` in strings.
  // For complex schemas, consider a proper SQL parser.
  //
  // Steps:
  // 1. Remove full-line comments (lines starting with --)
  // 2. Split on semicolons
  // 3. Filter out empty statements
  const schemaWithoutComments = schema
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  const statements = schemaWithoutComments
    .split(";")
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);

  console.log(`[db:migrate] Connecting to database...`);
  console.log(`  URL: ${url.replace(/\/\/.*@/, "//***@")}`); // Hide credentials

  const client = createClient({ url, authToken });

  try {
    console.log(`[db:migrate] Running ${statements.length} statements...`);

    for (const statement of statements) {
      // Extract table/index name for logging
      const match = statement.match(
        /(?:CREATE\s+(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?)([\w]+)/i
      );
      const name = match ? match[1] : statement.slice(0, 40) + "...";

      try {
        await client.execute(statement);
        console.log(`  OK: ${name}`);
      } catch (stmtError) {
        // ALTER TABLE ADD COLUMN fails if column already exists — that's safe to skip
        const msg = stmtError instanceof Error ? stmtError.message : String(stmtError);
        if (/duplicate column/i.test(msg) || /already exists/i.test(msg) || /no such table/i.test(msg)) {
          console.log(`  SKIP (already exists): ${name}`);
        } else {
          throw stmtError;
        }
      }
    }

    console.log(`[db:migrate] Migration complete`);

    await migrateQueueToJson(client);
  } catch (error) {
    console.error(`[db:migrate] Migration failed:`, error);
    process.exit(1);
  } finally {
    client.close();
  }
}

async function migrateQueueToJson(client: ReturnType<typeof createClient>) {
  // Check if pick_queue table exists
  const tableCheck = await client.execute({
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='pick_queue'`,
    args: [],
  });
  if (tableCheck.rows.length === 0) return; // Already migrated

  // Check if queue_json column exists
  const colCheck = await client.execute({
    sql: `PRAGMA table_info(seat_tokens)`,
    args: [],
  });
  const hasQueueJson = colCheck.rows.some((r) => r.name === 'queue_json');
  if (!hasQueueJson) return; // Column not yet added, skip

  console.log(`[db:migrate] Migrating pick_queue → queue_json...`);

  // Read all queue entries joined with card names
  const entries = await client.execute({
    sql: `SELECT pq.draft_id, pq.seat, pq.priority, pq.card_id, c.name
          FROM pick_queue pq
          JOIN cards c ON c.card_id = pq.card_id
          ORDER BY pq.draft_id, pq.seat, pq.priority`,
    args: [],
  });

  // Group by (draft_id, seat)
  const grouped = new Map<string, { id: number; name: string }[]>();
  for (const row of entries.rows) {
    const key = `${row.draft_id}:${row.seat}`;
    const arr = grouped.get(key) ?? [];
    arr.push({ id: row.card_id as number, name: row.name as string });
    grouped.set(key, arr);
  }

  // Write JSON to seat_tokens
  const statements: { sql: string; args: (string | number)[] }[] = [];
  for (const [key, cards] of grouped) {
    const [draftId, seatStr] = key.split(':');
    const queueJson = cards.map((c) => ({
      mode: 'pause',
      cards: [{ id: c.id, name: c.name }],
    }));
    statements.push({
      sql: `UPDATE seat_tokens SET queue_json = ? WHERE draft_id = ? AND seat = ?`,
      args: [JSON.stringify(queueJson), draftId, parseInt(seatStr)],
    });
  }

  // Set empty queue for seats without queue entries
  statements.push({
    sql: `UPDATE seat_tokens SET queue_json = '[]' WHERE queue_json IS NULL`,
    args: [],
  });

  if (statements.length > 0) {
    await client.batch(statements);
  }

  // Drop pick_queue table and auto_pick_mode column
  await client.execute({ sql: `DROP TABLE IF EXISTS pick_queue`, args: [] });
  await client.execute({ sql: `ALTER TABLE seat_tokens DROP COLUMN auto_pick_mode`, args: [] });

  console.log(`[db:migrate] pick_queue migration complete`);
}

migrate();
