/**
 * Generates /public/api/draft-data.json for client-side draft selection.
 * Run during build via prebuild script.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import type { CardPick, DraftDataFile, MatchResult } from "../src/core/types";
import { parseDraft, parsePool, isDraftComplete } from "../src/core/parseCsv";
import { parseMatches } from "../src/core/parseMatches";

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
  const matchResults: Record<string, MatchResult[]> = {};

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

      const { picks, numDrafters, drafterNames } = parseDraft(picksCsv, poolCsv, entry);
      const pool = parsePool(poolCsv);

      allPicks.push(...picks);
      pools[entry] = pool;
      metadata[entry] = loadDraftMetadata(entryPath, entry, numDrafters);

      // Load match data if available
      const matchesPath = join(entryPath, "matches.csv");
      if (existsSync(matchesPath)) {
        try {
          const matchesCsv = readFileSync(matchesPath, "utf-8");
          // Build playerNameToSeat map for match parsing
          const playerNameToSeat = new Map<string, number>();
          for (let seat = 0; seat < drafterNames.length; seat++) {
            const name = drafterNames[seat];
            playerNameToSeat.set(name, seat);
            playerNameToSeat.set(name.toLowerCase(), seat);
          }
          const matches = parseMatches(matchesCsv, playerNameToSeat);
          if (matches.length > 0) {
            matchResults[entry] = matches;
            console.log(`[generate-draft-data] Processed "${entry}": ${picks.length} picks, ${matches.length} matches`);
          } else {
            console.log(`[generate-draft-data] Processed "${entry}": ${picks.length} picks (no match data)`);
          }
        } catch (matchError) {
          console.warn(`[generate-draft-data] Failed to parse matches for "${entry}":`, matchError);
          console.log(`[generate-draft-data] Processed "${entry}": ${picks.length} picks (match parse failed)`);
        }
      } else {
        console.log(`[generate-draft-data] Processed "${entry}": ${picks.length} picks (no matches.csv)`);
      }
    } catch (error) {
      console.warn(`[generate-draft-data] Failed to process "${entry}":`, error);
    }
  }

  // Ensure output directory exists
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const draftData: DraftDataFile = { picks: allPicks, pools, metadata, matchResults };
  const outputPath = join(OUTPUT_DIR, OUTPUT_FILE);

  writeFileSync(outputPath, JSON.stringify(draftData));

  const sizeKb = (Buffer.byteLength(JSON.stringify(draftData)) / 1024).toFixed(1);
  console.log(`[generate-draft-data] Wrote ${outputPath} (${sizeKb} KB)`);
}

main();
