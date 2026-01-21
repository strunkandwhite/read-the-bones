/**
 * Syncs draft data from Google Sheets.
 * Reads sheet config from metadata.json, fetches data, and writes to CSV files.
 *
 * Usage:
 *   pnpm sync-sheets              # Sync all drafts with sheetId
 *   pnpm sync-sheets tarkir       # Sync specific draft
 *   pnpm sync-sheets --dry-run    # Show what would be fetched
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { fetchDraftFromSheet, TAB_NAMES } from "../src/core/sheets";

const DATA_DIR = "data";
const RATE_LIMIT_MS = 1000; // 1 second between requests

type DraftMetadata = {
  name: string;
  date: string;
  sheetId?: string;
  status?: "complete" | "in-progress";
};

function loadMetadata(draftPath: string): DraftMetadata | null {
  const metadataPath = join(draftPath, "metadata.json");

  if (!existsSync(metadataPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(metadataPath, "utf-8"));
  } catch {
    return null;
  }
}

function getApiKey(): string | null {
  // Check environment variable
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
  if (apiKey) return apiKey;

  // Try loading from .env.local or .env
  for (const envFile of [".env.local", ".env"]) {
    const envPath = join(process.cwd(), envFile);
    if (existsSync(envPath)) {
      const envContent = readFileSync(envPath, "utf-8");
      const match = envContent.match(/GOOGLE_SHEETS_API_KEY=(.+)/);
      if (match) return match[1].trim();
    }
  }

  return null;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SyncResult = {
  status: "synced" | "skipped" | "failed";
  tabsSynced: string[];
};

async function syncDraft(
  draftId: string,
  apiKey: string,
  dryRun: boolean,
  verbose: boolean
): Promise<SyncResult> {
  const draftPath = join(DATA_DIR, draftId);
  const metadata = loadMetadata(draftPath);

  if (!metadata?.sheetId) {
    if (verbose) {
      console.log(`[sync-sheets] Skipping "${draftId}": no sheetId in metadata`);
    }
    return { status: "skipped", tabsSynced: [] };
  }

  // Skip complete drafts (only sync in-progress drafts)
  if (metadata.status === "complete") {
    if (verbose) {
      console.log(`[sync-sheets] Skipping "${draftId}": draft is complete`);
    }
    return { status: "skipped", tabsSynced: [] };
  }

  console.log(`[sync-sheets] Syncing "${metadata.name}" (${draftId})`);
  console.log(`  Sheet ID: ${metadata.sheetId}`);

  if (dryRun) {
    console.log(`  Would fetch tabs: ${Object.values(TAB_NAMES).join(", ")}`);
    return { status: "synced", tabsSynced: [] };
  }

  try {
    const data = await fetchDraftFromSheet(metadata.sheetId, apiKey);
    const tabsSynced: string[] = [];

    // Write each tab's data
    const tabMap = {
      picks: data.picks,
      pool: data.pool,
      matches: data.matches,
    } as const;

    for (const [key, csv] of Object.entries(tabMap)) {
      if (csv) {
        const filepath = join(draftPath, `${key}.csv`);
        writeFileSync(filepath, csv, "utf-8");
        console.log(`  Wrote: ${key}.csv (${csv.length} bytes)`);
        tabsSynced.push(key);
      } else {
        console.log(`  Skipped: ${key}.csv (tab "${TAB_NAMES[key as keyof typeof TAB_NAMES]}" not found)`);
      }
    }

    return { status: "synced", tabsSynced };
  } catch (error) {
    console.error(`  Error: ${error instanceof Error ? error.message : error}`);
    return { status: "failed", tabsSynced: [] };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const verbose = args.includes("--verbose") || args.includes("-v");
  const specificDraft = args.find((a) => !a.startsWith("--"));

  // Get API key
  const apiKey = getApiKey();
  if (!apiKey && !dryRun) {
    console.error("[sync-sheets] Error: GOOGLE_SHEETS_API_KEY not found");
    console.error("  Set it in .env.local or as an environment variable");
    console.error("  See: https://console.cloud.google.com/apis/credentials");
    process.exit(1);
  }

  if (!existsSync(DATA_DIR)) {
    console.error(`[sync-sheets] Data directory not found: ${DATA_DIR}`);
    process.exit(1);
  }

  // Find drafts to sync
  let drafts: string[];
  if (specificDraft) {
    // Check if it's a partial match
    const allDrafts = readdirSync(DATA_DIR).filter((entry) => {
      const entryPath = join(DATA_DIR, entry);
      return statSync(entryPath).isDirectory();
    });

    const matches = allDrafts.filter((d) => d.includes(specificDraft));
    if (matches.length === 0) {
      console.error(`[sync-sheets] No draft found matching: ${specificDraft}`);
      console.error(`  Available: ${allDrafts.join(", ")}`);
      process.exit(1);
    }
    drafts = matches;
  } else {
    drafts = readdirSync(DATA_DIR).filter((entry) => {
      const entryPath = join(DATA_DIR, entry);
      if (!statSync(entryPath).isDirectory()) return false;
      const metadata = loadMetadata(entryPath);
      return metadata?.sheetId != null;
    });
  }

  if (drafts.length === 0) {
    console.log("[sync-sheets] No drafts with sheetId found");
    console.log("  Add sheetId to metadata.json files to enable syncing");
    return;
  }

  if (dryRun && verbose) {
    console.log("[sync-sheets] Dry run mode - no files will be written");
  }

  if (verbose) {
    console.log(`[sync-sheets] Found ${drafts.length} draft(s) to sync`);
  }

  let syncedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < drafts.length; i++) {
    const draftId = drafts[i];
    const result = await syncDraft(draftId, apiKey!, dryRun, verbose);

    if (result.status === "synced") {
      syncedCount++;
    } else if (result.status === "skipped") {
      skippedCount++;
    } else {
      failedCount++;
    }

    // Rate limit between requests (not after the last one)
    if (i < drafts.length - 1 && !dryRun && result.status === "synced") {
      await sleep(RATE_LIMIT_MS);
    }
  }

  // Summary
  if (verbose) {
    console.log("[sync-sheets] Complete");
    if (syncedCount > 0) {
      console.log(`  Synced: ${syncedCount}`);
    }
    if (skippedCount > 0) {
      console.log(`  Skipped: ${skippedCount} (complete)`);
    }
    if (failedCount > 0) {
      console.log(`  Failed: ${failedCount}`);
    }

    if (syncedCount > 0 && !dryRun) {
      console.log("\nRun 'pnpm dev' or 'pnpm build' to regenerate draft data.");
    }
  }
}

main().catch((error) => {
  console.error("[sync-sheets] Fatal error:", error);
  process.exit(1);
});
