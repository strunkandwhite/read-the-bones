/**
 * Shared opt-out name loading from .opt-outs.json.
 * Used by both ingest (to store opt-outs in DB) and local draft tools
 * (to redact opted-out players when reading CSVs directly).
 */

import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const OPT_OUTS_PATH = join(PROJECT_ROOT, ".opt-outs.json");

/**
 * Load opt-out player names from .opt-outs.json.
 * Returns a Set of lowercase names for case-insensitive matching.
 */
export function loadOptOutNames(): Set<string> {
  if (!existsSync(OPT_OUTS_PATH)) {
    return new Set();
  }

  try {
    const content = readFileSync(OPT_OUTS_PATH, "utf-8");
    const names = JSON.parse(content) as string[];
    return new Set(names.map((name) => name.toLowerCase()));
  } catch {
    return new Set();
  }
}

/**
 * Check if a drafter name matches any opt-out name.
 * @public Used by API routes for privacy filtering
 */
export function isOptedOut(drafterName: string, optOutNames: Set<string>): boolean {
  return optOutNames.has(drafterName.toLowerCase());
}
