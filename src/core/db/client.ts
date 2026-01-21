/**
 * Turso database client.
 * Works in Node.js and edge runtimes (Vercel Edge Functions).
 */

import { createClient, type Client } from "@libsql/client";

let client: Client | null = null;
let initialized = false;

/**
 * Get the Turso database client.
 * Creates a singleton instance on first call and enables foreign key enforcement.
 *
 * Requires environment variables:
 * - TURSO_DATABASE_URL: libsql://your-database.turso.io
 * - TURSO_AUTH_TOKEN: your-auth-token
 *
 * @throws Error if environment variables are not set
 */
export async function getClient(): Promise<Client> {
  if (client && initialized) {
    return client;
  }

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    throw new Error("TURSO_DATABASE_URL environment variable is not set");
  }

  if (!authToken) {
    throw new Error("TURSO_AUTH_TOKEN environment variable is not set");
  }

  client = createClient({
    url,
    authToken,
  });

  // Enable foreign key enforcement (SQLite/libSQL doesn't enforce by default)
  await client.execute("PRAGMA foreign_keys = ON");
  initialized = true;

  return client;
}

/**
 * Close the database connection.
 * Call this when shutting down the application.
 */
export function closeClient(): void {
  if (client) {
    client.close();
    client = null;
    initialized = false;
  }
}

// Re-export types for convenience
export type { Client } from "@libsql/client";
