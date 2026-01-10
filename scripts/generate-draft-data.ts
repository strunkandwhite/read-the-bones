/**
 * Generates /public/api/draft-data.json for client-side draft selection.
 * Run during build via prebuild script.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import type { CardPick, DraftDataFile } from "../src/core/types";
import { parseDraft, parsePool, isDraftComplete } from "../src/core/parseCsv";

const DATA_DIR = "data";
const OUTPUT_DIR = "public/api";
const OUTPUT_FILE = "draft-data.json";

function loadDraftMetadata(
  draftPath: string,
  draftId: string,
  numDraftersFromParse?: number
): { name: string; date: string; numDrafters?: number } {
  const metadataPath = join(draftPath, "metadata.json");

  if (existsSync(metadataPath)) {
    try {
      const content = readFileSync(metadataPath, "utf-8");
      const data = JSON.parse(content);
      return {
        name: data.name || draftId,
        date: data.date || "1970-01-01",
        numDrafters: data.numDrafters || numDraftersFromParse,
      };
    } catch (error) {
      console.warn(`[generate-draft-data] Failed to parse metadata for "${draftId}":`, error);
    }
  }

  return { name: draftId, date: "1970-01-01", numDrafters: numDraftersFromParse };
}

function main() {
  const allPicks: CardPick[] = [];
  const pools: Record<string, string[]> = {};
  const metadata: Record<string, { name: string; date: string; numDrafters?: number }> = {};

  if (!existsSync(DATA_DIR)) {
    console.warn(`[generate-draft-data] Data directory not found: ${DATA_DIR}`);
    return;
  }

  const entries = readdirSync(DATA_DIR);

  for (const entry of entries) {
    const entryPath = join(DATA_DIR, entry);

    if (!statSync(entryPath).isDirectory()) continue;

    const picksPath = join(entryPath, "picks.csv");
    const poolPath = join(entryPath, "pool.csv");

    if (!existsSync(picksPath) || !existsSync(poolPath)) {
      console.warn(`[generate-draft-data] Skipping "${entry}": missing required files`);
      continue;
    }

    try {
      const picksCsv = readFileSync(picksPath, "utf-8");
      const poolCsv = readFileSync(poolPath, "utf-8");

      if (!isDraftComplete(picksCsv)) {
        console.warn(`[generate-draft-data] Skipping "${entry}": incomplete draft`);
        continue;
      }

      const { picks, numDrafters } = parseDraft(picksCsv, poolCsv, entry);
      const pool = parsePool(poolCsv);

      allPicks.push(...picks);
      pools[entry] = pool;
      metadata[entry] = loadDraftMetadata(entryPath, entry, numDrafters);

      console.log(`[generate-draft-data] Processed "${entry}": ${picks.length} picks`);
    } catch (error) {
      console.warn(`[generate-draft-data] Failed to process "${entry}":`, error);
    }
  }

  // Ensure output directory exists
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const draftData: DraftDataFile = { picks: allPicks, pools, metadata };
  const outputPath = join(OUTPUT_DIR, OUTPUT_FILE);

  writeFileSync(outputPath, JSON.stringify(draftData));

  const sizeKb = (Buffer.byteLength(JSON.stringify(draftData)) / 1024).toFixed(1);
  console.log(`[generate-draft-data] Wrote ${outputPath} (${sizeKb} KB)`);
}

main();
