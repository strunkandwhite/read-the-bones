// scripts/draft-create.ts
//
// Create a new draft record in Turso for Sheets-based sync.
// Usage: pnpm draft:create --name "Draft Name" --date 2026-03-22 [--sheet-id <id>] [--banned-cards "Card A,Card B"]

import { createClient } from "@libsql/client";
import { loadEnv } from "../src/core/db/ingest/utils";
import { slugify } from "./lib/slugify";

function parseArgs(args: string[]) {
  let name = "",
    date = "",
    sheetId = "",
    bannedCards: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--name":
        name = args[++i];
        break;
      case "--date":
        date = args[++i];
        break;
      case "--sheet-id":
        sheetId = args[++i];
        break;
      case "--banned-cards":
        bannedCards = args[++i].split(",").map((s) => s.trim());
        break;
    }
  }

  if (!name) throw new Error("--name is required");
  if (!date) throw new Error("--date is required (YYYY-MM-DD)");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error("--date must be in YYYY-MM-DD format");

  return { name, date, sheetId: sheetId || null, bannedCards };
}

async function main() {
  loadEnv();
  const { name, date, sheetId, bannedCards } = parseArgs(process.argv.slice(2));
  const draftId = slugify(name);

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  // Create a placeholder cube snapshot — sync will replace it when pool data arrives
  const placeholderHash = `placeholder:${draftId}`;
  const snapshotResult = await client.execute({
    sql: "INSERT OR IGNORE INTO cube_snapshots (cube_hash) VALUES (?)",
    args: [placeholderHash],
  });

  let cubeSnapshotId: number;
  if (snapshotResult.rowsAffected > 0) {
    cubeSnapshotId = Number(snapshotResult.lastInsertRowid);
  } else {
    const existing = await client.execute({
      sql: "SELECT cube_snapshot_id FROM cube_snapshots WHERE cube_hash = ?",
      args: [placeholderHash],
    });
    cubeSnapshotId = existing.rows[0].cube_snapshot_id as number;
  }

  await client.execute({
    sql: `INSERT INTO drafts (draft_id, draft_name, draft_date, cube_snapshot_id, num_seats, phase, sheet_id, banned_cards, import_hash)
          VALUES (?, ?, ?, ?, 0, 'setup', ?, ?, '')`,
    args: [
      draftId,
      name,
      date,
      cubeSnapshotId,
      sheetId,
      bannedCards.length > 0 ? JSON.stringify(bannedCards) : null,
    ],
  });

  console.log(`Created draft: ${draftId} (${name}, ${date})`);
  if (sheetId) console.log(`  Sheet ID: ${sheetId}`);
  if (bannedCards.length > 0) console.log(`  Banned: ${bannedCards.join(", ")}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
