import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { createClient } from "@libsql/client";
import { parsePool, normalizeCardName } from "../../parseCsv";
import type { ScryCard } from "../../types";
import { loadOptOutNames } from "../../optOuts";
import { PROJECT_ROOT, loadEnv, log, logIndent, computeImportHash } from "./utils";
import { discoverDrafts } from "./discover";
import type { DraftFolder } from "./discover";
import { getDraftImportHash, deleteDraft } from "./db-helpers";
import { loadScryfallCache, fetchMissingScryfallCards, backfillScryfallData } from "./scryfall";
import { incrementalIngestDraft } from "./incremental";
import { processDraftInner } from "./full-import";

// Re-export public API
export { incrementalPicks, incrementalMatches, incrementalDecklists } from "./incremental";

/**
 * Parse CLI arguments: any arg starting with -- is a flag, anything else is a draft ID filter.
 */
export function parseIngestArgs(args: string[]): {
  force: boolean;
  filterDraftId: string | undefined;
} {
  let force = false;
  let filterDraftId: string | undefined;

  for (const arg of args) {
    if (arg === "--force") {
      force = true;
    } else {
      filterDraftId = arg;
    }
  }

  return { force, filterDraftId };
}

/**
 * Process a single draft folder.
 */
async function processDraft(
  client: import("@libsql/client").Client,
  draft: DraftFolder,
  scryfallCache: Map<string, ScryCard>,
  optOutNames: Set<string>,
  force: boolean
): Promise<{ imported: boolean; skipped: boolean; error?: string }> {
  const { draftId, path: draftPath } = draft;

  // Compute import hash
  const importHash = computeImportHash(draftPath);

  // Check if draft exists with same hash
  const existingHash = await getDraftImportHash(client, draftId);

  if (existingHash === importHash && !force) {
    logIndent(`Skipped (unchanged, hash: ${importHash})`);
    return { imported: false, skipped: true };
  }

  if (existingHash !== null) {
    if (force) {
      // --force: delete everything and reimport from scratch
      logIndent(`Force reimporting (hash: ${existingHash} -> ${importHash})`);
      await deleteDraft(client, draftId);
    } else {
      // Hash changed: use incremental path
      logIndent(`Incremental update (hash: ${existingHash} -> ${importHash})`);
      return await incrementalIngestDraft(client, draft, importHash, optOutNames);
    }
  }

  // Full import path (new draft, or force reimport after delete)
  return await processDraftInner(
    client,
    draft,
    scryfallCache,
    importHash,
    optOutNames,
  );
}

export async function main(): Promise<void> {
  loadEnv();

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    console.error("[ingest] Error: TURSO_DATABASE_URL not set");
    console.error("  Set it in .env.local or as an environment variable");
    process.exit(1);
  }

  if (!authToken) {
    console.error("[ingest] Error: TURSO_AUTH_TOKEN not set");
    console.error("  Set it in .env.local or as an environment variable");
    process.exit(1);
  }

  // Parse arguments
  const args = process.argv.slice(2);
  const { force, filterDraftId } = parseIngestArgs(args);

  // Discover drafts
  log("Discovering drafts...");
  const dataDir = join(PROJECT_ROOT, "data");
  const drafts = discoverDrafts(dataDir, filterDraftId);

  if (drafts.length === 0) {
    if (filterDraftId) {
      console.error(`[ingest] Error: Draft "${filterDraftId}" not found`);
      console.error(
        `  Make sure data/${filterDraftId}/ exists with picks.csv and pool.csv`
      );
    } else {
      console.error("[ingest] Error: No drafts found in data/");
    }
    process.exit(1);
  }

  log(`Found ${drafts.length} draft${drafts.length === 1 ? "" : "s"}`);
  console.log();

  // Load Scryfall cache and fetch any missing cards
  const scryfallCache = loadScryfallCache();
  log(`Loaded Scryfall cache with ${scryfallCache.size} cards`);

  // Collect all unique card names across drafts, then fetch missing from Scryfall
  const allCardNames = new Set<string>();
  for (const draft of drafts) {
    const poolPath = join(draft.path, "pool.csv");
    if (existsSync(poolPath)) {
      const poolCsv = readFileSync(poolPath, "utf-8");
      for (const name of parsePool(poolCsv)) {
        allCardNames.add(normalizeCardName(name));
      }
    }
  }
  await fetchMissingScryfallCards(scryfallCache, [...allCardNames]);

  // Load opt-outs
  const optOutNames = loadOptOutNames();
  if (optOutNames.size > 0) {
    log(`Loaded ${optOutNames.size} opt-out name(s)`);
  }
  console.log();

  // Own client instance (not the singleton from client.ts) because the
  // ingest script controls its own connection lifecycle, including close().
  const client = createClient({ url, authToken });

  // Enable foreign key enforcement
  await client.execute("PRAGMA foreign_keys = ON");

  let importedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  try {
    for (const draft of drafts) {
      log(`Processing ${draft.draftId}...`);

      try {
        const result = await processDraft(client, draft, scryfallCache, optOutNames, force);

        if (result.error) {
          console.error(`  Error: ${result.error}`);
          errorCount++;
        } else if (result.imported) {
          importedCount++;
        } else if (result.skipped) {
          skippedCount++;
        }
      } catch (error) {
        console.error(`  Error: ${error}`);
        errorCount++;
      }

      console.log();
    }

    // Backfill scryfall_json for cards that are missing it
    const backfillCount = await backfillScryfallData(client, scryfallCache);
    if (backfillCount > 0) {
      log(`Backfilled Scryfall data for ${backfillCount} cards`);
    }

    // Compute and write ingestion hash from all draft import hashes
    const hashResult = await client.execute({
      sql: "SELECT import_hash FROM drafts ORDER BY draft_id",
      args: [],
    });
    const draftHashes = hashResult.rows.map((r) => r.import_hash as string);
    const hashInput = draftHashes.join(",");
    const ingestionHash = createHash("sha256")
      .update(hashInput)
      .digest("hex")
      .slice(0, 8);

    await client.execute({
      sql: `INSERT OR REPLACE INTO ingestion_meta (key, value) VALUES ('last_hash', ?)`,
      args: [ingestionHash],
    });
    log(`Wrote ingestion hash: ${ingestionHash}`);

    // Final summary
    log(
      `Complete: ${importedCount} imported, ${skippedCount} skipped${errorCount > 0 ? `, ${errorCount} errors` : ""}${backfillCount > 0 ? `, ${backfillCount} backfilled` : ""}`
    );
  } finally {
    client.close();
  }

  if (errorCount > 0) {
    process.exit(1);
  }
}
