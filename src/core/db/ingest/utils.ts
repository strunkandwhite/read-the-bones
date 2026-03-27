import { join, dirname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, "..", "..", "..", "..");

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

export { hashPool as computeCubeHash } from "../sync/domains";
