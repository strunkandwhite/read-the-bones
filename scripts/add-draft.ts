/**
 * Add a new draft from a Google Sheet URL.
 * Creates the draft folder, metadata, syncs sheet data, and ingests into Turso.
 *
 * Usage:
 *   pnpm add-draft --name "Tarkir Fate Reforged" "https://docs.google.com/spreadsheets/d/1Hk.../edit"
 *   pnpm add-draft --name "Innistrad" --date 2026-03-01 "https://docs.google.com/spreadsheets/d/1Hk.../edit"
 *   pnpm add-draft --name "Test Draft" --dry-run "https://docs.google.com/spreadsheets/d/1Hk.../edit"
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { parseSheetIdFromUrl } from "../src/build/sheets";

const DATA_DIR = "data";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let name: string | null = null;
  let date: string | null = null;
  let dryRun = false;
  let url: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--name" && i + 1 < args.length) {
      name = args[++i];
    } else if (arg === "--date" && i + 1 < args.length) {
      date = args[++i];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (!arg.startsWith("--")) {
      url = arg;
    }
  }

  return { name, date: date ?? todayIso(), dryRun, url };
}

function printUsage() {
  console.error(`Usage: pnpm add-draft --name "Draft Name" <google-sheets-url>`);
  console.error("");
  console.error("Options:");
  console.error("  --name <name>   Display name for the draft (required)");
  console.error("  --date <date>   Draft date in YYYY-MM-DD format (default: today)");
  console.error("  --dry-run       Show what would happen without writing");
}

function main() {
  const { name, date, dryRun, url } = parseArgs(process.argv);

  if (!name || !url) {
    printUsage();
    process.exit(1);
  }

  // Extract sheet ID from URL
  const sheetId = parseSheetIdFromUrl(url);
  if (!sheetId) {
    console.error(`[add-draft] Could not extract sheet ID from URL: ${url}`);
    process.exit(1);
  }

  const slug = slugify(name);
  const draftPath = join(DATA_DIR, slug);

  console.log(`[add-draft] Adding draft "${name}"`);
  console.log(`  Folder: ${draftPath}`);
  console.log(`  Sheet ID: ${sheetId}`);
  console.log(`  Date: ${date}`);

  // Check if folder already exists
  if (existsSync(draftPath)) {
    console.error(`[add-draft] Folder already exists: ${draftPath}`);
    console.error("  Use 'pnpm sync-sheets' to re-sync an existing draft.");
    process.exit(1);
  }

  if (dryRun) {
    console.log("\n[add-draft] Dry run — would create folder and metadata, then sync and ingest.");
    return;
  }

  // Create folder and metadata
  mkdirSync(draftPath, { recursive: true });

  const metadata = {
    name,
    date,
    sheetId,
    status: "in-progress" as const,
  };

  writeFileSync(
    join(draftPath, "metadata.json"),
    JSON.stringify(metadata, null, 2) + "\n",
    "utf-8"
  );
  console.log("  Created metadata.json");

  // Sync sheets
  console.log(`\n[add-draft] Syncing sheet data...`);
  try {
    execSync(`pnpm sync-sheets ${slug}`, { stdio: "inherit" });
  } catch {
    console.error("[add-draft] Sheet sync failed. Folder and metadata were created — you can retry with:");
    console.error(`  pnpm sync-sheets ${slug}`);
    process.exit(1);
  }

  // Ingest into database
  console.log(`\n[add-draft] Ingesting into database...`);
  try {
    execSync(`pnpm ingest ${slug}`, { stdio: "inherit" });
  } catch {
    console.error("[add-draft] Ingestion failed. Sheet data was synced — you can retry with:");
    console.error(`  pnpm ingest ${slug}`);
    process.exit(1);
  }

  console.log(`\n[add-draft] Done! Draft "${name}" is ready.`);
}

main();
