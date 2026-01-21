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

      await client.execute(statement);
      console.log(`  OK: ${name}`);
    }

    console.log(`[db:migrate] Migration complete`);
  } catch (error) {
    console.error(`[db:migrate] Migration failed:`, error);
    process.exit(1);
  } finally {
    client.close();
  }
}

migrate();
