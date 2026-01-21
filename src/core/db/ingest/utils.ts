import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, "..", "..", "..", "..");

// ============================================================================
// Types
// ============================================================================

export interface DraftMetadata {
  name: string;
  date: string;
  sheetId?: string;
  status?: string;
  bans?: string[];
}

// ============================================================================
// Environment Setup
// ============================================================================

export function loadEnv(): void {
  dotenv.config({ path: join(PROJECT_ROOT, ".env.local") });
  dotenv.config({ path: join(PROJECT_ROOT, ".env") });
}

// ============================================================================
// Utilities
// ============================================================================

export function log(message: string): void {
  console.log(`[ingest] ${message}`);
}

export function logIndent(message: string): void {
  console.log(`  - ${message}`);
}

/**
 * Generate a stable oracle_id from a card name.
 *
 * NOTE: The Scryfall cache (cache/scryfall.json) does not contain the actual
 * Scryfall oracle_id field. Instead, we generate a deterministic ID based on
 * the card name. This means our oracle_id values are NOT compatible with
 * Scryfall's oracle_id values, but they serve the same purpose within our
 * system: providing a stable identifier for card equivalence across drafts.
 *
 * Format: "generated:<normalized-name>" where normalized-name is lowercase
 * with non-alphanumeric characters replaced by hyphens.
 */
export function generateOracleId(cardName: string): string {
  const normalized = cardName.toLowerCase().replace(/[^a-z0-9]/g, "-");
  return `generated:${normalized}`;
}

/**
 * Compute SHA256 hash of file contents.
 */
export function hashFile(filePath: string): string {
  if (!existsSync(filePath)) return "";
  const content = readFileSync(filePath, "utf-8");
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Compute import hash from picks.csv, pool.csv, and matches.csv.
 */
export function computeImportHash(draftPath: string): string {
  const picksHash = hashFile(join(draftPath, "picks.csv"));
  const poolHash = hashFile(join(draftPath, "pool.csv"));
  const matchesHash = hashFile(join(draftPath, "matches.csv"));
  const decklistsHash = hashFile(join(draftPath, "decklists.csv"));
  const metadataHash = hashFile(join(draftPath, "metadata.json"));
  const combined = `${picksHash}:${poolHash}:${matchesHash}:${decklistsHash}:${metadataHash}`;
  return createHash("sha256").update(combined).digest("hex").slice(0, 16);
}

/**
 * Compute cube hash from sorted card names.
 */
export function computeCubeHash(cardNames: string[]): string {
  const sorted = [...cardNames].sort();
  const combined = sorted.join("\n");
  return createHash("sha256").update(combined).digest("hex").slice(0, 16);
}
