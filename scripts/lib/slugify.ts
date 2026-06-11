/**
 * Convert a draft name to a URL/database-safe slug (draft_id).
 *
 * This is the canonical implementation used across all scripts that create or
 * look up drafts by name. It must not change — existing draft IDs in the database
 * are derived from this function and must continue to resolve correctly.
 *
 * Examples:
 *   "Tarkir Rotisserie" → "tarkir-rotisserie"
 *   "Draft #3 (Modern)"  → "draft-3-modern"
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
