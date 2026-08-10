/**
 * Shared opt-out name loading from .opt-outs.json, the sole input recording
 * which seats are excluded at ingest.
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
 *
 * An absent file means no opt-outs: that is the normal state of a checkout
 * without any, and the file is gitignored so it never reaches the serverless
 * environment. A file that exists but cannot be read as an array of names
 * throws instead, because this is the only input enforcing the opt-out
 * promise and an empty result is indistinguishable from success.
 */
export function loadOptOutNames(): Set<string> {
  if (!existsSync(OPT_OUTS_PATH)) {
    return new Set();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(OPT_OUTS_PATH, "utf-8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${OPT_OUTS_PATH}: ${detail}`);
  }

  if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== "string")) {
    throw new Error(
      `${OPT_OUTS_PATH} must be a JSON array of player names, e.g. ["Player One"]`,
    );
  }

  return new Set(parsed.map((name) => name.toLowerCase()));
}
